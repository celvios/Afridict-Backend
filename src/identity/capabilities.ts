import type { Sql } from '../platform/database.js';
import type { Account } from './auth.js';

export const capabilityActions = ['BROWSE','TRADE','DEPOSIT_NGN','DEPOSIT_CRYPTO',
  'WITHDRAW_NGN','WITHDRAW_CRYPTO','USE_TRADING_API'] as const;
export type CapabilityAction = typeof capabilityActions[number];
export type Requirement = 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION' | 'IDENTITY_VERIFICATION' |
  'FUNDING_ELIGIBILITY' | 'JURISDICTION_POLICY' | 'RISK_REVIEW' | 'CAPABILITY_NOT_ACTIVE';
export type Assurance = { emailVerifiedAt: boolean; phoneVerifiedAt: boolean;
  identityStatus: 'NOT_STARTED' | 'PENDING' | 'IN_REVIEW' | 'VERIFIED' | 'FAILED' | 'REQUIRES_RETRY';
  fundingEligible: boolean; jurisdictionAllowed: boolean; riskAllowed: boolean };
export type Activations = Record<Exclude<CapabilityAction,'BROWSE'>, boolean>;
export type CapabilityDecision = { allowed: boolean; requirements: Requirement[] };
export type CapabilityResult = Record<CapabilityAction, CapabilityDecision>;

export const inactiveCapabilities: Activations = {
  TRADE:false, DEPOSIT_NGN:false, DEPOSIT_CRYPTO:false, WITHDRAW_NGN:false,
  WITHDRAW_CRYPTO:false, USE_TRADING_API:false,
};

export function evaluateCapabilities(a: Assurance, enabled: Activations = inactiveCapabilities): CapabilityResult {
  const contact: Requirement[] = [];
  if (!a.emailVerifiedAt) contact.push('EMAIL_VERIFICATION');
  if (!a.phoneVerifiedAt) contact.push('PHONE_VERIFICATION');
  const base = (action: Exclude<CapabilityAction,'BROWSE'>, needsIdentity = false): CapabilityDecision => {
    const requirements = [...contact];
    if (!a.fundingEligible) requirements.push('FUNDING_ELIGIBILITY');
    if (!a.jurisdictionAllowed) requirements.push('JURISDICTION_POLICY');
    if (!a.riskAllowed) requirements.push('RISK_REVIEW');
    if (needsIdentity && a.identityStatus !== 'VERIFIED') requirements.push('IDENTITY_VERIFICATION');
    if (!enabled[action]) requirements.push('CAPABILITY_NOT_ACTIVE');
    return { allowed: requirements.length === 0, requirements };
  };
  return {
    BROWSE:{allowed:true,requirements:[]}, TRADE:base('TRADE'), DEPOSIT_NGN:base('DEPOSIT_NGN'),
    DEPOSIT_CRYPTO:base('DEPOSIT_CRYPTO'), WITHDRAW_NGN:base('WITHDRAW_NGN',true),
    WITHDRAW_CRYPTO:base('WITHDRAW_CRYPTO'), USE_TRADING_API:base('USE_TRADING_API'),
  };
}

export async function accountAssurance(sql: Sql, account: Account): Promise<Assurance> {
  const row=(await sql.query<{email_verified_at:Date|null;phone_verified_at:Date|null;identity_status:Assurance['identityStatus'];
    eligibility_status:string|null}>(`SELECT assurance.email_verified_at,assurance.phone_verified_at,assurance.identity_status,
    eligibility.status AS eligibility_status FROM accounts account
    LEFT JOIN account_assurance assurance ON assurance.account_id=account.id
    LEFT JOIN eligibility ON eligibility.account_id=account.id WHERE account.id=$1`,[account.id])).rows[0];
  return {emailVerifiedAt:!!row?.email_verified_at,phoneVerifiedAt:!!row?.phone_verified_at,
    identityStatus:row?.identity_status??'NOT_STARTED',fundingEligible:row?.eligibility_status==='eligible',
    jurisdictionAllowed:false,riskAllowed:false};
}
