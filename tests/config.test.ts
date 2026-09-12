import { describe, expect, it } from 'vitest';
import { config } from '../src/platform/config.js';

describe('deployment safety', () => {
  it('fails closed without OIDC configuration', () => expect(() => config({ NODE_ENV: 'production' })).toThrow());
  it('never enables demo authentication in production or on a public bind', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'demo' })).toThrow();
    expect(() => config({ NODE_ENV: 'development', AUTH_MODE: 'demo', HOST: '0.0.0.0' })).toThrow();
  });
  it('requires exact HTTPS origins in production', () => {
    expect(() => config({ NODE_ENV: 'production', AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://issuer.example',
      OIDC_AUDIENCE: 'api', OIDC_JWKS_URL: 'https://issuer.example/jwks', CORS_ORIGINS: 'http://localhost:5173' })).toThrow();
  });
});
