import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth,demoConfig,seedDemo,terms } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { hash } from '../src/platform/commands.js';
import { ledgerAccount,accountBalance,postJournal } from '../src/financial/ledger.js';
import { migrate } from '../src/platform/migrations.js';
import { postgres,type Database } from '../src/platform/database.js';
import type { MarketTerms } from '../src/contracts.js';

let db:Database,app:FastifyInstance,schema:string|undefined;
let identities:Record<string,string>,clockNow=new Date(),key=0;
let resolutionMarket:{id:string;policy:MarketTerms},resolutionEvidenceId:string;
const headers=(who:string)=>({authorization:`Bearer demo.${who}`});
const post=(who:string,url:string,payload:unknown,once?:string)=>app.inject({method:'POST',url,
  headers:{...headers(who),'idempotency-key':once??`resolution-key-${++key}`},
  payload:payload as Record<string,unknown>});
const get=(who:string,url:string)=>app.inject({method:'GET',url,headers:headers(who)});
const balance=async(who:string,bucket:'user_available'|'user_reserved')=>
  accountBalance(db,await ledgerAccount(db,identities[who]!,'DEMO',bucket));
const evidence=(marketId:string,who:string,digest:string)=>post(who,
  `/v1/admin/markets/${marketId}/resolution/evidence`,{
    source_name:'Synthetic primary source',source_uri:'https://example.com/synthetic/primary',
    artifact_ref:`archive:synthetic-${digest.slice(0,8)}`,document_sha256:digest,
    observed_at:new Date(clockNow.getTime()-60_000).toISOString(),
  });

async function createMarket(type:'binary'|'categorical'='binary'){
  const policy=terms(type),now=Date.now(),id=randomUUID();
  policy.open_at=new Date(now-60_000).toISOString();
  policy.trading_cutoff=new Date(now+3600_000).toISOString();
  policy.expected_event_at=new Date(now+7200_000).toISOString();
  policy.resolution_deadline=new Date(now+86400_000).toISOString();
  policy.resolution.challenge_window_seconds=60;
  policy.resolution.timelock_seconds=60;
  policy.risk.exposure_limit_minor='100000000';
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES ($1,$2,'scheduled',$3,$4,now())`,[id,identities.creator,JSON.stringify(policy),hash(policy)]);
  expect((await post('approver',`/v1/admin/markets/${id}/trading/activate`,{asset_code:'DEMO'})).statusCode).toBe(200);
  return {id,policy};
}
async function trade(marketId:string,outcome:string,quantity='2'){
  const sell=await post('proposer',`/v1/markets/${marketId}/orders`,{
    outcome_id:outcome,side:'sell',limit_price:'600000',quantity});
  expect(sell.statusCode,sell.body).toBe(201);
  const buy=await post('trader',`/v1/markets/${marketId}/orders`,{
    outcome_id:outcome,side:'buy',limit_price:'600000',quantity});
  expect(buy.statusCode,buy.body).toBe(201);
  expect(buy.json().fills).toHaveLength(1);
}
async function close(marketId:string,policy:MarketTerms){
  clockNow=new Date(Date.parse(policy.expected_event_at)+60_000);
  const result=await post('approver',`/v1/admin/markets/${marketId}/resolution/close-book`,{});
  expect(result.statusCode,result.body).toBe(200);
  expect(result.json().remaining).toBe('0');
}
async function vote(marketId:string,who:string,decision:'proposal'|'challenge'|'recuse',evidenceId:string){
  return post(who,`/v1/admin/markets/${marketId}/resolution/ballots`,{
    decision,reason:'Synthetic evidence assessment',evidence_id:evidenceId,
  });
}

beforeAll(async()=>{
  const testUrl=process.env.TEST_DATABASE_URL;
  if(testUrl){
    if(new URL(testUrl).pathname!=='/afridict_test')throw new Error('Refusing a non-test database');
    schema=`resolution_test_${randomUUID().replaceAll('-','')}`;
    const admin=postgres(testUrl);
    try{await admin.query(`CREATE SCHEMA ${schema}`);}finally{await admin.close();}
    const scoped=new URL(testUrl);scoped.searchParams.set('options',`-csearch_path=${schema}`);
    db=postgres(scoped.toString());
  }else db=await embeddedDatabase();
  await migrate(db);identities=await seedDemo(db);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=ANY($1::uuid[])",
    [[identities.trader,identities.proposer]]);
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES ('demo:collateral','DEMO',true,'synthetic-demo-only')`);
  await db.query(`INSERT INTO resolution_policy_bindings
    (bond_policy_ref,payout_policy_ref,asset_code,bond_minor,invalid_payout,approved,evidence_ref)
    VALUES ('demo:bond-v1','demo:payout-v1','DEMO',1000,'refund_recorded_collateral',true,'synthetic-demo-only')`);
  for(const who of ['trader','proposer','resolution_proposer','resolution_challenger']){
    const escrow=await ledgerAccount(db,null,'DEMO','escrow_asset');
    const available=await ledgerAccount(db,identities[who]!,'DEMO','user_available');
    await db.transaction(sql=>postJournal(sql,{effectId:`resolution-fixture:${who}`,asset:'DEMO',
      kind:'deposit_finalized',referenceId:'synthetic-resolution-test',reason:'Synthetic resolution fixture',lines:[
        {account:escrow,debit:10_000_000n,credit:0n},{account:available,debit:0n,credit:10_000_000n},
      ]}));
  }
  app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,undefined,undefined,()=>clockNow);
});
afterAll(async()=>{
  if(app)await app.close();if(db)await db.close();
  if(schema){const admin=postgres(process.env.TEST_DATABASE_URL!);
    try{await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.close();}}
});

