# Development setup

Use Node.js 22.16–24. Install dependencies with `npm ci`.

## Synthetic demo

Run `npm run demo`, then open `http://127.0.0.1:3000/docs`. Data is synthetic and ephemeral. Production mode rejects demo authentication and synthetic finance.

## PostgreSQL

Set `POSTGRES_PASSWORD` locally and run `docker compose up -d postgres`. Copy `.env.example` to `.env`; `.env` is ignored. Supply `DATABASE_URL`, OIDC issuer/audience/JWKS values, and exact CORS origins. Run `npm run db:migrate`, then `npm run dev`.

Migrations are checksum protected. Never edit an applied migration; add a new migration. Use a privileged migration role separately from the restricted runtime role described in `ops/runtime-grants.sql`.

## Authentication and providers

Email/password and Google sign-in remain disabled until one OIDC provider is selected and configured. Google uses Authorization Code with PKCE; provider subjects, not email addresses, identify accounts. Twilio Verify requires its service SID, API key SID, API key secret, and a separate abuse-hash key. Leave all values blank when the integration is disabled.

Never commit `.env`, keys, tokens, customer records, production URLs containing credentials, or copied provider responses containing personal data.
