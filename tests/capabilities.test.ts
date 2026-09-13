import { describe,expect,it } from 'vitest';
import { evaluateCapabilities, inactiveCapabilities, type Assurance } from '../src/identity/capabilities.js';

const complete:Assurance={emailVerifiedAt:true,phoneVerifiedAt:true,identityStatus:'VERIFIED',
  fundingEligible:true,jurisdictionAllowed:true,riskAllowed:true};

describe('capability policy',()=>{
  it('fails closed while actions are not activated',()=>{
    const result=evaluateCapabilities(complete);
    expect(result.BROWSE).toEqual({allowed:true,requirements:[]});
    expect(result.TRADE).toEqual({allowed:false,requirements:['CAPABILITY_NOT_ACTIVE']});
  });
  it('requires Persona-normalized identity for NGN withdrawal only',()=>{
    const enabled={...inactiveCapabilities,WITHDRAW_NGN:true,WITHDRAW_CRYPTO:true};
    const result=evaluateCapabilities({...complete,identityStatus:'IN_REVIEW'},enabled);
    expect(result.WITHDRAW_NGN).toEqual({allowed:false,requirements:['IDENTITY_VERIFICATION']});
    expect(result.WITHDRAW_CRYPTO).toEqual({allowed:true,requirements:[]});
  });
  it('returns every independently unmet policy requirement',()=>{
    const result=evaluateCapabilities({emailVerifiedAt:false,phoneVerifiedAt:false,identityStatus:'NOT_STARTED',
      fundingEligible:false,jurisdictionAllowed:false,riskAllowed:false});
    expect(result.WITHDRAW_NGN.requirements).toEqual(['EMAIL_VERIFICATION','PHONE_VERIFICATION','FUNDING_ELIGIBILITY',
      'JURISDICTION_POLICY','RISK_REVIEW','IDENTITY_VERIFICATION','CAPABILITY_NOT_ACTIVE']);
  });
});
