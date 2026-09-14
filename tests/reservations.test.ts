import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddedDatabase } from '../scripts/embedded.js';
import { seedDemo } from '../scripts/fixtures.js';
import { accountBalance, ledgerAccount, postJournal } from '../src/financial/ledger.js';
import { markReleasePending, releaseReservation, reserve } from '../src/financial/reservations.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';

let db: Database;
let owner: string;

beforeAll(async () => {
  db = await embeddedDatabase();
  await migrate(db);
  owner = (await seedDemo(db)).trader!;
  await db.transaction(async sql => {
    const escrow = await ledgerAccount(sql, null, 'DEMO', 'escrow_asset');
    const available = await ledgerAccount(sql, owner, 'DEMO', 'user_available');
    await postJournal(sql, { effectId: 'reservation-test-funding', asset: 'DEMO', kind: 'deposit_finalized',
      referenceId: owner, reason: 'Fund isolated reservation tests', lines: [
        { account: escrow, debit: 1_000n, credit: 0n },
        { account: available, debit: 0n, credit: 1_000n },
      ] });
  });
});

afterAll(async () => { await db.close(); });

describe('collateral reservation lifecycle', () => {
  it('returns the original hold for an identical business reference', async () => {
    const first = await db.transaction(sql => reserve(sql, {
      owner, asset: 'DEMO', purpose: 'clob', reference: 'order-repeat', amount: '300',
    }));
    const repeated = await db.transaction(sql => reserve(sql, {
      owner, asset: 'DEMO', purpose: 'clob', reference: 'order-repeat', amount: '300',
    }));
    expect(repeated.id).toBe(first.id);
    expect((await db.query("SELECT count(*)::text AS count FROM collateral_reservations WHERE reference_id='order-repeat'")).rows[0])
      .toEqual({ count: '1' });
  });

  it('rejects reference reuse with different economic terms', async () => {
    await expect(db.transaction(sql => reserve(sql, {
      owner, asset: 'DEMO', purpose: 'clob', reference: 'order-repeat', amount: '301',
    }))).rejects.toMatchObject({ code: 'RESERVATION_CONFLICT' });
  });

  it('cannot reserve more finalized collateral than remains available', async () => {
    await expect(db.transaction(sql => reserve(sql, {
      owner, asset: 'DEMO', purpose: 'withdrawal', reference: 'oversized-withdrawal', amount: '701',
    }))).rejects.toMatchObject({ code: 'INSUFFICIENT_COLLATERAL' });
  });

  it('requires an explicit release fence and restores the exact held amount', async () => {
    const held = await db.transaction(sql => reserve(sql, {
      owner, asset: 'DEMO', purpose: 'withdrawal', reference: 'cancelled-withdrawal', amount: '200',
    }));
    await expect(db.transaction(sql => releaseReservation(sql, held.id, '200', 'early-release')))
      .rejects.toMatchObject({ code: 'RESERVATION_NOT_RELEASABLE' });
    await db.transaction(sql => markReleasePending(sql, held.id));
    await expect(db.transaction(sql => releaseReservation(sql, held.id, '201', 'over-release')))
      .rejects.toMatchObject({ code: 'RESERVATION_OVER_RELEASE' });
    const released = await db.transaction(sql => releaseReservation(sql, held.id, '200', 'verified-cancellation'));
    expect(released).toMatchObject({ state: 'released', released: '200' });
    const available = await ledgerAccount(db, owner, 'DEMO', 'user_available');
    const pending = await ledgerAccount(db, owner, 'DEMO', 'user_withdrawal_pending');
    expect(await accountBalance(db, available)).toBe(700n);
    expect(await accountBalance(db, pending)).toBe(0n);
  });
});
