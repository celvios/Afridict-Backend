import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { AppError,requireCondition } from '../platform/errors.js';
import { record } from '../platform/commands.js';
import type { IdentityState,IdentityVerificationProvider } from './providers.js';
import { normalizePersonaState } from './providers.js';

export type PersonaDependencies={provider:IdentityVerificationProvider;webhookSecrets:readonly string[]};
export function verifyPersonaSignature(raw:Buffer,header:string,secrets:readonly string[],now=Date.now()) {
  const groups=header.trim().split(/\s+/),timestamp=groups[0]?.split(',').find(part=>part.startsWith('t='))?.slice(2);
  const signatures=groups.flatMap(group=>group.split(',').filter(part=>part.startsWith('v1=')).map(part=>part.slice(3)));
  if(!timestamp||!/^\d{10}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||!signatures.length)return false;
  return secrets.some(secret=>{const expected=createHmac('sha256',secret).update(timestamp).update('.').update(raw).digest();
    return signatures.some(value=>{try{return timingSafeEqual(expected,Buffer.from(value,'hex'));}catch{return false;}});});
}
export async function createIdentitySession(sql:Sql,provider:IdentityVerificationProvider,input:{accountId:string;idempotencyKey:string;requestId:string}) {
  const assurance=(await sql.query<{identity_status:string}>('SELECT identity_status FROM account_assurance WHERE account_id=$1 FOR UPDATE',[input.accountId])).rows[0];
  requireCondition(assurance,409,'REGISTRATION_PROFILE_REQUIRED','Complete registration before identity verification.');
  requireCondition(assurance.identity_status!=='VERIFIED',409,'IDENTITY_ALREADY_VERIFIED','Identity verification is already complete.');
  const session=await provider.createSession({accountId:input.accountId,idempotencyKey:input.idempotencyKey});
  const inquiry=(await sql.query<{id:string}>(`INSERT INTO identity_inquiries(id,account_id,provider,provider_reference,state)
    VALUES ($1,$2,'persona',$3,'PENDING') ON CONFLICT (provider,provider_reference) DO UPDATE SET updated_at=now() RETURNING id`,
    [randomUUID(),input.accountId,session.providerReference])).rows[0]!;
  await sql.query("UPDATE account_assurance SET identity_status='PENDING',identity_updated_at=now() WHERE account_id=$1",[input.accountId]);
  await record(sql,{actor:input.accountId,authority:'account_owner',action:'identity.session_created',resource:inquiry.id,
    request:input.requestId,reason:'Identity verification requested',after:{state:'PENDING',provider:'persona'}});
  return {inquiry_id:inquiry.id,state:'PENDING' as const,client_token:session.clientToken,expires_at:session.expiresAt};
}

const eventState=(name:string,status:string):IdentityState=>{
  const expected:Record<string,string[]>={
    'inquiry.created':['created'],'inquiry.started':['pending'],'inquiry.completed':['completed'],
    'inquiry.failed':['failed'],'inquiry.expired':['expired'],'inquiry.approved':['approved'],
    'inquiry.marked-for-review':['needs_review','needs review'],'inquiry.declined':['declined'],
  };
  requireCondition(expected[name]?.includes(status),400,'MALFORMED_PROVIDER_EVENT','Persona event name and status are inconsistent.');
  return normalizePersonaState(status);
};
export type PersonaEvent={eventId:string;name:string;occurredAt:string;providerReference:string;accountReference:string;status:string};
export async function applyPersonaEvent(sql:Sql,event:PersonaEvent,raw:Buffer,requestId:string) {
  const state=eventState(event.name,event.status),payloadHash=createHash('sha256').update(raw).digest('hex');
  const existing=(await sql.query<{payload_hash:string}>('SELECT payload_hash FROM identity_provider_events WHERE provider=$1 AND event_id=$2',['persona',event.eventId])).rows[0];
  if(existing){if(existing.payload_hash!==payloadHash)throw new AppError(409,'PROVIDER_EVENT_CONFLICT','The provider event ID was reused with different content.');return {accepted:true,applied:false};}
  const inquiry=(await sql.query<{id:string;account_id:string;last_provider_event_at:Date|null}>(
    "SELECT * FROM identity_inquiries WHERE provider='persona' AND provider_reference=$1 FOR UPDATE",[event.providerReference])).rows[0];
  requireCondition(inquiry&&inquiry.account_id===event.accountReference,404,'IDENTITY_INQUIRY_NOT_FOUND','Identity inquiry not found.');
  const occurred=new Date(event.occurredAt);requireCondition(!Number.isNaN(occurred.valueOf()),400,'MALFORMED_PROVIDER_EVENT','Invalid provider event time.');
  const applied=!inquiry.last_provider_event_at||occurred>new Date(inquiry.last_provider_event_at);
  await sql.query(`INSERT INTO identity_provider_events(provider,event_id,provider_reference,payload_hash,event_name,occurred_at,applied)
    VALUES ('persona',$1,$2,$3,$4,$5,$6)`,[event.eventId,event.providerReference,payloadHash,event.name,occurred,applied]);
  if(applied){
    await sql.query('UPDATE identity_inquiries SET state=$2,last_provider_event_at=$3,updated_at=now() WHERE id=$1',[inquiry.id,state,occurred]);
    await sql.query(`UPDATE account_assurance SET identity_status=$2,identity_evidence_ref=$3,identity_updated_at=now()
      WHERE account_id=$1`,[inquiry.account_id,state,`persona:${event.providerReference}`]);
    await record(sql,{actor:'persona',authority:'identity_verification_provider',action:'identity.updated',resource:inquiry.account_id,
      request:requestId,reason:'Authenticated Persona inquiry event',evidence:`persona:${event.providerReference}`,after:{state}});
  }
  return {accepted:true,applied};
}
