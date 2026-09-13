import { createHmac,randomUUID } from 'node:crypto';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import { record } from '../platform/commands.js';
import type { ContactVerificationProvider,VerificationChannel } from './providers.js';

export type ContactDependencies={provider:ContactVerificationProvider;abuseHashKey:string};
type VerificationRow={id:string;account_id:string;channel:VerificationChannel;state:string;attempts:number;
  expires_at:Date;resend_available_at:Date;created_at:Date};
const limits={send:{account:5,destination:5,ip:20},check:{account:20,destination:20,ip:50}} as const;
const digest=(key:string,value:string)=>createHmac('sha256',key).update(value).digest('hex');
const publicVerification=(row:VerificationRow)=>({id:row.id,channel:row.channel,state:row.state,attempts_remaining:Math.max(0,5-row.attempts),
  expires_at:new Date(row.expires_at).toISOString(),resend_available_at:new Date(row.resend_available_at).toISOString()});

async function context(sql:Sql,accountId:string,channel:VerificationChannel,key:string,ip:string) {
  const profile=(await sql.query<{email:string;phone_e164:string}>(
    'SELECT email,phone_e164 FROM account_profiles WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  requireCondition(profile,409,'REGISTRATION_PROFILE_REQUIRED','Complete the registration profile before contact verification.');
  const destination=channel==='email'?profile.email:profile.phone_e164;
  return {destination,destinationHash:digest(key,`${channel}:${destination}`),ipHash:digest(key,ip)};
}
async function enforceLimit(sql:Sql,accountId:string,channel:VerificationChannel,action:'send'|'check',destinationHash:string,ipHash:string) {
  const count=async(column:string,value:string)=>(await sql.query<{count:string}>(`SELECT count(*)::text AS count FROM contact_verification_events
    WHERE ${column}=$1 AND channel=$2 AND action=$3 AND created_at>now()-interval '1 hour'`,[value,channel,action])).rows[0]!.count;
  const [account,destination,ip]=await Promise.all([count('account_id',accountId),count('destination_hash',destinationHash),count('ip_hash',ipHash)]);
  const cap=limits[action];
  requireCondition(BigInt(account)<BigInt(cap.account)&&BigInt(destination)<BigInt(cap.destination)&&BigInt(ip)<BigInt(cap.ip),
    429,'CONTACT_RATE_LIMITED','Contact verification limit reached. Try again later.');
}
async function event(sql:Sql,input:{verificationId?:string;accountId:string;channel:VerificationChannel;action:'send'|'check';
  destinationHash:string;ipHash:string;outcome:string}) {
  await sql.query(`INSERT INTO contact_verification_events(id,verification_id,account_id,channel,action,destination_hash,ip_hash,outcome)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),input.verificationId??null,input.accountId,input.channel,input.action,
    input.destinationHash,input.ipHash,input.outcome]);
}

export async function sendContactCode(sql:Sql,deps:ContactDependencies,input:{accountId:string;channel:VerificationChannel;ip:string;requestId:string}) {
  const ctx=await context(sql,input.accountId,input.channel,deps.abuseHashKey,input.ip);
  await enforceLimit(sql,input.accountId,input.channel,'send',ctx.destinationHash,ctx.ipHash);
  const latest=(await sql.query<VerificationRow>(`SELECT * FROM contact_verifications WHERE account_id=$1 AND channel=$2
    ORDER BY created_at DESC LIMIT 1`,[input.accountId,input.channel])).rows[0];
  requireCondition(!latest||new Date(latest.resend_available_at)<=new Date(),429,'RESEND_COOLDOWN','Wait before requesting another verification code.');
  const id=randomUUID(),expires=new Date(Date.now()+10*60_000),resend=new Date(Date.now()+60_000);
  await sql.query(`INSERT INTO contact_verifications(id,account_id,channel,destination_hash,state,expires_at,resend_available_at)
    VALUES ($1,$2,$3,$4,'pending',$5,$6)`,[id,input.accountId,input.channel,ctx.destinationHash,expires,resend]);
  try {
    const sent=await deps.provider.send({channel:input.channel,destination:ctx.destination});
    const row=(await sql.query<VerificationRow>(`UPDATE contact_verifications SET provider_reference=$2,updated_at=now()
      WHERE id=$1 RETURNING *`,[id,sent.reference])).rows[0]!;
    await event(sql,{verificationId:id,accountId:input.accountId,channel:input.channel,action:'send',destinationHash:ctx.destinationHash,ipHash:ctx.ipHash,outcome:'accepted'});
    await record(sql,{actor:input.accountId,authority:'account_owner',action:`${input.channel}.verification_sent`,resource:id,
      request:input.requestId,reason:'Contact possession verification requested'});
    return {ok:true as const,verification:publicVerification(row)};
  } catch {
    const row=(await sql.query<VerificationRow>("UPDATE contact_verifications SET state='delivery_uncertain',updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0]!;
    await event(sql,{verificationId:id,accountId:input.accountId,channel:input.channel,action:'send',destinationHash:ctx.destinationHash,ipHash:ctx.ipHash,outcome:'uncertain'});
    return {ok:false as const,verification:publicVerification(row)};
  }
}

export async function checkContactCode(sql:Sql,deps:ContactDependencies,input:{accountId:string;channel:VerificationChannel;code:string;ip:string;requestId:string}) {
  const ctx=await context(sql,input.accountId,input.channel,deps.abuseHashKey,input.ip);
  await enforceLimit(sql,input.accountId,input.channel,'check',ctx.destinationHash,ctx.ipHash);
  const row=(await sql.query<VerificationRow>(`SELECT * FROM contact_verifications WHERE account_id=$1 AND channel=$2
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[input.accountId,input.channel])).rows[0];
  requireCondition(row,409,'VERIFICATION_REQUIRED','Request a verification code first.');
  requireCondition(['pending','delivery_uncertain'].includes(row.state),409,'VERIFICATION_NOT_PENDING','This verification is no longer pending.');
  requireCondition(new Date(row.expires_at)>new Date(),409,'VERIFICATION_EXPIRED','Request a new verification code.');
  requireCondition(row.attempts<5,429,'VERIFICATION_ATTEMPTS_EXHAUSTED','Request a new verification code.');
  let result;
  try { result=await deps.provider.check({channel:input.channel,destination:ctx.destination,code:input.code}); }
  catch { await event(sql,{verificationId:row.id,accountId:input.accountId,channel:input.channel,action:'check',destinationHash:ctx.destinationHash,ipHash:ctx.ipHash,outcome:'uncertain'}); return {ok:false as const}; }
  const attempts=row.attempts+1,state=result==='approved'?'approved':result==='expired'?'expired':attempts>=5?'failed':'pending';
  const updated=(await sql.query<VerificationRow>('UPDATE contact_verifications SET state=$2,attempts=$3,updated_at=now() WHERE id=$1 RETURNING *',[row.id,state,attempts])).rows[0]!;
  await event(sql,{verificationId:row.id,accountId:input.accountId,channel:input.channel,action:'check',destinationHash:ctx.destinationHash,ipHash:ctx.ipHash,outcome:state});
  if(state==='approved') {
    await sql.query(`UPDATE account_assurance SET ${input.channel==='email'?'email_verified_at':'phone_verified_at'}=now() WHERE account_id=$1`,[input.accountId]);
    await record(sql,{actor:input.accountId,authority:'contact_verification_provider',action:`${input.channel}.verified`,resource:input.accountId,
      request:input.requestId,reason:'Provider approved contact possession'});
  }
  return {ok:true as const,verification:publicVerification(updated)};
}
