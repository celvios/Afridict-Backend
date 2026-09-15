import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {accountBalance,ledgerAccount,postJournal} from '../src/financial/ledger.js';
import {createConversionQuote,executeConversionQuote,fundConversionInventory,publishConversionRate} from '../src/funding/conversion.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,trader:string,finance:string;
const usdtUnit=10n**18n;
const farFuture=new Date('2099-01-01T00:00:00.000Z');

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);trader=ids.trader!;finance=ids.finance!;
  await db.query("UPDATE eligibility SET status='eligible',policy_version='demo:eligible' WHERE account_id=$1",[trader]);
  await db.query("UPDATE financial_assets SET synthetic=true,approved=true,evidence_ref='synthetic-conversion-test' WHERE code='USDT_BSC'");
  await db.query("UPDATE token_asset_registry SET approved=true,evidence_ref='synthetic-conversion-test' WHERE asset_code='USDT_BSC'");
  await db.transaction(async sql=>{
    const custody=await ledgerAccount(sql,null,'NGN','escrow_asset'),available=await ledgerAccount(sql,trader,'NGN','user_available');
    await postJournal(sql,{effectId:'conversion-user-opening',asset:'NGN',kind:'financial_correction',referenceId:'synthetic-fixture',
      reason:'Synthetic conversion test balance',lines:[{account:custody,debit:10_000_000n,credit:0n},{account:available,debit:0n,credit:10_000_000n}]});
    await fundConversionInventory(sql,finance,{asset:'USDT_BSC',amountMinor:(1000n*usdtUnit).toString(),
      evidenceRef:'synthetic-custody:test',reason:'Synthetic inventory fixture'},'inventory-usdt');
    await fundConversionInventory(sql,finance,{asset:'NGN',amountMinor:'100000000',
      evidenceRef:'synthetic-bank:test',reason:'Synthetic inventory fixture'},'inventory-ngn');
    await publishConversionRate(sql,finance,{sourceAsset:'NGN',destinationAsset:'USDT_BSC',rateNumerator:usdtUnit.toString(),
      rateDenominator:'160000',feeBps:100,minimumSourceMinor:'20000',sourceRef:'synthetic-rate:ngn-usdt',
      expiresAt:farFuture,reason:'Synthetic rate fixture'},'rate-ngn-usdt');
    await publishConversionRate(sql,finance,{sourceAsset:'USDT_BSC',destinationAsset:'NGN',rateNumerator:'160000',
      rateDenominator:usdtUnit.toString(),feeBps:100,minimumSourceMinor:usdtUnit.toString(),sourceRef:'synthetic-rate:usdt-ngn',
      expiresAt:farFuture,reason:'Synthetic rate fixture'},'rate-usdt-ngn');
  });
  app=await buildApp(db,demoConfig,demoAuth);
});
afterAll(async()=>{await app.close();await db.close();});

