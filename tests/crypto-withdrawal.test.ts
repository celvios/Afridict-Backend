import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {embeddedDatabase} from '../scripts/embedded.js';
import {demoAuth,demoConfig,seedDemo} from '../scripts/fixtures.js';
import {buildApp} from '../src/app.js';
import {migrate} from '../src/platform/migrations.js';
import type {Database} from '../src/platform/database.js';
import {ledgerAccount,postJournal} from '../src/financial/ledger.js';

let db:Database,app:FastifyInstance;
const trader={authorization:'Bearer demo.trader'},finance={authorization:'Bearer demo.finance'};
const contract=`0x${'1'.repeat(40)}`,destination=`0x${'2'.repeat(40)}`,transactionHash=`0x${'3'.repeat(64)}`;
const post=(url:string,payload:unknown,key:string,headers=trader)=>app.inject({method:'POST',url,payload:payload as Record<string,unknown>,
  headers:{...headers,'idempotency-key':key}});

beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);
  await db.query("UPDATE eligibility SET status='eligible',policy_version='synthetic:eligible' WHERE account_id=$1",[ids.trader]);
  await db.query(`INSERT INTO financial_assets(code,scale,synthetic,approved,evidence_ref) VALUES ('USDT_BSC_TEST',18,true,true,'synthetic-test-only')`);
  await db.query(`INSERT INTO token_asset_registry(asset_code,symbol,chain_id,contract_address,decimals,approved,evidence_ref)
    VALUES ('USDT_BSC_TEST','USDT',56,$1,18,true,'synthetic-test-only')`,[contract]);
  await db.transaction(async sql=>{const escrow=await ledgerAccount(sql,null,'USDT_BSC_TEST','escrow_asset'),
    available=await ledgerAccount(sql,ids.trader!,'USDT_BSC_TEST','user_available');await postJournal(sql,{effectId:'synthetic:usdt-opening',
      asset:'USDT_BSC_TEST',kind:'financial_correction',referenceId:'synthetic-fixture',reason:'Synthetic test token balance',
      lines:[{account:escrow,debit:100000000000000000000n,credit:0n},{account:available,debit:0n,credit:100000000000000000000n}]});});
  app=await buildApp(db,demoConfig,demoAuth);});
afterAll(async()=>{await app.close();await db.close();});

describe('manual BEP-20 withdrawal',()=>{
  it('publishes the exact approved token identity',async()=>{
    const response=await app.inject({method:'GET',url:'/v1/crypto-assets',headers:trader});expect(response.statusCode,response.body).toBe(200);
    expect(response.json().items).toEqual([{code:'USDT_BSC_TEST',symbol:'USDT',chain_id:'56',contract_address:contract,
      decimals:18,withdrawal_mode:'manual_finance_review'}]);
  });
  it('reserves tokens for review without sending a transaction',async()=>{
    const response=await post('/v1/crypto/withdrawals',{asset:'USDT_BSC_TEST',amount_minor:'25000000000000000000',wallet_address:destination},'crypto-request');
    expect(response.statusCode,response.body).toBe(202);expect(response.json()).toMatchObject({asset:'USDT_BSC_TEST',state:'reserved',
      destination_ref:destination,rail:'manual_bep20'});
  });
  it('lets the finance administrator approve and record the company-wallet hash',async()=>{
    const queue=await app.inject({method:'GET',url:'/v1/admin/crypto/withdrawals?state=reserved',headers:finance});
    expect(queue.statusCode,queue.body).toBe(200);const item=queue.json().items[0];
    expect(item).toMatchObject({symbol:'USDT',chain_id:'56',token_contract:contract,destination_ref:destination,approved_by:null});
    const approved=await post(`/v1/admin/crypto/withdrawals/${item.id}/approve`,{reason:'Reviewed token, network, address and amount'},'crypto-approve',finance);
    expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().state).toBe('approved');
    const submitted=await post(`/v1/admin/crypto/withdrawals/${item.id}/submission`,{transaction_hash:transactionHash},'crypto-submit',finance);
    expect(submitted.statusCode,submitted.body).toBe(200);expect(submitted.json().state).toBe('submitted');
    const visible=await app.inject({method:'GET',url:'/v1/crypto/withdrawals',headers:trader});
    expect(visible.json().items[0]).toMatchObject({id:item.id,state:'submitted'});
  });
  it('keeps submitted tokens reserved until independent chain finality',async()=>{
    const wallet=await app.inject({method:'GET',url:'/v1/balances',headers:trader}),token=wallet.json().items.find((item:{asset:string})=>item.asset==='USDT_BSC_TEST');
    expect(token).toMatchObject({available_minor:'75000000000000000000',withdrawal_pending_minor:'25000000000000000000'});
  });
  it('rejects a symbol without an approved contract-specific asset',async()=>{
    const response=await post('/v1/crypto/withdrawals',{asset:'USDT',amount_minor:'1',wallet_address:destination},'crypto-unapproved');
    expect(response.statusCode).toBe(422);expect(response.json().code).toBe('TOKEN_NOT_APPROVED');
  });
});
