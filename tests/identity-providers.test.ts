import { describe,expect,it,vi } from 'vitest';
import { normalizeEmail,normalizePhone,normalizePersonaState,PersonaIdentityProvider,TwilioVerifyProvider } from '../src/identity/providers.js';

const sid=`VA${'a'.repeat(32)}`;
const provider=(responses:Array<{ok:boolean;status:number;body:unknown}>)=>{
  const request=vi.fn(async()=>{const response=responses.shift()!;return {ok:response.ok,status:response.status,
    json:async()=>response.body} as Response;});
  return {adapter:new TwilioVerifyProvider({serviceSid:sid,apiKeySid:['test','key'].join('-'),
    apiKeySecret:['unit','credential'].join('-')},request),request};
};

describe('contact provider boundary',()=>{
  it('normalizes valid phone numbers to E.164 and rejects invalid input',()=>{
    expect(normalizePhone('0803 123 4567','NG')).toBe('+2348031234567');
    expect(()=>normalizePhone('123')).toThrow('INVALID_PHONE_NUMBER');
    expect(normalizeEmail(' Person@Example.COM ')).toBe('person@example.com');
    expect(()=>normalizeEmail('invalid')).toThrow('INVALID_EMAIL_ADDRESS');
  });
  it('maps Twilio send and check responses without leaking provider types',async()=>{
    const {adapter,request}=provider([{ok:true,status:201,body:{sid:`VE${'b'.repeat(32)}`,status:'pending'}},
      {ok:true,status:200,body:{status:'approved',valid:true}}]);
    expect(await adapter.send({channel:'phone',destination:'+2348031234567'})).toMatchObject({status:'pending'});
    expect(await adapter.check({channel:'phone',destination:'+2348031234567',code:'123456'})).toBe('approved');
    const calls=request.mock.calls as unknown as Array<[string,RequestInit]>;
    expect(String(calls[0]![0])).toContain('/Verifications');
    expect(String(calls[1]![0])).toContain('/VerificationCheck');
    expect(String(calls[0]![1].body)).toContain('Channel=sms');
  });
  it('maps incorrect and expired checks and rejects malformed codes locally',async()=>{
    const {adapter}=provider([{ok:true,status:200,body:{status:'pending',valid:false}},{ok:false,status:404,body:{}}]);
    expect(await adapter.check({channel:'email',destination:'person@example.com',code:'111111'})).toBe('pending');
    expect(await adapter.check({channel:'email',destination:'person@example.com',code:'222222'})).toBe('expired');
    expect(await adapter.check({channel:'email',destination:'person@example.com',code:'bad'})).toBe('failed');
  });
});

describe('Persona provider boundary',()=>{
  it('maps documented inquiry states into Afridict states',()=>{
    expect(normalizePersonaState('approved')).toBe('VERIFIED');
    expect(normalizePersonaState('needs review')).toBe('IN_REVIEW');
    expect(normalizePersonaState('expired')).toBe('REQUIRES_RETRY');
    expect(()=>normalizePersonaState('unknown')).toThrow('PERSONA_UNKNOWN_STATUS');
  });
  it('creates an inquiry with an opaque account reference and provider idempotency',async()=>{
    const request=vi.fn(async()=>({ok:true,status:201,json:async()=>({data:{id:'inq_test',attributes:{status:'created'}},
      meta:{'session-token':'session_test'}})} as Response));
    const adapter=new PersonaIdentityProvider({apiKey:['unit','key'].join(':'),templateId:'itmpl_test',version:'2025-12-08'},request);
    expect(await adapter.createSession({accountId:'account-id',idempotencyKey:'command-id'})).toEqual({
      providerReference:'inq_test',clientToken:'session_test',expiresAt:null});
    const call=request.mock.calls as unknown as Array<[string,RequestInit]>;
    expect(call[0]![0]).toBe('https://api.withpersona.com/api/v1/inquiries');
    expect((call[0]![1].headers as Record<string,string>)['idempotency-key']).toBe('command-id');
    expect(String(call[0]![1].body)).toContain('"reference-id":"account-id"');
  });
});
