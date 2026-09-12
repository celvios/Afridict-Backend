import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { canonical, record } from '../platform/commands.js';
import { requireCondition } from '../platform/errors.js';
import { integer } from '../financial/model.js';
import { ledgerAccount, lockOwnerAsset, postJournal } from '../financial/ledger.js';
import { markReleasePending, releaseReservation, reserve } from '../financial/reservations.js';

export interface PartnerVerifier {
  verify(input: { partnerId: string; eventId: string; timestamp: string; signature: string; payload: unknown }): Promise<boolean>;
}
export function hmacPartnerVerifier(secrets: ReadonlyMap<string,string>, toleranceSeconds = 300): PartnerVerifier {
  return { async verify({ partnerId,eventId,timestamp,signature,payload }) {
    const secret = secrets.get(partnerId), seconds = Number(timestamp);
    if (!secret || !Number.isInteger(seconds) || Math.abs(Date.now()/1000-seconds) > toleranceSeconds || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
    const expected = `sha256=${createHmac('sha256',secret).update(`${eventId}.${timestamp}.${canonical(payload)}`).digest('hex')}`;
    return timingSafeEqual(Buffer.from(expected),Buffer.from(signature));
  } };
}

interface DepositRow {
  id: string; owner_id: string; asset_code: string; target_minor: string; state: string;
  partner_id: string | null; partner_reference: string | null; partner_minor: string | null;
  chain_observation_id: string | null; expires_at: Date; created_at: Date; updated_at: Date;
}
interface WithdrawalRow {
  id: string; owner_id: string; reservation_id: string; asset_code: string; amount_minor: string;
  destination_ref: string; rail: string; state: string; provider_reference: string | null;
  chain_observation_id: string | null; created_at: Date; updated_at: Date;
}
export function publicDeposit(row: DepositRow) {
  return { id: row.id, asset: row.asset_code, target_minor: row.target_minor, state: row.state,
    expires_at: new Date(row.expires_at).toISOString(), created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(), funding_instructions_available:false as const };
}
export function publicWithdrawal(row: WithdrawalRow) {
  return { id: row.id, asset: row.asset_code, amount_minor: row.amount_minor, state: row.state,
    destination_ref: row.destination_ref, rail: row.rail, created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString() };
}

export async function createDepositIntent(sql: Sql, input: { owner: string; asset: string; target: string; rail: string }, requestId: string) {
  const amount = integer(input.target);
  requireCondition(amount > 0n,422,'INVALID_AMOUNT','Deposit amount must be positive.');
  const asset = (await sql.query<{ approved: boolean }>('SELECT approved FROM financial_assets WHERE code=$1 FOR SHARE',[input.asset])).rows[0];
  requireCondition(asset?.approved,422,'ASSET_NOT_APPROVED','The collateral asset is not approved.');
  const wallet = (await sql.query<{ status: string }>('SELECT status FROM smart_accounts WHERE owner_id=$1 FOR SHARE',[input.owner])).rows[0];
  requireCondition(wallet?.status === 'active',409,'SMART_ACCOUNT_NOT_ACTIVE','An active smart account is required.');
  // Partner quote/beneficiary creation is an adapter concern. This opaque local
  // reference cannot be used as payment instructions in a real environment.
  const id=randomUUID(), beneficiary=`intent:${id}`;
  const row=(await sql.query<DepositRow>(`INSERT INTO deposit_intents
    (id,owner_id,asset_code,target_minor,rail,beneficiary_ref,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes') RETURNING *`,
    [id,input.owner,input.asset,amount.toString(),input.rail,beneficiary])).rows[0]!;
  await record(sql,{actor:input.owner,authority:'account_owner',action:'deposit_intent.created',resource:id,
    request:requestId,reason:'Request collateral funding',after:publicDeposit(row)});
  return publicDeposit(row);
}

export async function applyPartnerDeposit(sql: Sql, input: { partnerId:string; eventId:string; occurredAt:string;
  intentId:string; reference:string; asset:string; amount:string }, requestId: string) {
  const amount=integer(input.amount), payloadHash=createHash('sha256').update(canonical(input)).digest('hex');
  const inserted=await sql.query(`INSERT INTO partner_events(partner_id,event_id,event_type,payload_hash,occurred_at)
    VALUES ($1,$2,'deposit.confirmed',$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
    [input.partnerId,input.eventId,payloadHash,input.occurredAt]);
  if (!inserted.rows.length) {
    const prior=(await sql.query<{payload_hash:string}>('SELECT payload_hash FROM partner_events WHERE partner_id=$1 AND event_id=$2',[input.partnerId,input.eventId])).rows[0];
    requireCondition(prior?.payload_hash===payloadHash,409,'PARTNER_EVENT_CONFLICT','The partner event identifier was reused with different content.');
    return false;
  }
  const row=(await sql.query<DepositRow>('SELECT * FROM deposit_intents WHERE id=$1 FOR UPDATE',[input.intentId])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Deposit intent not found.');
  requireCondition(new Date(row.expires_at).getTime() >= Date.now(),409,'DEPOSIT_INTENT_EXPIRED','The deposit intent expired.');
  requireCondition(row.state==='awaiting_partner',409,'VERSION_OR_STATE_CONFLICT','This deposit cannot accept a partner confirmation.');
  requireCondition(row.asset_code===input.asset && BigInt(row.target_minor)===amount,409,'DEPOSIT_MISMATCH','Partner amount or asset does not match the deposit intent.');
  await sql.query(`UPDATE deposit_intents SET state='partner_confirmed',partner_id=$2,partner_reference=$3,
    partner_minor=$4,updated_at=now() WHERE id=$1`,[row.id,input.partnerId,input.reference,amount.toString()]);
  await record(sql,{actor:`partner:${input.partnerId}`,authority:'verified_partner_webhook',action:'deposit.partner_confirmed',
    resource:row.id,request:requestId,reason:'Verified matching partner event',after:{state:'partner_confirmed',event_id:input.eventId}});
  return true;
}

export async function finalizeDeposit(sql: Sql, input: { intentId:string; chainId:number; blockNumber:string;
  blockHash:string; transactionHash:string; logIndex:number; accountAddress:string; asset:string; amount:string;
  finalityPolicyRef:string }, actor:string, requestId:string) {
  const amount=integer(input.amount);
  const finality=(await sql.query<{approved:boolean}>(`SELECT approved FROM policy_registry
    WHERE kind='finality' AND policy_ref=$1 FOR SHARE`,[input.finalityPolicyRef])).rows[0];
  requireCondition(finality?.approved,422,'POLICY_NOT_APPROVED','The chain finality policy is not approved.');
  const row=(await sql.query<DepositRow>('SELECT * FROM deposit_intents WHERE id=$1 FOR UPDATE',[input.intentId])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Deposit intent not found.');
  requireCondition(row.state==='partner_confirmed',409,'VERSION_OR_STATE_CONFLICT','Finalized chain collateral requires a matching partner confirmation.');
  requireCondition(row.asset_code===input.asset && BigInt(row.partner_minor ?? '-1')===amount,409,'DEPOSIT_MISMATCH','Finalized collateral does not match the partner-confirmed amount and asset.');
  const wallet=(await sql.query<{chain_id:string;address:string;status:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1 FOR SHARE',[row.owner_id])).rows[0];
  requireCondition(wallet?.status==='active' && BigInt(wallet.chain_id)===BigInt(input.chainId) && wallet.address===input.accountAddress,
    409,'SMART_ACCOUNT_MISMATCH','Finalized collateral was not observed for the active user smart account.');
  const observationId=randomUUID(), effectId=`deposit:${row.id}`;
  await sql.query(`INSERT INTO chain_observations(id,economic_effect_id,event_type,chain_id,block_number,block_hash,
    transaction_hash,log_index,account_address,asset_code,amount_minor,finality_policy_ref)
    VALUES ($1,$2,'deposit_finalized',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[observationId,effectId,input.chainId,
    input.blockNumber,input.blockHash,input.transactionHash,input.logIndex,input.accountAddress,input.asset,amount.toString(),input.finalityPolicyRef]);
  await lockOwnerAsset(sql,row.owner_id,row.asset_code);
  const escrow=await ledgerAccount(sql,null,row.asset_code,'escrow_asset');
  const available=await ledgerAccount(sql,row.owner_id,row.asset_code,'user_available');
  await postJournal(sql,{effectId,asset:row.asset_code,kind:'deposit_finalized',referenceId:row.id,
    reason:'Partner and finalized-chain deposit reconciled',lines:[
      {account:escrow,debit:amount,credit:0n},{account:available,debit:0n,credit:amount},
    ]});
  const updated=(await sql.query<DepositRow>(`UPDATE deposit_intents SET state='reconciled_available',
    chain_observation_id=$2,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,observationId])).rows[0]!;
  await record(sql,{actor,authority:'settlement_operator',action:'deposit.reconciled_available',resource:row.id,
    request:requestId,reason:'Trusted chain adapter reported configured finality',after:publicDeposit(updated)});
  return publicDeposit(updated);
}

export async function createWithdrawal(sql: Sql,input:{owner:string;asset:string;amount:string;destination:string;rail:string},requestId:string) {
  const eligibility=(await sql.query<{status:string}>('SELECT status FROM eligibility WHERE account_id=$1 FOR SHARE',[input.owner])).rows[0];
  requireCondition(eligibility?.status==='eligible',403,'ELIGIBILITY_REQUIRED','Approved eligibility is required for withdrawal.');
  const id=randomUUID();
  const reservation=await reserve(sql,{owner:input.owner,asset:input.asset,purpose:'withdrawal',reference:`withdrawal:${id}`,amount:input.amount});
  const row=(await sql.query<WithdrawalRow>(`INSERT INTO withdrawals
    (id,owner_id,reservation_id,asset_code,amount_minor,destination_ref,rail)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,input.owner,reservation.id,input.asset,input.amount,input.destination,input.rail])).rows[0]!;
  await record(sql,{actor:input.owner,authority:'account_owner',action:'withdrawal.reserved',resource:id,
    request:requestId,reason:'Request collateral withdrawal',after:publicWithdrawal(row)});
  return publicWithdrawal(row);
}

export async function cancelWithdrawal(sql: Sql, owner:string, withdrawalId:string, requestId:string) {
  const initial=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1',[withdrawalId])).rows[0];
  requireCondition(initial?.owner_id===owner,404,'NOT_FOUND','Withdrawal not found.');
  await lockOwnerAsset(sql,owner,initial.asset_code);
  const row=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId])).rows[0];
  requireCondition(row?.owner_id===owner,404,'NOT_FOUND','Withdrawal not found.');
  requireCondition(row.state==='reserved',409,'WITHDRAWAL_UNCERTAIN','Only a withdrawal that has never been submitted may be cancelled.');
  await markReleasePending(sql,row.reservation_id);
  await releaseReservation(sql,row.reservation_id,row.amount_minor,'user-cancel-before-submission');
  const updated=(await sql.query<WithdrawalRow>("UPDATE withdrawals SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0]!;
  await record(sql,{actor:owner,authority:'account_owner',action:'withdrawal.cancelled',resource:row.id,
    request:requestId,reason:'Cancelled before external submission',before:publicWithdrawal(row),after:publicWithdrawal(updated)});
  return publicWithdrawal(updated);
}

export async function submitWithdrawal(sql:Sql,withdrawalId:string,providerReference:string,actor:string,requestId:string) {
  const row=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Withdrawal not found.');
  requireCondition(row.state==='reserved',409,'VERSION_OR_STATE_CONFLICT','Only a reserved withdrawal may be submitted.');
  const updated=(await sql.query<WithdrawalRow>(`UPDATE withdrawals SET state='submitted',provider_reference=$2,
    updated_at=now() WHERE id=$1 RETURNING *`,[row.id,providerReference])).rows[0]!;
  await record(sql,{actor,authority:'funding_adapter',action:'withdrawal.submitted',resource:row.id,request:requestId,
    reason:'External submission accepted by configured adapter',before:publicWithdrawal(row),after:publicWithdrawal(updated)});
  return publicWithdrawal(updated);
}

export async function markWithdrawalUncertain(sql:Sql,withdrawalId:string,actor:string,requestId:string) {
  const row=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Withdrawal not found.');
  requireCondition(row.state==='submitted',409,'VERSION_OR_STATE_CONFLICT','Only a submitted withdrawal can become uncertain.');
  const updated=(await sql.query<WithdrawalRow>("UPDATE withdrawals SET state='uncertain',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0]!;
  await record(sql,{actor,authority:'funding_adapter',action:'withdrawal.uncertain',resource:row.id,request:requestId,
    reason:'External outcome is unknown; collateral remains reserved',before:publicWithdrawal(row),after:publicWithdrawal(updated),result:'uncertain'});
  return publicWithdrawal(updated);
}

export async function finalizeWithdrawal(sql:Sql,input:{withdrawalId:string;chainId:number;blockNumber:string;
  blockHash:string;transactionHash:string;logIndex:number;accountAddress:string;finalityPolicyRef:string},actor:string,requestId:string) {
  const finality=(await sql.query<{approved:boolean}>(`SELECT approved FROM policy_registry
    WHERE kind='finality' AND policy_ref=$1 FOR SHARE`,[input.finalityPolicyRef])).rows[0];
  requireCondition(finality?.approved,422,'POLICY_NOT_APPROVED','The chain finality policy is not approved.');
  const initial=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1',[input.withdrawalId])).rows[0];
  requireCondition(initial,404,'NOT_FOUND','Withdrawal not found.');
  await lockOwnerAsset(sql,initial.owner_id,initial.asset_code);
  const row=(await sql.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[input.withdrawalId])).rows[0]!;
  requireCondition(['submitted','uncertain'].includes(row.state),409,'VERSION_OR_STATE_CONFLICT','Withdrawal must have an external submission before finalization.');
  const wallet=(await sql.query<{chain_id:string;address:string;status:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1 FOR SHARE',[row.owner_id])).rows[0];
  requireCondition(wallet?.status==='active'&&BigInt(wallet.chain_id)===BigInt(input.chainId)&&wallet.address===input.accountAddress,
    409,'SMART_ACCOUNT_MISMATCH','Withdrawal finality does not match the active smart account.');
  const observationId=randomUUID(),effectId=`withdrawal:${row.id}`;
  await sql.query(`INSERT INTO chain_observations(id,economic_effect_id,event_type,chain_id,block_number,block_hash,
    transaction_hash,log_index,account_address,asset_code,amount_minor,finality_policy_ref)
    VALUES ($1,$2,'withdrawal_finalized',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[observationId,effectId,input.chainId,
    input.blockNumber,input.blockHash,input.transactionHash,input.logIndex,input.accountAddress,row.asset_code,row.amount_minor,input.finalityPolicyRef]);
  const pending=await ledgerAccount(sql,row.owner_id,row.asset_code,'user_withdrawal_pending');
  const escrow=await ledgerAccount(sql,null,row.asset_code,'escrow_asset');
  const amount=BigInt(row.amount_minor);
  await postJournal(sql,{effectId,asset:row.asset_code,kind:'withdrawal_finalized',referenceId:row.id,
    reason:'Withdrawal observed under configured finality policy',lines:[
      {account:pending,debit:amount,credit:0n},{account:escrow,debit:0n,credit:amount},
    ]});
  await sql.query(`UPDATE collateral_reservations SET consumed=amount,state='consumed',updated_at=now()
    WHERE id=$1`,[row.reservation_id]);
  const updated=(await sql.query<WithdrawalRow>(`UPDATE withdrawals SET state='finalized',chain_observation_id=$2,
    updated_at=now() WHERE id=$1 RETURNING *`,[row.id,observationId])).rows[0]!;
  await record(sql,{actor,authority:'settlement_operator',action:'withdrawal.finalized',resource:row.id,request:requestId,
    reason:'Trusted chain adapter reported configured finality',before:publicWithdrawal(row),after:publicWithdrawal(updated)});
  return publicWithdrawal(updated);
}
