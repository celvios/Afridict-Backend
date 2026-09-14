import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createHmac,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { embeddedDatabase } from '../scripts/embedded.js';
import { demoAuth,demoConfig,seedDemo } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/platform/migrations.js';
import type { Database } from '../src/platform/database.js';
import type { IdentityVerificationProvider } from '../src/identity/providers.js';
import { applyPersonaEvent,createIdentitySession,verifyPersonaSignature } from '../src/identity/persona.js';

let db:Database,app:FastifyInstance,accountId:string,inquiryId:string;
const providerReferenceFor=(id:string)=>`inq_${id}`;
const provider:IdentityVerificationProvider={async createSession({accountId:id}){return {providerReference:providerReferenceFor(id),clientToken:'session_test',expiresAt:null};},
  async getState(providerReference){return {state:'PENDING',evidenceReference:`persona:${providerReference}`};}};
const webhookKey=['persona','webhook','secret','with','at','least','thirty-two','characters'].join(':');
beforeAll(async()=>{db=await embeddedDatabase();await migrate(db);accountId=(await seedDemo(db)).trader!;
  await db.query("UPDATE account_assurance SET identity_status='NOT_STARTED',identity_evidence_ref=NULL WHERE account_id=$1",[accountId]);
  const result=await db.transaction(sql=>createIdentitySession(sql,provider,{accountId,idempotencyKey:'persona-command',requestId:'request'}));
  inquiryId=result.inquiry_id;app=await buildApp(db,demoConfig,demoAuth,undefined,undefined,{provider,webhookSecrets:[webhookKey]});});
afterAll(async()=>{await app.close();await db.close();});

const event=(name:string,status:string,occurredAt:string,eventId:string=randomUUID())=>({eventId,name,status,occurredAt,
  providerReference:providerReferenceFor(accountId),accountReference:accountId});
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
    expect(assurance).toEqual({identity_status:'VERIFIED',identity_evidence_ref:`persona:${providerReferenceFor(accountId)}`});
    expect((await db.query<{count:string}>('SELECT count(*)::text AS count FROM identity_provider_events')).rows[0]!.count).toBe('2');
    expect(inquiryId).toBeTruthy();
  });
  it('rejects an event identifier reused with different content',async()=>{
    await expect(db.transaction(sql=>applyPersonaEvent(sql,event('inquiry.approved','approved','2026-09-13T10:00:00.000Z','evt_approved'),
      Buffer.from('{"event":"tampered"}'),'conflict'))).rejects.toMatchObject({code:'PROVIDER_EVENT_CONFLICT'});
  });
  it('creates an idempotent identity session through the authenticated API',async()=>{
    await db.query("UPDATE account_assurance SET identity_status='NOT_STARTED' WHERE account_id=(SELECT id FROM accounts WHERE subject='creator')");
    const request={method:'POST' as const,url:'/v1/kyc/session',payload:{},headers:{authorization:'Bearer demo.creator','idempotency-key':'persona-http-session'}};
    const created=await app.inject(request),replayed=await app.inject(request);
    expect(created.statusCode,created.body).toBe(201);expect(replayed.statusCode,replayed.body).toBe(201);
    expect(replayed.json()).toEqual(created.json());expect(created.json()).toMatchObject({state:'PENDING',client_token:'session_test',expires_at:null});
  });
  it('authenticates the exact HTTP webhook body and exposes normalized status',async()=>{
    const providerReference='inq_http',eventId='evt_http_approved';
    await db.query(`INSERT INTO identity_inquiries(id,account_id,provider,provider_reference,state)
      VALUES ($1,$2,'persona',$3,'PENDING')`,[randomUUID(),accountId,providerReference]);
    const payload=JSON.stringify({data:{id:eventId,type:'event',attributes:{name:'inquiry.approved','created-at':new Date().toISOString(),
      payload:{data:{id:providerReference,type:'inquiry',attributes:{status:'approved','reference-id':accountId}}}}}});
    const timestamp=Math.floor(Date.now()/1000).toString();
    const signature=createHmac('sha256',webhookKey).update(`${timestamp}.`).update(payload).digest('hex');
    const accepted=await app.inject({method:'POST',url:'/v1/webhooks/persona',payload,
      headers:{'content-type':'application/json','persona-signature':`t=${timestamp},v1=${signature}`}});
    expect(accepted.statusCode,accepted.body).toBe(202);expect(accepted.json()).toEqual({accepted:true,applied:true});
    const status=await app.inject({method:'GET',url:'/v1/kyc/status',headers:{authorization:'Bearer demo.trader'}});
    expect(status.statusCode,status.body).toBe(200);expect(status.json()).toMatchObject({state:'VERIFIED'});
    const tampered=await app.inject({method:'POST',url:'/v1/webhooks/persona',payload:payload.replace('approved','declined'),
      headers:{'content-type':'application/json','persona-signature':`t=${timestamp},v1=${signature}`}});
    expect(tampered.statusCode).toBe(401);
  });
});