describe('ring-fenced NGN and USDT wallet conversion',()=>{
  it('quotes exact integer terms and executes two balanced asset journals atomically',async()=>{
    const now=new Date('2026-09-15T10:00:00.000Z');
    const quote=await db.transaction(sql=>createConversionQuote(sql,trader,{sourceAsset:'NGN',destinationAsset:'USDT_BSC',
      sourceAmountMinor:'160000'},now));
    expect(quote).toMatchObject({source_amount_minor:'160000',fee_minor:'1600',destination_amount_minor:'990000000000000000',
      state:'quoted',executed_at:null});
    const executed=await db.transaction(sql=>executeConversionQuote(sql,trader,quote.id,'execute-exact',new Date(now.getTime()+1000)));
    expect(executed).toMatchObject({state:'executed',trade_id:expect.any(String)});
    expect(await accountBalance(db,await ledgerAccount(db,trader,'NGN','user_available'))).toBe(9_840_000n);
    expect(await accountBalance(db,await ledgerAccount(db,trader,'USDT_BSC','user_available'))).toBe(990_000_000_000_000_000n);
    const journals=(await db.query<{asset_code:string;count:string}>(`SELECT asset_code,count(*)::text AS count FROM ledger_journals
      WHERE reference_id=$1 GROUP BY asset_code ORDER BY asset_code`,[executed.trade_id])).rows;
    expect(journals).toEqual([{asset_code:'NGN',count:'1'},{asset_code:'USDT_BSC',count:'1'}]);
    await expect(db.query("UPDATE wallet_conversion_quotes SET source_amount_minor=1 WHERE id=$1",[quote.id])).rejects.toThrow();
  });

  it('rejects expired quotes without moving either asset',async()=>{
    const now=new Date('2026-09-15T11:00:00.000Z'),quote=await db.transaction(sql=>createConversionQuote(sql,trader,
      {sourceAsset:'NGN',destinationAsset:'USDT_BSC',sourceAmountMinor:'20000'},now));
    const before=await accountBalance(db,await ledgerAccount(db,trader,'NGN','user_available'));
    await expect(db.transaction(sql=>executeConversionQuote(sql,trader,quote.id,'expired',new Date(now.getTime()+30_001))))
      .rejects.toMatchObject({code:'CONVERSION_QUOTE_EXPIRED'});
    expect(await accountBalance(db,await ledgerAccount(db,trader,'NGN','user_available'))).toBe(before);
    expect((await db.query<{state:string}>('SELECT state FROM wallet_conversion_quotes WHERE id=$1',[quote.id])).rows[0]!.state).toBe('quoted');
  });

  it('rolls back when destination inventory cannot satisfy the quote',async()=>{
    await db.transaction(async sql=>{const custody=await ledgerAccount(sql,null,'NGN','escrow_asset');
      const available=await ledgerAccount(sql,trader,'NGN','user_available');await postJournal(sql,{effectId:'large-conversion-source',
        asset:'NGN',kind:'financial_correction',referenceId:'synthetic-fixture',reason:'Synthetic inventory-shortfall fixture',
        lines:[{account:custody,debit:200_000_000n,credit:0n},{account:available,debit:0n,credit:200_000_000n}]});});
    const now=new Date('2026-09-15T11:30:00.000Z'),quote=await db.transaction(sql=>createConversionQuote(sql,trader,
      {sourceAsset:'NGN',destinationAsset:'USDT_BSC',sourceAmountMinor:'200000000'},now));
    const before=await accountBalance(db,await ledgerAccount(db,trader,'NGN','user_available'));
    await expect(db.transaction(sql=>executeConversionQuote(sql,trader,quote.id,'inventory-shortfall',new Date(now.getTime()+1000))))
      .rejects.toMatchObject({code:'CONVERSION_INVENTORY_UNAVAILABLE'});
    expect(await accountBalance(db,await ledgerAccount(db,trader,'NGN','user_available'))).toBe(before);
    expect((await db.query<{count:string}>('SELECT count(*)::text AS count FROM wallet_conversion_trades WHERE quote_id=$1',[quote.id])).rows[0]!.count).toBe('0');
  });

  it('serializes concurrent acceptance and records one economic effect',async()=>{
    const now=new Date('2026-09-15T12:00:00.000Z'),quote=await db.transaction(sql=>createConversionQuote(sql,trader,
      {sourceAsset:'NGN',destinationAsset:'USDT_BSC',sourceAmountMinor:'320000'},now));
    const attempts=await Promise.allSettled([
      db.transaction(sql=>executeConversionQuote(sql,trader,quote.id,'concurrent-one',new Date(now.getTime()+1000))),
      db.transaction(sql=>executeConversionQuote(sql,trader,quote.id,'concurrent-two',new Date(now.getTime()+1000))),
    ]);
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect((await db.query<{count:string}>('SELECT count(*)::text AS count FROM wallet_conversion_trades WHERE quote_id=$1',[quote.id])).rows[0]!.count).toBe('1');
  });

  it('exposes idempotent, frontend-ready quote and acceptance contracts',async()=>{
    const headers={authorization:'Bearer demo.trader','idempotency-key':'api-conversion-quote'};
    const request={method:'POST' as const,url:'/v1/wallet-conversion/quotes',headers,
      payload:{source_asset:'NGN',destination_asset:'USDT_BSC',source_amount_minor:'20000'}};
    const [created,replayed]=await Promise.all([app.inject(request),app.inject(request)]);
    expect(created.statusCode,created.body).toBe(201);expect(replayed.json()).toEqual(created.json());
    expect(created.json()).toMatchObject({fee_minor:'200',destination_amount_minor:'123750000000000000',state:'quoted'});
    const accepted=await app.inject({method:'POST',url:`/v1/wallet-conversion/quotes/${created.json().id}/accept`,
      headers:{authorization:'Bearer demo.trader','idempotency-key':'api-conversion-accept'},payload:{}});
    expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json()).toMatchObject({state:'executed',trade_id:expect.any(String)});
    const read=await app.inject({method:'GET',url:`/v1/wallet-conversion/quotes/${created.json().id}`,
      headers:{authorization:'Bearer demo.trader'}});expect(read.json()).toEqual(accepted.json());
  });
});
