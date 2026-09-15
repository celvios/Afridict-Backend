import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo,terms} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {ledgerAccount,postJournal} from '../src/financial/ledger.js';
import {hash} from '../src/platform/commands.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,marketId:string;
let ids:Record<string,string>;
const headers=(who:string,key?:string)=>({authorization:`Bearer demo.${who}`,...(key?{'idempotency-key':key}:{})});
const post=(who:string,url:string,body:unknown,key:string)=>app.inject({method:'POST',url,headers:headers(who,key),payload:body as object});

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);ids=await seedDemo(db);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=$1",[ids.trader]);
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES('demo:collateral','DEMO',true,'synthetic-test-only')`);
  const policy=terms(),now=Date.now();
  policy.open_at=new Date(now-60_000).toISOString();policy.trading_cutoff=new Date(now+3_600_000).toISOString();
  policy.expected_event_at=new Date(now+7_200_000).toISOString();policy.resolution_deadline=new Date(now+86_400_000).toISOString();
  policy.liquidity={...policy.liquidity,amm_enabled:true,inventory_limit_minor:'20',subsidy_limit_minor:'10000000',
    loss_limit_minor:'8000000',max_slippage_bps:500};
  marketId=randomUUID();
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES($1,$2,'scheduled',$3,$4,now())`,[marketId,ids.creator,JSON.stringify(policy),hash(policy)]);
  const custody=await ledgerAccount(db,null,'DEMO','escrow_asset');
  const available=await ledgerAccount(db,ids.trader!,'DEMO','user_available');
  await db.transaction(sql=>postJournal(sql,{effectId:'amm-api-user-funding',asset:'DEMO',kind:'deposit_finalized',
    referenceId:ids.trader!,reason:'Synthetic AMM API fixture',lines:[
      {account:custody,debit:10_000_000n,credit:0n},{account:available,debit:0n,credit:10_000_000n},
    ]}));
  app=await buildApp(db,demoConfig,demoAuth);
});
afterAll(async()=>{if(app)await app.close();if(db)await db.close();});

describe('bounded AMM API',()=>{
  it('enforces governance and exposes an idempotent quote execution journey',async()=>{
    expect((await post('approver',`/v1/admin/markets/${marketId}/trading/activate`,{asset_code:'DEMO'},'activate-clob')).statusCode).toBe(200);
    const denied=await post('trader',`/v1/admin/markets/${marketId}/amm/yes/activate`,
      {asset_code:'DEMO',impact_bps:100},'denied-activation');
    expect(denied.statusCode).toBe(403);
    const activated=await post('approver',`/v1/admin/markets/${marketId}/amm/yes/activate`,
      {asset_code:'DEMO',impact_bps:100},'activate-amm');
    expect(activated.statusCode,activated.body).toBe(200);
    expect(activated.json()).toMatchObject({market_id:marketId,outcome_id:'yes',status:'open'});
    expect((await post('finance',`/v1/admin/markets/${marketId}/amm/yes/funding`,
      {amount_minor:'8000000'},'fund-amm')).statusCode).toBe(200);
    const now=Date.now();
    const reference=await post('approver',`/v1/admin/markets/${marketId}/amm/yes/reference-prices`,{
      price:'500000',observed_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60_000).toISOString(),
      source_ref:'approved-feed:api-1'},'reference-price');
    expect(reference.statusCode,reference.body).toBe(201);
    const quote=await post('trader',`/v1/markets/${marketId}/amm/yes/quotes`,{
      side:'buy',quantity:'2',limit_price:'600000'},'create-quote');
    expect(quote.statusCode,quote.body).toBe(201);
    expect(quote.json()).toMatchObject({state:'quoted',price:'500500',user_total:'1011010'});
    const executed=await post('trader',`/v1/amm/quotes/${quote.json().id}/execute`,{},'execute-quote');
    expect(executed.statusCode,executed.body).toBe(200);
    expect(executed.json().state).toBe('executed');
    expect((await post('trader',`/v1/amm/quotes/${quote.json().id}/execute`,{},'execute-quote')).body).toBe(executed.body);
    expect((await post('proposer',`/v1/amm/quotes/${quote.json().id}/execute`,{},'foreign-execute')).statusCode).toBe(404);
    const quotes=await app.inject({method:'GET',url:`/v1/markets/${marketId}/amm/quotes`,headers:headers('trader')});
    expect(quotes.json().items).toMatchObject([{id:quote.json().id,state:'executed'}]);
    const positions=await app.inject({method:'GET',url:`/v1/markets/${marketId}/positions`,headers:headers('trader')});
    expect(positions.json().items).toMatchObject([{outcome_id:'yes',side:'buy',quantity:'2',collateral_minor:'1001000'}]);
    const events=await app.inject({method:'GET',url:`/v1/markets/${marketId}/trading/events?after=0`});
    expect(events.json().items.some((event:{event_type:string})=>event.event_type==='amm_execution')).toBe(true);
  });
});
