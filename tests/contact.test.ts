import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth,demoConfig,seedDemo } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/platform/migrations.js';
import type { Database } from '../src/platform/database.js';
import type { ContactVerificationProvider } from '../src/identity/providers.js';

let db:Database,app:FastifyInstance,key=0;
const provider:ContactVerificationProvider={
  async send({destination}) { if(destination.startsWith('fail'))throw new Error('timeout'); return {reference:`test:${destination}`,status:'pending'}; },
  async check({code}) { return code==='246810'?'approved':'pending'; },
};
const post=(persona:string,url:string,payload:unknown={})=>app.inject({method:'POST',url,payload:payload as Record<string,unknown>,
  headers:{authorization:`Bearer demo.${persona}`,'idempotency-key':`contact-${++key}`}});

beforeAll(async()=>{
  db=await embeddedDatabase();await migrate(db);const ids=await seedDemo(db);
  for(const [persona,email,phone] of [['trader','trader@example.test','+2348030000001'],
    ['creator','creator@example.test','+2348030000002'],['approver','fail@example.test','+2348030000003']] as const)
    await db.query(`INSERT INTO account_profiles(account_id,first_name,last_name,email,phone_e164,terms_version,privacy_version,accepted_at)
      VALUES ($1,'Test',$2,$3,$4,'test:terms','test:privacy',now())`,[ids[persona],persona,email,phone]);
  app=await buildApp(db,demoConfig,demoAuth,undefined,{provider,abuseHashKey:['test','abuse','key'].join(':')});
});
afterAll(async()=>{await app.close();await db.close();});

describe('contact verification workflows',()=>{
  it('verifies email without persisting the OTP',async()=>{
    const sent=await post('trader','/v1/auth/email/send-code');expect(sent.statusCode,sent.body).toBe(202);
    const wrong=await post('trader','/v1/auth/email/verify-code',{code:'111111'});expect(wrong.json()).toMatchObject({state:'pending',attempts_remaining:4});
    const approved=await post('trader','/v1/auth/email/verify-code',{code:'246810'});expect(approved.json()).toMatchObject({state:'approved'});
    const assurance=(await db.query<{email_verified_at:Date|null}>('SELECT email_verified_at FROM account_assurance WHERE account_id=(SELECT account_id FROM account_profiles WHERE email=$1)',['trader@example.test'])).rows[0];
    expect(assurance?.email_verified_at).toBeTruthy();
    const stored=await db.query('SELECT * FROM contact_verifications');expect(JSON.stringify(stored.rows)).not.toContain('246810');
  });
  it('enforces resend cooldown for the saved E.164 phone',async()=>{
    expect((await post('creator','/v1/auth/phone/send-code')).statusCode).toBe(202);
    const repeated=await post('creator','/v1/auth/phone/send-code');expect(repeated.statusCode).toBe(429);
    expect(repeated.json().code).toBe('RESEND_COOLDOWN');
  });
  it('records uncertain provider delivery and returns a retryable failure',async()=>{
    const response=await post('approver','/v1/auth/email/send-code');expect(response.statusCode,response.body).toBe(503);
    const row=(await db.query<{state:string}>(`SELECT state FROM contact_verifications WHERE account_id=
      (SELECT account_id FROM account_profiles WHERE email='fail@example.test')`)).rows[0];
    expect(row?.state).toBe('delivery_uncertain');
  });
});
