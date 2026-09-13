import {createHmac,randomUUID} from 'node:crypto';
import type {Database,Sql} from '../platform/database.js';
import {integer} from '../financial/model.js';
import {hash,record} from '../platform/commands.js';
import {AppError,requireCondition} from '../platform/errors.js';
import {createWithdrawal,publicWithdrawal} from './service.js';
import type {FiatCurrency,FiatRailProvider} from './swervpay.js';

interface Row {intent_id:string;owner_id:string;asset_code:FiatCurrency;target_minor:string;state:string;provider_reference:string|null;
  account_name:string|null;account_number:string|null;bank_code:string|null;bank_name:string|null;expires_at:Date;created_at:Date;updated_at:Date}
const select=`SELECT r.*,d.owner_id,d.asset_code,d.target_minor,d.expires_at,d.created_at FROM fiat_collection_requests r
  JOIN deposit_intents d ON d.id=r.intent_id`;
export function publicFiatDeposit(row:Row) {return {id:row.intent_id,currency:row.asset_code,target_minor:row.target_minor,state:row.state,
  expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString(),
  instructions:row.state==='instructions_available'?{account_name:row.account_name!,account_number:row.account_number!,
    bank_code:row.bank_code!,bank_name:row.bank_name!,provider:'swervpay' as const}:null};}

export async function createFiatDeposit(sql:Sql,input:{owner:string;currency:FiatCurrency;targetMinor:string},requestId:string) {
  const amount=integer(input.targetMinor);requireCondition(amount>0n,422,'INVALID_AMOUNT','Deposit amount must be positive.');
  const rail=(await sql.query<{approved:boolean;collections_enabled:boolean}>(`SELECT r.approved,r.collections_enabled FROM fiat_rail_registry r
    JOIN financial_assets f ON f.code=r.asset_code WHERE r.provider='swervpay' AND r.asset_code=$1 AND f.approved=true FOR SHARE`,[input.currency])).rows[0];
  requireCondition(rail?.approved&&rail.collections_enabled,503,'FIAT_RAIL_NOT_APPROVED','The selected currency collection rail is not approved.');
  const id=randomUUID();
  await sql.query(`INSERT INTO deposit_intents(id,owner_id,asset_code,target_minor,rail,beneficiary_ref,expires_at)
    VALUES ($1,$2,$3,$4,'swervpay',$5,now()+interval '30 minutes')`,[id,input.owner,input.currency,amount.toString(),`fiat:pending:${id}`]);
  await sql.query("INSERT INTO fiat_collection_requests(intent_id,provider,state) VALUES ($1,'swervpay','instruction_pending')",[id]);
  const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1`,[id])).rows[0]!;
  await record(sql,{actor:input.owner,authority:'account_owner',action:'fiat.collection_requested',resource:id,request:requestId,
    reason:'Request provider deposit instructions',after:{currency:input.currency,target_minor:amount.toString(),state:row.state}});
  return publicFiatDeposit(row);
}

export async function getFiatDeposit(sql:Sql,owner:string,id:string) {
  const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1 AND d.owner_id=$2`,[id,owner])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Fiat deposit intent not found.');return publicFiatDeposit(row);
}

