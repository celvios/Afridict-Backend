import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../platform/config.js';
import type { Sql } from '../platform/database.js';
import { AppError, requireCondition } from '../platform/errors.js';

export interface Principal { issuer: string; subject: string; expiresAt: string }
export interface Account {
  id: string; issuer: string; subject: string; jurisdiction: string;
  status: 'active' | 'suspended'; roles: string[]; created_at: Date;
}
export interface Authenticator { verify(token: string): Promise<Principal> }

export function oidcAuthenticator(config: Config, resolver?: JWTVerifyGetKey): Authenticator {
  if (!config.issuer || !config.audience || !config.jwksUrl) throw new Error('Missing identity-provider configuration');
  const key = resolver ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 3000, cooldownDuration: 30000 });
  return { async verify(token) {
    try {
      const { payload } = await jwtVerify(token, key, { issuer: config.issuer, audience: config.audience,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
      requireCondition(payload.sub && payload.exp && payload.sub.length <= 255, 401, 'UNAUTHENTICATED', 'A valid access token is required.');
      return { issuer: config.issuer!, subject: payload.sub, expiresAt: new Date(payload.exp * 1000).toISOString() };
    } catch (error) {
      if (error instanceof Error && ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID'].includes((error as { code?: string }).code ?? ''))
        throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Identity verification is temporarily unavailable.');
      throw new AppError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
    }
  } };
}
export async function findAccount(sql: Sql, principal: Principal, lock = false): Promise<Account> {
  const account = (await sql.query<Account>(`SELECT * FROM accounts WHERE issuer=$1 AND subject=$2${lock ? ' FOR SHARE' : ''}`,
    [principal.issuer, principal.subject])).rows[0];
  requireCondition(account, 403, 'ONBOARDING_REQUIRED', 'Complete onboarding before using this operation.');
  requireCondition(account.status === 'active', 403, 'ACCOUNT_RESTRICTED', 'This account cannot perform this operation.');
  return account;
}
export function hasRole(account: Account, ...roles: string[]) {
  requireCondition(roles.some(role => account.roles.includes(role)), 403, 'FORBIDDEN', 'This operation requires an authorized role.');
}
export function publicAccount(a: Account) {
  return { id: a.id, jurisdiction: a.jurisdiction, status: a.status, roles: a.roles, created_at: new Date(a.created_at).toISOString() };
}
