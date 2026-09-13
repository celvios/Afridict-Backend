import type {Sql} from '../platform/database.js';
import {record} from '../platform/commands.js';
import {requireCondition} from '../platform/errors.js';
import {createWithdrawal,publicWithdrawal} from './service.js';

export interface TokenAssetRow {asset_code:string;symbol:string;chain_id:string;contract_address:string;decimals:number}
export const publicTokenAsset=(row:TokenAssetRow)=>({code:row.asset_code,symbol:row.symbol,chain_id:row.chain_id,
  contract_address:row.contract_address,decimals:row.decimals,withdrawal_mode:'manual_finance_review' as const});
export async function createCryptoWithdrawal(sql:Sql,input:{owner:string;asset:string;amount:string;destination:string},requestId:string){
  requireCondition(/^0x[a-fA-F0-9]{40}$/.test(input.destination)&&!/^0x0{40}$/i.test(input.destination),422,'INVALID_WALLET_ADDRESS','A non-zero EVM wallet address is required.');
  const token=(await sql.query<TokenAssetRow>(`SELECT asset_code,symbol,chain_id::text,contract_address,decimals FROM token_asset_registry
    WHERE asset_code=$1 AND approved=true FOR SHARE`,[input.asset])).rows[0];
  requireCondition(token,422,'TOKEN_NOT_APPROVED','The token contract and network are not approved.');
  const normalized=input.destination.toLowerCase(),withdrawal=await createWithdrawal(sql,{owner:input.owner,asset:input.asset,
    amount:input.amount,destination:normalized,rail:'manual_bep20'},requestId);
  await sql.query(`INSERT INTO manual_crypto_withdrawals(withdrawal_id,token_contract,chain_id) VALUES ($1,$2,$3)`,
    [withdrawal.id,token.contract_address,token.chain_id]);return withdrawal;
}
export async function listCryptoWithdrawals(sql:Sql,owner:string){
  const rows=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`SELECT w.* FROM withdrawals w JOIN manual_crypto_withdrawals c ON c.withdrawal_id=w.id
    WHERE w.owner_id=$1 ORDER BY w.created_at DESC LIMIT 100`,[owner])).rows;return rows.map(publicWithdrawal);
}
export async function listCryptoReviews(sql:Sql,state:string){
  const rows=(await sql.query<Parameters<typeof publicWithdrawal>[0]&{symbol:string;chain_id:string;token_contract:string;approved_by:string|null;
    approved_at:Date|null;transaction_hash:string|null}>(`SELECT w.*,t.symbol,c.chain_id::text,c.token_contract,c.approved_by,c.approved_at,c.transaction_hash
    FROM withdrawals w JOIN manual_crypto_withdrawals c ON c.withdrawal_id=w.id JOIN token_asset_registry t ON t.asset_code=w.asset_code
    WHERE w.state=$1 ORDER BY w.created_at ASC LIMIT 100`,[state])).rows;
  return rows.map(row=>({...publicWithdrawal(row),symbol:row.symbol,chain_id:row.chain_id,token_contract:row.token_contract,
    approved_by:row.approved_by,approved_at:row.approved_at?new Date(row.approved_at).toISOString():null,transaction_hash:row.transaction_hash}));
}
export async function approveCryptoWithdrawal(sql:Sql,id:string,admin:string,reason:string,requestId:string){
  const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`UPDATE withdrawals SET state='approved',updated_at=now()
    WHERE id=$1 AND rail='manual_bep20' AND state='reserved' RETURNING *`,[id])).rows[0];
  requireCondition(row,409,'WITHDRAWAL_NOT_REVIEWABLE','The crypto withdrawal is not awaiting review.');
  await sql.query('UPDATE manual_crypto_withdrawals SET approved_by=$2,approved_at=now() WHERE withdrawal_id=$1',[id,admin]);
  await record(sql,{actor:admin,authority:'finance_operator',action:'crypto_withdrawal.approved',resource:id,request:requestId,reason,
    before:{state:'reserved'},after:{state:'approved'}});return publicWithdrawal(row);
}
export async function recordCryptoSubmission(sql:Sql,id:string,admin:string,transactionHash:string,requestId:string){
  requireCondition(/^0x[a-fA-F0-9]{64}$/.test(transactionHash),422,'INVALID_TRANSACTION_HASH','A 32-byte transaction hash is required.');
  const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`UPDATE withdrawals SET state='submitted',provider_reference=$2,updated_at=now()
    WHERE id=$1 AND rail='manual_bep20' AND state='approved' RETURNING *`,[id,transactionHash.toLowerCase()])).rows[0];
  requireCondition(row,409,'WITHDRAWAL_NOT_APPROVED','The crypto withdrawal must be approved before recording a transfer.');
  await sql.query('UPDATE manual_crypto_withdrawals SET transaction_hash=$2,submitted_at=now() WHERE withdrawal_id=$1',[id,transactionHash.toLowerCase()]);
  await record(sql,{actor:admin,authority:'finance_operator',action:'crypto_withdrawal.submitted',resource:id,request:requestId,
    reason:'Finance administrator recorded the company-wallet transaction hash',before:{state:'approved'},after:{state:'submitted',transaction_hash:transactionHash.toLowerCase()}});
  return publicWithdrawal(row);
}