describe('governed synthetic resolution and exactly-once redemption',()=>{
  it('closes unmatched orders, archives source hashes and rejects premature proposal',async()=>{
    const market=await createMarket();
    await trade(market.id,'yes');
    const unmatched=await post('trader',`/v1/markets/${market.id}/orders`,{
      outcome_id:'no',side:'buy',limit_price:'500000',quantity:'1'});
    expect(unmatched.statusCode,unmatched.body).toBe(201);
    const early=await post('approver',`/v1/admin/markets/${market.id}/resolution/close-book`,{});
    expect(early.json().code).toBe('TRADING_WINDOW_OPEN');
    await close(market.id,market.policy);
    expect((await get('trader',`/v1/markets/${market.id}/orders`)).json().items[0]).toMatchObject({state:'cancelled'});
    const archived=await evidence(market.id,'resolution_proposer','a'.repeat(64));
    expect(archived.statusCode,archived.body).toBe(201);
    expect(archived.json().record_hash).toMatch(/^[a-f0-9]{64}$/);
    resolutionEvidenceId=archived.json().id;
    const duplicate=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/evidence`,{
      source_name:'Synthetic primary source',source_uri:'https://example.com/synthetic/primary',
      artifact_ref:'archive:synthetic-aaaaaaaa',document_sha256:'a'.repeat(64),
      observed_at:new Date(clockNow.getTime()-60_000).toISOString(),
    });
    expect(duplicate.json().code).toBe('EVIDENCE_ALREADY_ARCHIVED');
    await expect(db.query('DELETE FROM resolution_evidence WHERE id=$1',[archived.json().id])).rejects.toThrow();
    const foreign=await post('resolution_challenger',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Wrong proposer'},
    );
    expect(foreign.json().code).toBe('EVIDENCE_REQUIRED');
    const proposed=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Observed result'},'first-proposal');
    expect(proposed.statusCode,proposed.body).toBe(201);
    expect(proposed.json()).toMatchObject({state:'proposed',proposal:{kind:'outcome',outcome_id:'yes'}});
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Observed result'},'first-proposal')).body).toBe(proposed.body);
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'yes'},evidence_id:archived.json().id,reason:'Another proposal'})).json().code)
      .toBe('RESOLUTION_ALREADY_PROPOSED');
    const until=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,{reason:'Too early'});
    expect(until.json().code).toBe('RESOLUTION_TIMELOCK');
    expect(await balance('resolution_proposer','user_reserved')).toBe(1000n);
    resolutionMarket=market;
  });

  it('requires a complete independent quorum, then redeems each fill once',async()=>{
    const market=resolutionMarket;
    expect((await vote(market.id,'resolution_proposer','proposal',resolutionEvidenceId)).statusCode).toBe(403);
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).json().code).toBe('CHALLENGE_WINDOW_OPEN');
    clockNow=new Date(clockNow.getTime()+61_000);
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+180_000);
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Incomplete panel'})).json().code).toBe('PANEL_INCOMPLETE');
    for(const who of ['resolution_judge_two','resolution_judge_three']){
      expect((await vote(market.id,who,'proposal',resolutionEvidenceId)).statusCode).toBe(201);
    }
    expect((await vote(market.id,'resolution','proposal',resolutionEvidenceId)).json().code).toBe('PANEL_COMPLETE');
    const finalized=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Independent quorum selected documented result'});
    expect(finalized.statusCode,finalized.body).toBe(200);
    expect(finalized.json()).toMatchObject({state:'finalized',final_result:{kind:'outcome',outcome_id:'yes'}});
    expect((await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Duplicate finalization'})).json().code).toBe('RESOLUTION_STATE_CONFLICT');
    expect(await balance('resolution_proposer','user_reserved')).toBe(0n);
    const escrow=await ledgerAccount(db,null,'DEMO','market_escrow');
    expect(await accountBalance(db,escrow)).toBe(2_000_000n);
    const before=await balance('trader','user_available');
    const [one,two]=await Promise.all([
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'first-redemption'),
      post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},'second-redemption'),
    ]);
    expect(one.statusCode,one.body).toBe(200);
    expect(two.statusCode,two.body).toBe(200);
    expect([one.json().fill_count,two.json().fill_count].sort()).toEqual([0,1]);
    const paid=one.json().fill_count===1?one:two;
    const paidKey=one.json().fill_count===1?'first-redemption':'second-redemption';
    expect(paid.json()).toMatchObject({fill_count:1,paid_minor:'2000000',remaining:'0'});
    expect(await balance('trader','user_available')).toBe(before+2_000_000n);
    expect(await accountBalance(db,escrow)).toBe(0n);
    const replay=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{},paidKey);
    expect(replay.body).toBe(paid.body);
    const empty=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(empty.json()).toMatchObject({fill_count:0,paid_minor:'0',remaining:'0'});
    expect((await get('trader',`/v1/markets/${market.id}/redemptions`)).json().items).toMatchObject([
      {amount_minor:'2000000'},
    ]);
    expect((await get('trader',`/v1/markets/${market.id}/positions`)).json().items).toEqual([]);
    const record=(await db.query<{fill_id:string}>('SELECT fill_id FROM resolution_redemptions LIMIT 1')).rows[0]!;
    await expect(db.query('DELETE FROM resolution_redemptions WHERE fill_id=$1',[record.fill_id])).rejects.toThrow();
    await expect(db.query("UPDATE resolution_cases SET final_result='{}'::jsonb WHERE market_id=$1",
      [market.id])).rejects.toThrow();
  });

  it('adjudicates a challenged categorical result with separated roles',async()=>{
    clockNow=new Date();
    const market=await createMarket('categorical');
    await trade(market.id,'dry','1');
    await close(market.id,market.policy);
    const proposalEvidence=await evidence(market.id,'resolution_proposer','b'.repeat(64));
    const challengeEvidence=await evidence(market.id,'resolution_challenger','c'.repeat(64));
    const proposed=await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'outcome',outcome_id:'dry'},evidence_id:proposalEvidence.json().id,reason:'Initial edition'});
    expect(proposed.statusCode,proposed.body).toBe(201);
    const challenge=await post('resolution_challenger',`/v1/admin/markets/${market.id}/resolution/challenge`,{
      result:{kind:'outcome',outcome_id:'normal'},evidence_id:challengeEvidence.json().id,reason:'Corrected edition'});
    expect(challenge.statusCode,challenge.body).toBe(200);
    expect(challenge.json().state).toBe('challenged');
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/challenge`,{
      result:{kind:'outcome',outcome_id:'wet'},evidence_id:proposalEvidence.json().id,reason:'Self challenge'})).statusCode).toBe(409);
    for(const [who,decision] of [['resolution','challenge'],['resolution_judge_two','challenge'],
      ['resolution_judge_three','recuse']] as const){
      expect((await vote(market.id,who,decision,challengeEvidence.json().id)).statusCode).toBe(201);
    }
    clockNow=new Date(clockNow.getTime()+180_000);
    const final=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Challenge achieved published quorum'});
    expect(final.statusCode,final.body).toBe(200);
    expect(final.json().final_result).toMatchObject({kind:'outcome',outcome_id:'normal'});
    expect(await balance('resolution_challenger','user_reserved')).toBe(0n);
    const paid=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(paid.json()).toMatchObject({fill_count:1,paid_minor:'1000000',remaining:'0'});
    expect((await get('proposer',`/v1/markets/${market.id}/redemptions`)).json().items[0]).toMatchObject({amount_minor:'1000000'});
  });

  it('returns recorded matched collateral for an invalid result without minting value',async()=>{
    clockNow=new Date();
    const market=await createMarket();
    const buyerBefore=await balance('trader','user_available');
    const sellerBefore=await balance('proposer','user_available');
    await trade(market.id,'yes','1');
    await close(market.id,market.policy);
    const proof=await evidence(market.id,'resolution_proposer','d'.repeat(64));
    expect((await post('resolution_proposer',`/v1/admin/markets/${market.id}/resolution/proposal`,{
      result:{kind:'invalid'},evidence_id:proof.json().id,reason:'No valid observation'})).statusCode).toBe(201);
    clockNow=new Date(clockNow.getTime()+61_000);
    for(const who of ['resolution','resolution_judge_two','resolution_judge_three']){
      expect((await vote(market.id,who,'proposal',proof.json().id)).statusCode).toBe(201);
    }
    clockNow=new Date(clockNow.getTime()+120_000);
    const final=await post('resolution_finalizer',`/v1/admin/markets/${market.id}/resolution/finalize`,
      {reason:'Invalid outcome achieved published quorum'});
    expect(final.statusCode,final.body).toBe(200);
    expect(final.json().final_result).toEqual({kind:'invalid'});
    const settled=await post('finance',`/v1/admin/markets/${market.id}/resolution/redeem-batch`,{});
    expect(settled.json()).toMatchObject({fill_count:1,paid_minor:'1000000',remaining:'0'});
    expect(await balance('trader','user_available')).toBe(buyerBefore-6_000n);
    expect(await balance('proposer','user_available')).toBe(sellerBefore-4_000n);
  });
});
