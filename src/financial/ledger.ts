import { randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import { integer, validateJournal, type Posting } from './model.js';

export type Bucket = 'escrow_asset' | 'user_available' | 'user_reserved' |
  'user_withdrawal_pending' | 'protocol_fee' | 'reconciliation_suspense' | 'market_escrow';
export interface LedgerAccount {
  id: string; owner_id: string | null; asset_code: string; bucket: Bucket; normal_side: 'debit' | 'credit';
}
export interface JournalLine { account: LedgerAccount; debit: bigint; credit: bigint }

export async function ledgerAccount(sql: Sql, ownerId: string | null, asset: string, bucket: Bucket): Promise<LedgerAccount> {
  const existing = (await sql.query<LedgerAccount>(`SELECT * FROM ledger_accounts WHERE owner_id IS NOT DISTINCT FROM $1::uuid
    AND asset_code=$2 AND bucket=$3`, [ownerId, asset, bucket])).rows[0];
  if (existing) return existing;
  const side = bucket === 'escrow_asset' ? 'debit' : 'credit';
  const inserted = (await sql.query<LedgerAccount>(`INSERT INTO ledger_accounts(id,owner_id,asset_code,bucket,normal_side)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [randomUUID(), ownerId, asset, bucket, side])).rows[0];
  if (inserted) return inserted;
  const raced = (await sql.query<LedgerAccount>(`SELECT * FROM ledger_accounts WHERE owner_id IS NOT DISTINCT FROM $1::uuid
    AND asset_code=$2 AND bucket=$3`, [ownerId, asset, bucket])).rows[0];
  if (!raced) throw new Error('Ledger account creation failed');
  return raced;
}

export async function accountBalance(sql: Sql, account: LedgerAccount): Promise<bigint> {
  const row = (await sql.query<{ amount: string }>(`SELECT COALESCE(sum(CASE WHEN $2='debit' THEN debit-credit
    ELSE credit-debit END),0)::text AS amount FROM ledger_entries WHERE account_id=$1`,
    [account.id, account.normal_side])).rows[0];
  return BigInt(row?.amount ?? '0');
}

// All writers lock the same owner/asset key before reading balances and
// appending postings, including withdrawals and every execution route.
export async function lockOwnerAsset(sql: Sql, ownerId: string, asset: string) {
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${ownerId}:${asset}`]);
}

export async function postJournal(sql: Sql, input: {
  effectId: string; asset: string; kind: string; referenceId: string; reason: string; lines: JournalLine[];
}): Promise<string> {
  const asset = (await sql.query<{ approved: boolean }>(`SELECT approved FROM financial_assets WHERE code=$1 FOR SHARE`, [input.asset])).rows[0];
  requireCondition(asset?.approved, 422, 'ASSET_NOT_APPROVED', 'The collateral asset is not approved.');
  const postings: Posting[] = input.lines.map(line => ({ asset: line.account.asset_code, account: line.account.id,
    debit: line.debit, credit: line.credit }));
  validateJournal(postings);
  requireCondition(input.lines.every(line => line.account.asset_code === input.asset), 422,
    'ASSET_MISMATCH', 'Journal postings must use the same asset.');
  const existing = (await sql.query<{ id: string }>('SELECT id FROM ledger_journals WHERE effect_id=$1', [input.effectId])).rows[0];
  requireCondition(!existing, 409, 'EFFECT_ALREADY_POSTED', 'This economic effect has already been recorded.');
  const id = randomUUID();
  await sql.query(`INSERT INTO ledger_journals(id,effect_id,asset_code,kind,reference_id,reason)
    VALUES ($1,$2,$3,$4,$5,$6)`, [id, input.effectId, input.asset, input.kind, input.referenceId, input.reason]);
  for (const line of input.lines) {
    const debit = integer(line.debit.toString()), credit = integer(line.credit.toString());
    const balance = await accountBalance(sql, line.account);
    const change = line.account.normal_side === 'debit' ? debit - credit : credit - debit;
    requireCondition(balance + change >= 0n, 409, 'INSUFFICIENT_COLLATERAL', 'The account has insufficient finalized collateral.');
    await sql.query('INSERT INTO ledger_entries(id,journal_id,account_id,debit,credit) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), id, line.account.id, debit.toString(), credit.toString()]);
  }
  return id;
}

export async function walletBalances(sql: Sql, ownerId: string) {
  const rows = (await sql.query<{ asset_code: string; bucket: string; amount: string }>(`
    SELECT a.asset_code,a.bucket,
      COALESCE(sum(CASE WHEN a.normal_side='debit' THEN e.debit-e.credit ELSE e.credit-e.debit END),0)::text AS amount
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
    WHERE a.owner_id=$1 GROUP BY a.asset_code,a.bucket ORDER BY a.asset_code,a.bucket`, [ownerId])).rows;
  const assets = new Map<string, { asset: string; available_minor: string; reserved_minor: string; withdrawal_pending_minor: string }>();
  for (const row of rows) {
    const balance = assets.get(row.asset_code) ?? { asset: row.asset_code, available_minor: '0', reserved_minor: '0', withdrawal_pending_minor: '0' };
    if (row.bucket === 'user_available') balance.available_minor = row.amount;
    else if (row.bucket === 'user_reserved') balance.reserved_minor = row.amount;
    else if (row.bucket === 'user_withdrawal_pending') balance.withdrawal_pending_minor = row.amount;
    assets.set(row.asset_code, balance);
  }
  return [...assets.values()];
}
