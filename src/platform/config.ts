import 'dotenv/config';

export interface Config {
  environment: 'development' | 'test' | 'production'; host: string; port: number;
  databaseUrl?: string; authMode: 'oidc' | 'demo'; issuer?: string; audience?: string;
  jwksUrl?: string; corsOrigins: string[]; docs: boolean; logger: boolean;
}
export function config(env = process.env): Config {
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) throw new Error('Invalid NODE_ENV');
  const authMode = env.AUTH_MODE ?? 'oidc';
  if (!['oidc', 'demo'].includes(authMode)) throw new Error('Invalid AUTH_MODE');
  const host = env.HOST ?? '127.0.0.1';
  if (authMode === 'demo' && (environment === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host)))
    throw new Error('Demo authentication is restricted to local non-production use');
  if (authMode === 'oidc') {
    if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.OIDC_JWKS_URL) throw new Error('OIDC configuration is required');
    for (const value of [env.OIDC_ISSUER, env.OIDC_JWKS_URL])
      if (new URL(value).protocol !== 'https:') throw new Error('OIDC endpoints must use HTTPS');
  }
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || origin === '*')
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
    if (environment === 'production' && parsed.protocol !== 'https:') throw new Error('Production CORS requires HTTPS');
  }
  return { environment: environment as Config['environment'], host, port, authMode: authMode as Config['authMode'],
    databaseUrl: env.DATABASE_URL, issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE, jwksUrl: env.OIDC_JWKS_URL,
    corsOrigins, docs: env.DOCS_ENABLED === 'true' || (environment !== 'production' && env.DOCS_ENABLED !== 'false'),
    logger: environment !== 'test' };
}
