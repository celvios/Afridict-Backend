import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddedDatabase } from '../scripts/embedded.js';
import { seedDemo, terms } from '../scripts/fixtures.js';
import { accountBalance, ledgerAccount, postJournal } from '../src/financial/ledger.js';
import type { Account } from '../src/identity/auth.js';
import { activateAmm, createAmmQuote, executeAmmQuote, fundAmm, recordAmmReference } from '../src/liquidity/amm-service.js';
import { hash } from '../src/platform/commands.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';

let db: Database;
let marketId: string;
let trader: Account;
let approver: Account;
let finance: Account;

beforeAll(async () => {
  db = await embeddedDatabase();
  await migrate(db);
  const ids = await seedDemo(db);
  const accounts = await Promise.all(['trader', 'approver', 'finance'].map(async name =>
    (await db.query<Account>('SELECT * FROM accounts WHERE id=$1', [ids[name]])).rows[0]!));
  trader = accounts[0]!; approver = accounts[1]!; finance = accounts[2]!;
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=$1", [trader.id]);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES ('demo:collateral','DEMO',true,'synthetic-only')`);
  const policy = terms();
  policy.open_at = new Date(Date.now()-60_000).toISOString();
  policy.trading_cutoff = new Date(Date.now()+60*60_000).toISOString();
  policy.expected_event_at = new Date(Date.now()+2*60*60_000).toISOString();
  policy.resolution_deadline = new Date(Date.now()+24*60*60_000).toISOString();
  policy.liquidity = { ...policy.liquidity, amm_enabled: true, subsidy_limit_minor: '10000000',
    inventory_limit_minor: '20', loss_limit_minor: '8000000', max_slippage_bps: 500 };
  marketId = randomUUID();
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES($1,$2,'scheduled',$3,$4,now())`, [marketId, ids.creator, JSON.stringify(policy), hash(policy)]);
  await db.query(`INSERT INTO clob_markets(market_id,asset_code,status,activated_by)
    VALUES($1,'DEMO','open',$2)`,[marketId,approver.id]);
  await db.transaction(sql => activateAmm(sql, approver, marketId, 'yes', 100));
  await db.transaction(sql => fundAmm(sql, finance, marketId, 'yes', '8000000', 'initial-funding'));
  await db.transaction(async sql => {
    const custody = await ledgerAccount(sql, null, 'DEMO', 'escrow_asset');
    const available = await ledgerAccount(sql, trader.id, 'DEMO', 'user_available');
    await postJournal(sql, { effectId: 'amm-user-funding', asset: 'DEMO', kind: 'deposit_finalized',
      referenceId: trader.id, reason: 'Synthetic AMM user funding', lines: [
        { account: custody, debit: 10_000_000n, credit: 0n }, { account: available, debit: 0n, credit: 10_000_000n },
      ] });
  });
});
afterAll(async () => { await db.close(); });

describe('bounded synthetic AMM workflow', () => {
  it('uses only fresh append-only reference prices', async () => {
    const now = new Date();
    await expect(db.transaction(sql => recordAmmReference(sql, approver, { marketId, outcomeId: 'yes', price: '500000',
      observedAt: new Date(now.getTime() - 20_000), expiresAt: new Date(now.getTime() - 1), sourceRef: 'expired' })))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE_PRICE' });
    const reference = await db.transaction(sql => recordAmmReference(sql, approver, { marketId, outcomeId: 'yes',
      price: '500000', observedAt: now, expiresAt: new Date(now.getTime() + 60_000), sourceRef: 'approved-feed:1' }));
    await expect(db.query('UPDATE amm_reference_prices SET price=1 WHERE id=$1', [reference.id])).rejects.toThrow();
  });

  it('quotes and atomically executes against user and treasury collateral', async () => {
    const quote = await db.transaction(sql => createAmmQuote(sql, trader, { marketId, outcomeId: 'yes', side: 'buy',
      quantity: '2', limitPrice: '600000' }));
    expect(quote).toMatchObject({ state: 'quoted', price: '500500', user_collateral: '1001000',
      amm_collateral: '999000', fee: '10010', user_total: '1011010' });
    const executed = await db.transaction(sql => executeAmmQuote(sql, trader, quote.id, 'execute-quote'));
    expect(executed.state).toBe('executed');
    expect(await accountBalance(db, await ledgerAccount(db, trader.id, 'DEMO', 'user_reserved'))).toBe(0n);
    expect(await accountBalance(db, await ledgerAccount(db, null, 'DEMO', 'liquidity_reserve'))).toBe(7_001_000n);
    expect(await accountBalance(db, await ledgerAccount(db, null, 'DEMO', 'market_escrow'))).toBe(2_000_000n);
    expect(await accountBalance(db, await ledgerAccount(db, null, 'DEMO', 'protocol_fee'))).toBe(10_010n);
    await expect(db.transaction(sql => executeAmmQuote(sql, trader, quote.id, 'repeat')))
      .rejects.toMatchObject({ code: 'AMM_QUOTE_TERMINAL' });
  });

  it('rejects stale quotes and rolls back every financial effect', async () => {
    const now = new Date();
    await db.transaction(sql => recordAmmReference(sql, approver, { marketId, outcomeId: 'yes', price: '450000',
      observedAt: now, expiresAt: new Date(now.getTime() + 5_000), sourceRef: 'approved-feed:2' }));
    const quote = await db.transaction(sql => createAmmQuote(sql, trader, { marketId, outcomeId: 'yes', side: 'sell',
      quantity: '1', limitPrice: '400000' }, now));
    const before = await accountBalance(db, await ledgerAccount(db, trader.id, 'DEMO', 'user_available'));
    await expect(db.transaction(sql => executeAmmQuote(sql, trader, quote.id, 'expired', new Date(now.getTime() + 20_000))))
      .rejects.toMatchObject({ code: 'AMM_QUOTE_EXPIRED' });
    expect(await accountBalance(db, await ledgerAccount(db, trader.id, 'DEMO', 'user_available'))).toBe(before);
    expect((await db.query<{state:string}>('SELECT state FROM amm_quotes WHERE id=$1', [quote.id])).rows[0]!.state).toBe('quoted');
  });

  it('serializes competing execution attempts without double-spending collateral',async()=>{
    const now=new Date();
    await db.transaction(sql=>recordAmmReference(sql,approver,{marketId,outcomeId:'yes',price:'500000',
      observedAt:now,expiresAt:new Date(now.getTime()+60_000),sourceRef:'approved-feed:concurrency'}));
    const quote=await db.transaction(sql=>createAmmQuote(sql,trader,{marketId,outcomeId:'yes',side:'buy',
      quantity:'1',limitPrice:'600000'},now));
    const escrow=await ledgerAccount(db,null,'DEMO','market_escrow');
    const before=await accountBalance(db,escrow);
    const attempts=await Promise.allSettled([
      db.transaction(sql=>executeAmmQuote(sql,trader,quote.id,'concurrent-one',new Date(now.getTime()+1000))),
      db.transaction(sql=>executeAmmQuote(sql,trader,quote.id,'concurrent-two',new Date(now.getTime()+1000))),
    ]);
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await accountBalance(db,escrow)).toBe(before+1_000_000n);
    expect((await db.query<{count:string}>(`SELECT count(*)::text AS count FROM ledger_journals
      WHERE effect_id=$1`,[`amm:${quote.id}:execution`])).rows[0]!.count).toBe('1');
  });
});
