import { randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import { integer } from './model.js';
import { accountBalance, ledgerAccount, lockOwnerAsset, postJournal } from './ledger.js';

export type ReservationPurpose = 'clob' | 'amm' | 'rfq' | 'withdrawal';
interface ReservationRow {
  id: string; owner_id: string; asset_code: string; purpose: ReservationPurpose;
  reference_id: string; amount: string; consumed: string; released: string;
  state: 'held' | 'partially_consumed' | 'consumed' | 'release_pending' | 'released';
}

export async function reserve(sql: Sql, input: { owner: string; asset: string; purpose: ReservationPurpose;
  reference: string; amount: string }) {
  const amount = integer(input.amount);
  requireCondition(amount > 0n, 422, 'INVALID_AMOUNT', 'Reservation amount must be positive.');
  await lockOwnerAsset(sql, input.owner, input.asset);
  const existing = (await sql.query<ReservationRow>(`SELECT * FROM collateral_reservations
    WHERE purpose=$1 AND reference_id=$2`, [input.purpose, input.reference])).rows[0];
  if (existing) {
    requireCondition(existing.owner_id === input.owner && existing.asset_code === input.asset &&
      BigInt(existing.amount) === amount, 409, 'RESERVATION_CONFLICT', 'The reference already belongs to a different reservation.');
    return existing;
  }
  const available = await ledgerAccount(sql, input.owner, input.asset, 'user_available');
  const held = await ledgerAccount(sql, input.owner, input.asset,
    input.purpose === 'withdrawal' ? 'user_withdrawal_pending' : 'user_reserved');
  requireCondition(await accountBalance(sql, available) >= amount, 409, 'INSUFFICIENT_COLLATERAL', 'The account has insufficient finalized collateral.');
  const id = randomUUID();
  await postJournal(sql, { effectId: `reservation:${id}:held`, asset: input.asset,
    kind: input.purpose === 'withdrawal' ? 'withdrawal_held' : 'reservation_held', referenceId: id,
    reason: `Collateral reservation for ${input.purpose}`, lines: [
      { account: available, debit: amount, credit: 0n }, { account: held, debit: 0n, credit: amount },
    ] });
  return (await sql.query<ReservationRow>(`INSERT INTO collateral_reservations
    (id,owner_id,asset_code,purpose,reference_id,amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id,input.owner,input.asset,input.purpose,input.reference,amount.toString()])).rows[0]!;
}

export async function releaseReservation(sql: Sql, reservationId: string, amountString: string,
  releaseReference: string) {
  const amount = integer(amountString);
  requireCondition(amount > 0n, 422, 'INVALID_AMOUNT', 'Release amount must be positive.');
  const initial = (await sql.query<ReservationRow>('SELECT * FROM collateral_reservations WHERE id=$1', [reservationId])).rows[0];
  requireCondition(initial, 404, 'NOT_FOUND', 'Reservation not found.');
  await lockOwnerAsset(sql, initial.owner_id, initial.asset_code);
  const row = (await sql.query<ReservationRow>('SELECT * FROM collateral_reservations WHERE id=$1 FOR UPDATE', [reservationId])).rows[0]!;
  requireCondition(row.state === 'release_pending', 409, 'RESERVATION_NOT_RELEASABLE',
    'The financial workflow must prove pending effects are absent before release.');
  requireCondition(BigInt(row.consumed) + BigInt(row.released) + amount <= BigInt(row.amount),
    409, 'RESERVATION_OVER_RELEASE', 'Release would exceed the held amount.');
  const held = await ledgerAccount(sql, row.owner_id, row.asset_code,
    row.purpose === 'withdrawal' ? 'user_withdrawal_pending' : 'user_reserved');
  const available = await ledgerAccount(sql, row.owner_id, row.asset_code, 'user_available');
  await postJournal(sql, { effectId: `reservation:${reservationId}:release:${releaseReference}`,
    asset: row.asset_code, kind: 'reservation_released', referenceId: reservationId,
    reason: 'Verified release after pending financial effects were fenced', lines: [
      { account: held, debit: amount, credit: 0n }, { account: available, debit: 0n, credit: amount },
    ] });
  const nextReleased = BigInt(row.released) + amount;
  return (await sql.query<ReservationRow>(`UPDATE collateral_reservations SET released=$2,
    state=CASE WHEN consumed+($2::numeric)=amount THEN 'released' ELSE 'release_pending' END,
    updated_at=now() WHERE id=$1 RETURNING *`, [reservationId,nextReleased.toString()])).rows[0]!;
}

export async function markReleasePending(sql: Sql, reservationId: string) {
  const row = (await sql.query<ReservationRow>('SELECT * FROM collateral_reservations WHERE id=$1 FOR UPDATE', [reservationId])).rows[0];
  requireCondition(row, 404, 'NOT_FOUND', 'Reservation not found.');
  requireCondition(['held','partially_consumed'].includes(row.state), 409, 'RESERVATION_NOT_RELEASABLE', 'Reservation is not held.');
  await sql.query("UPDATE collateral_reservations SET state='release_pending',updated_at=now() WHERE id=$1", [reservationId]);
}
