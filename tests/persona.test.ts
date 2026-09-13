import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createHmac,randomUUID } from 'node:crypto';
import { embeddedDatabase } from '../scripts/embedded.js';
import { seedDemo } from '../scripts/fixtures.js';
import { migrate } from '../src/platform/migrations.js';
import type { Database } from '../src/platform/database.js';
import type { IdentityVerificationProvider } from '../src/identity/providers.js';
import { applyPersonaEvent,createIdentitySession,verifyPersonaSignature } from '../src/identity/persona.js';

let db:Database,accountId:string,inquiryId:string;
const provider:IdentityVerificationProvider={async createSession(){return {providerReference:'inq_test',clientToken:'session_test',expiresAt:null};},
  async getState(){return {state:'PENDING',evidenceReference:'persona:inq_test'};}};
beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);accountId=(await seedDemo(db)).trader!;
  await db.query("UPDATE account_assurance SET identity_status='NOT_STARTED',identity_evidence_ref=NULL WHERE account_id=$1",[accountId]);
  const result=await db.transaction(sql=>createIdentitySession(sql,provider,{accountId,idempotencyKey:'persona-command',requestId:'request'}));
  inquiryId=result.inquiry_id;});
afterAll(async()=>db.close());

const event=(name:string,status:string,occurredAt:string,eventId:string=randomUUID())=>({eventId,name,status,occurredAt,
  providerReference:'inq_test',accountReference:accountId});
describe('Persona identity state ingestion',()=>{
  it('verifies raw-body signatures with replay tolerance and rotation',()=>{
    const raw=Buffer.from('{"data":"exact"}'),timestamp=Math.floor(Date.now()/1000).toString(),key=['webhook','unit','key'].join(':');
    const signature=createHmac('sha256',key).update(`${timestamp}.`).update(raw).digest('hex');
    expect(verifyPersonaSignature(raw,`t=${timestamp},v1=${signature}`,[key])).toBe(true);
    expect(verifyPersonaSignature(Buffer.from('{}'),`t=${timestamp},v1=${signature}`,[key])).toBe(false);
    expect(verifyPersonaSignature(raw,`t=${Number(timestamp)-1000},v1=${signature}`,[key])).toBe(false);
  });
  it('deduplicates repeated events and ignores stale state transitions',async()=>{
    const approved=event('inquiry.approved','approved','2026-09-13T10:00:00.000Z','evt_approved'),raw=Buffer.from('{"event":"approved"}');
    const results=[];for(let i=0;i<20;i++)results.push(await db.transaction(sql=>applyPersonaEvent(sql,approved,raw,`request-${i}`)));
    expect(results.filter(result=>result.applied)).toHaveLength(1);
    const stale=await db.transaction(sql=>applyPersonaEvent(sql,event('inquiry.started','pending','2026-09-13T09:00:00.000Z','evt_stale'),
      Buffer.from('{"event":"stale"}'),'stale-request'));
    expect(stale.applied).toBe(false);
    const assurance=(await db.query<{identity_status:string;identity_evidence_ref:string}>('SELECT identity_status,identity_evidence_ref FROM account_assurance WHERE account_id=$1',[accountId])).rows[0];
    expect(assurance).toEqual({identity_status:'VERIFIED',identity_evidence_ref:'persona:inq_test'});
    expect((await db.query<{count:string}>('SELECT count(*)::text AS count FROM identity_provider_events')).rows[0]!.count).toBe('2');
    expect(inquiryId).toBeTruthy();
  });
  it('rejects an event identifier reused with different content',async()=>{
    await expect(db.transaction(sql=>applyPersonaEvent(sql,event('inquiry.approved','approved','2026-09-13T10:00:00.000Z','evt_approved'),
      Buffer.from('{"event":"tampered"}'),'conflict'))).rejects.toMatchObject({code:'PROVIDER_EVENT_CONFLICT'});
  });
});
