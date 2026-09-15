import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo,terms} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {accountBalance,ledgerAccount,postJournal} from '../src/financial/ledger.js';
import {createWithdrawal} from '../src/funding/service.js';
import type {Account} from '../src/identity/auth.js';
import {acceptRfqQuote,rfqSigningPayload} from '../src/liquidity/rfq-service.js';
import {hash} from '../src/platform/commands.js';
import type {Database} from '../src/platform/database.js';
import {migrate} from '../src/platform/migrations.js';

let db:Database,app:FastifyInstance,ids:Record<string,string>,marketId:string;
let requesterEntity:string,dealerEntity:string;
const keyPair=generateKeyPairSync('ed25519');
const publicKey=keyPair.publicKey.export({format:'der',type:'spki'}).toString('base64');
let key=0;
const headers=(who:string,once?:string)=>({authorization:`Bearer demo.${who}`,...(once?{'idempotency-key':once}:{})});
const post=(who:string,url:string,body:unknown,once=`rfq-command-${++key}`)=>app.inject({method:'POST',url,
  headers:headers(who,once),payload:body as object});
const get=(who:string,url:string)=>app.inject({method:'GET',url,headers:headers(who)});

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);ids=await seedDemo(db);
  await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
  await db.query("UPDATE eligibility SET status='eligible' WHERE account_id=ANY($1::uuid[])",
    [[ids.trader,ids.proposer,ids.other_creator]]);
  await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
    VALUES('demo:collateral','DEMO',true,'synthetic-rfq-test')`);
  const policy=terms(),now=Date.now();
  policy.open_at=new Date(now-60_000).toISOString();policy.trading_cutoff=new Date(now+3_600_000).toISOString();
  policy.expected_event_at=new Date(now+7_200_000).toISOString();policy.resolution_deadline=new Date(now+86_400_000).toISOString();
  policy.risk.exposure_limit_minor='100000000';
  policy.liquidity={...policy.liquidity,amm_enabled:true,inventory_limit_minor:'20',
    subsidy_limit_minor:'10000000',loss_limit_minor:'8000000',max_slippage_bps:500};
  marketId=randomUUID();
  await db.query(`INSERT INTO markets(id,creator_id,state,terms,policy_hash,published_at)
    VALUES($1,$2,'scheduled',$3,$4,now())`,[marketId,ids.creator,JSON.stringify(policy),hash(policy)]);
  for(const who of ['trader','proposer']){
    const custody=await ledgerAccount(db,null,'DEMO','escrow_asset');
    const available=await ledgerAccount(db,ids[who]!,'DEMO','user_available');
    await db.transaction(sql=>postJournal(sql,{effectId:`rfq-fixture:${who}`,asset:'DEMO',kind:'deposit_finalized',
      referenceId:ids[who]!,reason:'Synthetic RFQ fixture',lines:[
        {account:custody,debit:5_000_000n,credit:0n},{account:available,debit:0n,credit:5_000_000n},
      ]}));
  }
  const custody=await ledgerAccount(db,null,'DEMO','escrow_asset');
  const available=await ledgerAccount(db,ids.other_creator!,'DEMO','user_available');
  await db.transaction(sql=>postJournal(sql,{effectId:'rfq-fixture:shared-owner',asset:'DEMO',kind:'deposit_finalized',
    referenceId:ids.other_creator!,reason:'Synthetic shared-control concurrency fixture',lines:[
      {account:custody,debit:600_000n,credit:0n},{account:available,debit:0n,credit:600_000n},
    ]}));
  app=await buildApp(db,demoConfig,demoAuth);
});
afterAll(async()=>{if(app)await app.close();if(db)await db.close();});

async function entity(name:string){
  const created=await post('compliance','/v1/admin/rfq/entities',{legal_name:name,exposure_limit_minor:'10000000'});
  expect(created.statusCode,created.body).toBe(201);
  expect((await post('compliance',`/v1/admin/rfq/entities/${created.json().id}/approve`,{})).statusCode).toBe(403);
  const approved=await post('other_compliance',`/v1/admin/rfq/entities/${created.json().id}/approve`,{});
  expect(approved.statusCode,approved.body).toBe(200);
  return created.json().id as string;
}
function signature(requestId:string,price:string,expiresAt:string,nonce:string){
  return sign(null,Buffer.from(rfqSigningPayload({requestId,price,expiresAt,nonce})),keyPair.privateKey).toString('base64');
}

describe('institutional RFQ API',()=>{
  it('onboards separated entities and authorizes requester and signed dealer accounts',async()=>{
    expect((await post('approver',`/v1/admin/markets/${marketId}/trading/activate`,{asset_code:'DEMO'})).statusCode).toBe(200);
    requesterEntity=await entity('Synthetic Requester Limited');dealerEntity=await entity('Synthetic Dealer Limited');
    expect((await post('other_compliance',`/v1/admin/rfq/entities/${requesterEntity}/members`,{
      account_id:ids.trader,role:'requester'})).statusCode).toBe(201);
    expect((await post('other_compliance',`/v1/admin/rfq/entities/${requesterEntity}/members`,{
      account_id:ids.other_creator,role:'requester'})).statusCode).toBe(201);
    const dealer=await post('other_compliance',`/v1/admin/rfq/entities/${dealerEntity}/members`,{
      account_id:ids.proposer,role:'dealer',signing_public_key:publicKey});
    expect(dealer.statusCode,dealer.body).toBe(201);
    expect(dealer.json().signing_key_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await get('compliance','/v1/admin/rfq/entities')).json().items).toHaveLength(2);
    expect((await get('compliance',`/v1/admin/rfq/entities/${dealerEntity}/members`)).json().items).toMatchObject([
      {account_id:ids.proposer,role:'dealer',signing_key_fingerprint:dealer.json().signing_key_fingerprint}]);
    await expect(db.query('UPDATE rfq_entities SET exposure_limit_minor=1 WHERE id=$1',[dealerEntity])).rejects.toThrow();
  });

  it('verifies signed quotes and executes only one competing acceptance',async()=>{
    const expiresAt=new Date(Date.now()+120_000).toISOString();
    const request=await post('trader',`/v1/markets/${marketId}/rfqs`,{entity_id:requesterEntity,
      outcome_id:'yes',side:'buy',quantity:'2',expires_at:expiresAt});
    expect(request.statusCode,request.body).toBe(201);
    expect((await get('proposer',`/v1/markets/${marketId}/rfqs`)).json().items).toMatchObject([{id:request.json().id}]);
    const quoteExpiry=new Date(Date.now()+60_000).toISOString();
    const invalid=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'550000',expires_at:quoteExpiry,nonce:'invalid-signature-1',signature:Buffer.alloc(64).toString('base64')});
    expect(invalid.statusCode).toBe(422);expect(invalid.json().code).toBe('INVALID_RFQ_SIGNATURE');
    const nonce='dealer-quote-0001';
    const quote=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'550000',expires_at:quoteExpiry,nonce,signature:signature(request.json().id,'550000',quoteExpiry,nonce)});
    expect(quote.statusCode,quote.body).toBe(201);
    expect(quote.json()).toMatchObject({state:'open',price:'550000',dealer_entity_id:dealerEntity});
    const replayedNonce=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'550000',expires_at:quoteExpiry,nonce,signature:signature(request.json().id,'550000',quoteExpiry,nonce)});
    expect(replayedNonce.statusCode).toBe(409);expect(replayedNonce.json().code).toBe('RFQ_NONCE_REUSED');
    const [first,second]=await Promise.all([
      post('trader',`/v1/rfqs/${request.json().id}/quotes/${quote.json().id}/accept`,{},'accept-rfq-one'),
      post('trader',`/v1/rfqs/${request.json().id}/quotes/${quote.json().id}/accept`,{},'accept-rfq-two')]);
    expect([first.statusCode,second.statusCode].sort()).toEqual([200,409]);
    const accepted=first.statusCode===200?first:second;
    expect(accepted.json()).toMatchObject({request_id:request.json().id,quote_id:quote.json().id,
      market_id:marketId,requester_side:'buy',price:'550000',quantity:'2'});
    const escrow=await ledgerAccount(db,null,'DEMO','market_escrow');
    expect(await accountBalance(db,escrow)).toBe(2_000_000n);
    expect((await db.query<{count:string}>("SELECT count(*)::text AS count FROM ledger_journals WHERE kind='rfq_execution'")).rows[0]!.count).toBe('1');
    expect((await get('trader',`/v1/markets/${marketId}/positions`)).json().items).toMatchObject([
      {outcome_id:'yes',side:'buy',quantity:'2',collateral_minor:'1100000',fees_minor:'11000'}]);
    expect((await get('proposer',`/v1/markets/${marketId}/positions`)).json().items).toMatchObject([
      {outcome_id:'yes',side:'sell',quantity:'2',collateral_minor:'900000',fees_minor:'9000'}]);
    expect((await get('trader',`/v1/markets/${marketId}/rfq-fills`)).json().items).toMatchObject([
      {id:accepted.json().id,request_id:request.json().id,quote_id:quote.json().id}]);
    expect((await get('trader',`/v1/rfqs/${request.json().id}/quotes`)).json().items[0]).toMatchObject({state:'accepted'});
    const events=(await app.inject({method:'GET',url:`/v1/markets/${marketId}/trading/events?after=0`})).json().items;
    expect(events.some((event:{event_type:string})=>event.event_type==='rfq_execution')).toBe(true);
  });

  it('rejects an expired quote without reserving either counterparty',async()=>{
    const expiresAt=new Date(Date.now()+120_000).toISOString();
    const request=await post('trader',`/v1/markets/${marketId}/rfqs`,{entity_id:requesterEntity,
      outcome_id:'no',side:'sell',quantity:'1',expires_at:expiresAt});
    const quoteExpiry=new Date(Date.now()+30_000).toISOString(),nonce='dealer-quote-expired';
    const quote=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'400000',expires_at:quoteExpiry,nonce,signature:signature(request.json().id,'400000',quoteExpiry,nonce)});
    const actor=(await db.query<Account>('SELECT * FROM accounts WHERE id=$1',[ids.trader])).rows[0]!;
    const before=(await db.query<{count:string}>("SELECT count(*)::text AS count FROM collateral_reservations WHERE purpose='rfq'")).rows[0]!.count;
    await expect(db.transaction(sql=>acceptRfqQuote(sql,actor,request.json().id,quote.json().id,'expired-attempt',
      new Date(Date.parse(quoteExpiry)+1)))).rejects.toMatchObject({code:'RFQ_QUOTE_NOT_OPEN'});
    expect((await db.query<{count:string}>("SELECT count(*)::text AS count FROM collateral_reservations WHERE purpose='rfq'")).rows[0]!.count).toBe(before);
  });

  it('serializes CLOB, AMM, RFQ and withdrawal admission for one shared balance',async()=>{
    expect((await post('approver',`/v1/admin/markets/${marketId}/amm/no/activate`,
      {asset_code:'DEMO',impact_bps:100})).statusCode).toBe(200);
    expect((await post('finance',`/v1/admin/markets/${marketId}/amm/no/funding`,
      {amount_minor:'8000000'})).statusCode).toBe(200);
    const observed=Date.now();
    expect((await post('approver',`/v1/admin/markets/${marketId}/amm/no/reference-prices`,{
      price:'500000',observed_at:new Date(observed-1000).toISOString(),expires_at:new Date(observed+60_000).toISOString(),
      source_ref:'approved-feed:rfq-concurrency'})).statusCode).toBe(201);
    const ammQuote=await post('other_creator',`/v1/markets/${marketId}/amm/no/quotes`,{
      side:'buy',quantity:'1',limit_price:'600000'});
    expect(ammQuote.statusCode,ammQuote.body).toBe(201);
    const requestExpiry=new Date(Date.now()+120_000).toISOString();
    const request=await post('other_creator',`/v1/markets/${marketId}/rfqs`,{entity_id:requesterEntity,
      outcome_id:'no',side:'buy',quantity:'1',expires_at:requestExpiry});
    const quoteExpiry=new Date(Date.now()+60_000).toISOString(),nonce='shared-control-quote';
    const quote=await post('proposer',`/v1/rfqs/${request.json().id}/quotes`,{dealer_entity_id:dealerEntity,
      price:'500000',expires_at:quoteExpiry,nonce,
      signature:signature(request.json().id,'500000',quoteExpiry,nonce)});
    const attempts=await Promise.allSettled([
      post('other_creator',`/v1/markets/${marketId}/orders`,{outcome_id:'no',side:'buy',limit_price:'500000',quantity:'1'},
        'shared-clob-admission'),
      post('other_creator',`/v1/amm/quotes/${ammQuote.json().id}/execute`,{},'shared-amm-admission'),
      post('other_creator',`/v1/rfqs/${request.json().id}/quotes/${quote.json().id}/accept`,{},'shared-rfq-admission'),
      db.transaction(sql=>createWithdrawal(sql,{owner:ids.other_creator!,asset:'DEMO',amount:'600000',
        destination:'synthetic:shared-control',rail:'synthetic'},'shared-withdrawal-admission')),
    ]);
    const apiSuccess=attempts.slice(0,3).filter(result=>result.status==='fulfilled'&&
      'statusCode' in result.value&&result.value.statusCode<300).length;
    const withdrawalSuccess=attempts[3]!.status==='fulfilled'?1:0;
    expect(apiSuccess+withdrawalSuccess).toBe(1);
    const owner=ids.other_creator!;
    const effects=(await db.query<{count:string}>(`SELECT
      ((SELECT count(*) FROM clob_orders WHERE owner_id=$1)+
       (SELECT count(*) FROM amm_quotes WHERE owner_id=$1 AND state='executed')+
       (SELECT count(*) FROM rfq_fills WHERE requester_owner_id=$1 OR dealer_owner_id=$1)+
       (SELECT count(*) FROM withdrawals WHERE owner_id=$1))::text AS count`,[owner])).rows[0]!;
    expect(effects.count).toBe('1');
    const available=await accountBalance(db,await ledgerAccount(db,owner,'DEMO','user_available'));
    expect(available).toBeGreaterThanOrEqual(0n);
  });
});