export async function processFiatCollection(db:Database,provider:FiatRailProvider,id:string) {
  const claim=await db.transaction(async sql=>{
    const row=(await sql.query<Row>(`${select} WHERE r.intent_id=$1 FOR UPDATE`,[id])).rows[0];requireCondition(row,404,'NOT_FOUND','Fiat deposit intent not found.');
    if(row.state==='instructions_available'||row.state==='instruction_uncertain')return {row,process:false};
    if(row.state==='instruction_creating'&&new Date(row.updated_at).getTime()<Date.now()-300_000){
      await sql.query("UPDATE fiat_collection_requests SET state='instruction_uncertain',updated_at=now() WHERE intent_id=$1",[id]);
      return {row:{...row,state:'instruction_uncertain'},process:false};
    }
    if(row.state==='instruction_creating')return {row,process:false};
    requireCondition(new Date(row.expires_at).getTime()>=Date.now(),409,'DEPOSIT_INTENT_EXPIRED','The deposit intent expired.');
    await sql.query("UPDATE fiat_collection_requests SET state='instruction_creating',attempt_count=1,updated_at=now() WHERE intent_id=$1",[id]);
    return {row,process:true};
  });
  if(!claim.process)return claim.row.state;
  try {
    const instruction=await provider.createCollection({currency:claim.row.asset_code,amountMinor:claim.row.target_minor,
      reference:id,merchantName:'Afridict'});
    requireCondition(instruction.reference===id&&instruction.currency===claim.row.asset_code,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','Provider collection identity does not match the request.');
    await db.transaction(async sql=>{await sql.query(`UPDATE fiat_collection_requests SET state='instructions_available',provider_reference=$2,
      account_name=$3,account_number=$4,bank_code=$5,bank_name=$6,updated_at=now() WHERE intent_id=$1 AND state='instruction_creating'`,
      [id,instruction.id,instruction.accountName,instruction.accountNumber,instruction.bankCode,instruction.bankName]);});
    return 'instructions_available';
  } catch(error) {
    await db.query("UPDATE fiat_collection_requests SET state='instruction_uncertain',updated_at=now() WHERE intent_id=$1 AND state='instruction_creating'",[id]);
    throw error;
  }
}

type PayoutInput={amountMinor:string;bankCode:string;accountNumber:string;narration:string};
export async function requestFiatPayout(db:Database,provider:FiatRailProvider,dataHashKey:string,actor:string,key:string,input:PayoutInput,requestId:string) {
  const bankAccountHash=createHmac('sha256',dataHashKey).update(`${input.bankCode}:${input.accountNumber}`).digest('hex');
  const fingerprint=hash({operation:'requestFiatPayout',amount_minor:input.amountMinor,narration:input.narration,bank_account_hash:bankAccountHash});
  const existing=await db.query<{request_hash:string;status_code:number|null;response:unknown;created_at:Date}>(
    'SELECT request_hash,status_code,response,created_at FROM command_results WHERE actor_id=$1 AND idempotency_key=$2',[actor,key]);
  if(existing.rows[0]){
    requireCondition(existing.rows[0].request_hash===fingerprint,409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for a different command.');
    if(existing.rows[0].status_code===202)return existing.rows[0].response;
    const id=(existing.rows[0].response as {id:string}).id;
    if(new Date(existing.rows[0].created_at).getTime()<Date.now()-300_000)await db.transaction(async sql=>{
      await sql.query("UPDATE withdrawals SET state='uncertain',updated_at=now() WHERE id=$1 AND state='submitting'",[id]);
      const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1',[id])).rows[0]!;
      await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',[actor,key,JSON.stringify(publicWithdrawal(row))]);});
    return (await db.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1',[id])).rows.map(publicWithdrawal)[0];
  }
  const resolved=await provider.resolveAccount({bankCode:input.bankCode,accountNumber:input.accountNumber});
  requireCondition(resolved.bankCode===input.bankCode&&resolved.accountNumber===input.accountNumber,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','The provider returned a different bank account.');
  const claimed=await db.transaction(async sql=>{
    await sql.query('INSERT INTO command_results(actor_id,idempotency_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[actor,key,fingerprint]);
    const command=(await sql.query<{request_hash:string;status_code:number|null;response:unknown}>(
      'SELECT request_hash,status_code,response FROM command_results WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actor,key])).rows[0]!;
    requireCondition(command.request_hash===fingerprint,409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for a different command.');
    if(command.status_code!==null)return {created:false,result:command.response};
    const rail=(await sql.query<{approved:boolean;payouts_enabled:boolean}>(`SELECT approved,payouts_enabled FROM fiat_rail_registry
      WHERE provider='swervpay' AND asset_code='NGN' FOR SHARE`)).rows[0];
    requireCondition(rail?.approved&&rail.payouts_enabled,503,'FIAT_RAIL_NOT_APPROVED','The NGN payout rail is not approved.');
    const digest=bankAccountHash.slice(0,16);
    const destination=`swervpay:${input.bankCode}:******${input.accountNumber.slice(-4)}:${digest}`;
    const withdrawal=await createWithdrawal(sql,{owner:actor,asset:'NGN',amount:input.amountMinor,destination,rail:'swervpay'},requestId);
    await sql.query("UPDATE withdrawals SET state='submitting',updated_at=now() WHERE id=$1",[withdrawal.id]);
    const result={...withdrawal,state:'submitting'};await sql.query('UPDATE command_results SET status_code=102,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',
      [actor,key,JSON.stringify(result)]);return {created:true,result};
  });
  if(!claimed.created)return claimed.result;
  const withdrawal=claimed.result as ReturnType<typeof publicWithdrawal>;
  try {
    const payout=await provider.createPayout({currency:'NGN',amountMinor:input.amountMinor,reference:withdrawal.id,
      bankCode:input.bankCode,accountNumber:input.accountNumber,narration:input.narration});
    requireCondition(payout.reference===withdrawal.id,502,'FIAT_PROVIDER_RESPONSE_MISMATCH','Provider payout identity does not match the request.');
    return await db.transaction(async sql=>{const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>(`UPDATE withdrawals SET state='submitted',
      provider_reference=$2,updated_at=now() WHERE id=$1 AND state='submitting' RETURNING *`,[withdrawal.id,payout.id])).rows[0];
      requireCondition(row,409,'PAYOUT_SUBMISSION_CONFLICT','The payout workflow changed during submission.');const result=publicWithdrawal(row);
      await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',[actor,key,JSON.stringify(result)]);return result;});
  }catch(error){
    if(error instanceof AppError&&error.statusCode<500)throw error;
    return await db.transaction(async sql=>{await sql.query("UPDATE withdrawals SET state='uncertain',updated_at=now() WHERE id=$1 AND state='submitting'",[withdrawal.id]);
      const row=(await sql.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1',[withdrawal.id])).rows[0]!,result=publicWithdrawal(row);
      await sql.query('UPDATE command_results SET status_code=202,response=$3 WHERE actor_id=$1 AND idempotency_key=$2',[actor,key,JSON.stringify(result)]);return result;});
  }
}
