import { randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import { record } from '../platform/commands.js';

export interface ReconciliationSnapshot {
  id: string; asset: string; status: 'balanced' | 'exceptions_opened';
  escrow_ledger_minor: string; chain_net_minor: string; partner_deposits_minor: string;
  finalized_deposits_minor: string; user_claims_minor: string; market_collateral_minor: string;
  liquidity_reserve_minor: string; protocol_fee_minor: string; exceptions: string[]; created_at: string;
}

// This reconciler is deliberately narrow: it proves deposits and withdrawals
// represented by this service agree with its append-only chain observations.
// A future independent chain scanner and partner statement adapter must supply
// external totals before production activation.
export async function reconcile(sql: Sql, asset: string, actor: string, requestId: string): Promise<ReconciliationSnapshot> {
  const approved=(await sql.query<{approved:boolean}>('SELECT approved FROM financial_assets WHERE code=$1 FOR SHARE',[asset])).rows[0];
  requireCondition(approved?.approved,422,'ASSET_NOT_APPROVED','The collateral asset is not approved.');
  const totals=(await sql.query<{escrow:string;claims:string;market_collateral:string;liquidity_reserve:string;protocol_fee:string;
    chain_deposits:string;chain_withdrawals:string;partner:string;posted:string;
    pending_partner:string;unmatched_observations:string}>(`
    SELECT
      (SELECT COALESCE(sum(e.debit-e.credit),0)::text FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id WHERE a.asset_code=$1 AND a.bucket='escrow_asset') AS escrow,
      (SELECT COALESCE(sum(e.credit-e.debit),0)::text FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id WHERE a.asset_code=$1 AND a.bucket LIKE 'user_%') AS claims,
      (SELECT COALESCE(sum(e.credit-e.debit),0)::text FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id WHERE a.asset_code=$1 AND a.bucket='market_escrow') AS market_collateral,
      (SELECT COALESCE(sum(e.credit-e.debit),0)::text FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id WHERE a.asset_code=$1 AND a.bucket='liquidity_reserve') AS liquidity_reserve,
      (SELECT COALESCE(sum(e.credit-e.debit),0)::text FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id WHERE a.asset_code=$1 AND a.bucket='protocol_fee') AS protocol_fee,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM chain_observations WHERE asset_code=$1 AND event_type='deposit_finalized') AS chain_deposits,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM chain_observations WHERE asset_code=$1 AND event_type='withdrawal_finalized') AS chain_withdrawals,
      (SELECT COALESCE(sum(partner_minor),0)::text FROM deposit_intents WHERE asset_code=$1
       AND state IN ('partner_confirmed','reconciled_available')) AS partner,
      (SELECT COALESCE(sum(target_minor),0)::text FROM deposit_intents WHERE asset_code=$1
       AND state='reconciled_available') AS posted,
      (SELECT count(*)::text FROM deposit_intents WHERE asset_code=$1 AND state='partner_confirmed') AS pending_partner,
      (SELECT count(*)::text FROM chain_observations o WHERE o.asset_code=$1 AND NOT EXISTS
       (SELECT 1 FROM deposit_intents d WHERE d.chain_observation_id=o.id)
       AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.chain_observation_id=o.id)) AS unmatched_observations`,[asset])).rows[0]!;
  const chainNet=(BigInt(totals.chain_deposits)-BigInt(totals.chain_withdrawals)).toString();
  const breaks:string[]=[];
  if (BigInt(totals.escrow)!==BigInt(chainNet)) breaks.push('LEDGER_CHAIN_MISMATCH');
  if (BigInt(totals.claims)+BigInt(totals.market_collateral)+BigInt(totals.liquidity_reserve)+BigInt(totals.protocol_fee)
    !==BigInt(totals.escrow)) breaks.push('CLAIMS_COLLATERAL_MISMATCH');
  if (BigInt(totals.posted)!==BigInt(totals.chain_deposits)) breaks.push('DEPOSIT_POSTING_MISMATCH');
  if (BigInt(totals.partner)<BigInt(totals.posted)) breaks.push('PARTNER_SHORTFALL');
  if (BigInt(totals.pending_partner)>0n) breaks.push('PARTNER_DEPOSIT_PENDING_CHAIN');
  if (BigInt(totals.unmatched_observations)>0n) breaks.push('UNMATCHED_CHAIN_OBSERVATION');
  const id=randomUUID();
  for (const code of breaks) await sql.query(`INSERT INTO financial_exceptions
    (id,scope,reference_id,asset_code,severity,owner_ref,details_code)
    VALUES ($1,'asset_reconciliation',$2,$3,'material','finance_operations',$4)
    ON CONFLICT (scope,reference_id,details_code) DO NOTHING`,[randomUUID(),asset,asset,code]);
  await sql.query(`INSERT INTO reconciliation_runs
    (id,requested_by,asset_code,status,escrow_ledger_minor,chain_net_minor,partner_deposits_minor,
      finalized_deposits_minor,user_claims_minor,market_collateral_minor,liquidity_reserve_minor,protocol_fee_minor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,actor,asset,breaks.length?'exceptions_opened':'balanced',totals.escrow,
    chainNet,totals.partner,totals.posted,totals.claims,totals.market_collateral,totals.liquidity_reserve,totals.protocol_fee]);
  const snapshot:ReconciliationSnapshot={id,asset,status:breaks.length?'exceptions_opened':'balanced',
    escrow_ledger_minor:totals.escrow,chain_net_minor:chainNet,partner_deposits_minor:totals.partner,
    finalized_deposits_minor:totals.posted,user_claims_minor:totals.claims,
    market_collateral_minor:totals.market_collateral,liquidity_reserve_minor:totals.liquidity_reserve,
    protocol_fee_minor:totals.protocol_fee,
    exceptions:breaks,created_at:new Date().toISOString()};
  await record(sql,{actor,authority:'finance_operator',action:'financial.reconciled',resource:id,
    request:requestId,reason:'Financial integrity check',after:snapshot,result:snapshot.status});
  return snapshot;
}
