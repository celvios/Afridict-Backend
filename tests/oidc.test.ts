import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { oidcAuthenticator } from '../src/identity/auth.js';
import type { Config } from '../src/platform/config.js';

describe('OIDC access token verification', () => {
  it('accepts a matching asymmetric access token and rejects tampering, audience and expiry', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const cfg: Config = { environment: 'test', host: '127.0.0.1', port: 3000,
      authMode: 'oidc', issuer: 'https://issuer.example', audience: 'afridict-api',
      jwksUrl: 'https://issuer.example/jwks', corsOrigins: [], docs: false, logger: false };
    const verifier = oidcAuthenticator(cfg, async () => publicKey);
    const now = Math.floor(Date.now() / 1000);
    const sign = (audience: string, expiry: number) => new SignJWT({ sub: 'synthetic-subject', iat: now })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(cfg.issuer!).setAudience(audience).setExpirationTime(expiry).sign(privateKey);
    const valid = await sign(cfg.audience!, now + 3600);
    expect((await verifier.verify(valid)).subject).toBe('synthetic-subject');
    await expect(verifier.verify(valid.slice(0, -2) + 'xx')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(verifier.verify(await sign('other-api', now + 3600))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(verifier.verify(await sign(cfg.audience!, now - 100))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
