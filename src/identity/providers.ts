import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type VerificationChannel='email'|'phone';
export type VerificationCheck='approved'|'pending'|'expired'|'failed';
export interface ContactVerificationProvider {
  send(input:{channel:VerificationChannel;destination:string}):Promise<{reference:string;status:'pending'}>;
  check(input:{channel:VerificationChannel;destination:string;code:string}):Promise<VerificationCheck>;
}
export interface EmailProvider {
  enqueue(input:{template:string;recipient:string;parameters:Record<string,string>;eventId:string}):Promise<void>;
}
export type IdentityState='NOT_STARTED'|'PENDING'|'IN_REVIEW'|'VERIFIED'|'FAILED'|'REQUIRES_RETRY';
export interface IdentityVerificationProvider {
  createSession(input:{accountId:string;reference:string}):Promise<{providerReference:string;clientToken:string;expiresAt:string}>;
  getState(providerReference:string):Promise<{state:IdentityState;evidenceReference:string}>;
}

export function normalizePhone(value:string,defaultCountry?:CountryCode) {
  const phone=parsePhoneNumberFromString(value,defaultCountry);
  if (!phone?.isValid()) throw new Error('INVALID_PHONE_NUMBER');
  return phone.number;
}
export function normalizeEmail(value:string) {
  const normalized=value.trim().toLowerCase();
  if (normalized.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('INVALID_EMAIL_ADDRESS');
  return normalized;
}

type Fetch=typeof globalThis.fetch;
export class TwilioVerifyProvider implements ContactVerificationProvider {
  constructor(private readonly options:{serviceSid:string;apiKeySid:string;apiKeySecret:string;timeoutMs?:number},
    private readonly request:Fetch=globalThis.fetch) {
    if (!/^VA[0-9a-fA-F]{32}$/.test(options.serviceSid)) throw new Error('Invalid Twilio Verify service SID');
    if (!options.apiKeySid || !options.apiKeySecret) throw new Error('Missing Twilio API credentials');
  }
  private async post(path:string,body:URLSearchParams) {
    const response=await this.request(`https://verify.twilio.com/v2/Services/${this.options.serviceSid}/${path}`,{
      method:'POST',headers:{authorization:`Basic ${Buffer.from(`${this.options.apiKeySid}:${this.options.apiKeySecret}`).toString('base64')}`,
        'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(this.options.timeoutMs??5000),
    });
    if (!response.ok) throw new Error(`TWILIO_VERIFY_${response.status}`);
    return response.json() as Promise<{sid?:string;status?:string;valid?:boolean}>;
  }
  async send(input:{channel:VerificationChannel;destination:string}) {
    const result=await this.post('Verifications',new URLSearchParams({To:input.destination,Channel:input.channel==='phone'?'sms':'email'}));
    if (!result.sid || result.status!=='pending') throw new Error('TWILIO_VERIFY_INVALID_RESPONSE');
    return {reference:result.sid,status:'pending' as const};
  }
  async check(input:{channel:VerificationChannel;destination:string;code:string}):Promise<VerificationCheck> {
    if (!/^[0-9]{4,10}$/.test(input.code)) return 'failed';
    try {
      const result=await this.post('VerificationCheck',new URLSearchParams({To:input.destination,Code:input.code}));
      if (result.status==='approved'&&result.valid===true) return 'approved';
      return result.status==='pending'?'pending':'failed';
    } catch(error) {
      if (error instanceof Error&&error.message==='TWILIO_VERIFY_404') return 'expired';
      throw error;
    }
  }
}
