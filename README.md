# Afridict Backend

Afridict is financial and prediction-market infrastructure for Africa-first event markets. This repository contains the transactional backend foundation: identity and capability policy, governed generalized markets, append-only double-entry accounting, collateral reservations, funding workflows, reconciliation, audit records, and versioned OpenAPI contracts. It is not a standalone betting application.

The current implementation is a production-shaped modular monolith with an isolated synthetic demo. Real trading, real payments, custody activation, market resolution, and Robinhood Chain settlement remain disabled until their provider, legal, security, finance, and operational gates are approved.

## Run locally

Requirements: Node.js 22.16–24 and npm. For the synthetic environment:

```bash
npm ci
npm run demo
```

Open `http://127.0.0.1:3000/docs`. The demo binds to loopback, resets its embedded PostgreSQL database on restart, and uses synthetic `demo.<persona>` selectors. Never expose it publicly.

For PostgreSQL development, copy `.env.example` to an untracked `.env`, set a local `POSTGRES_PASSWORD`, then run:

```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
```

OIDC configuration has no default credentials. Twilio Verify is disabled unless every required server-side value is supplied. Keep all secrets in the environment or an approved secret manager.

Structured JSON logging is enabled outside tests. Optional Sentry error reporting is enabled only by an HTTPS `ERROR_TRACKING_DSN`; reports are sanitized and contain no request body, authenticated user, provider payload, or original exception message.

## Verification

```bash
npm run check
npm run test:coverage
npm run api:check
npm audit --omit=dev --audit-level=high
```

`npm run check` runs type checking, lint, tests, build, OpenAPI generation, and contract validation. `npm run test:coverage` enforces the measured statement, branch, function, and line floors. GitHub Actions exposes each gate separately, runs integration tests against PostgreSQL, audits production dependencies, and Dependabot proposes grouped dependency updates.

## Contracts and architecture

- `api/openapi.json` is the generated OpenAPI 3.1 HTTP contract.
- `api/client-types.ts` contains generated TypeScript client types.
- `docs/ARCHITECTURE.md` explains system boundaries and data authority.
- `docs/IMPLEMENTATION_INVENTORY.md` records completed, partial, and missing work plus the PR sequence.
- `docs/adr/` records durable architecture decisions.
- `docs/DELIVERY_PLAN.md` records implementation order and activation gates.

Financial amounts cross APIs as exact integer strings. Clients must reuse the same idempotency key and body when retry behavior permits it, treat pending/uncertain states explicitly, and never infer settlement from a webhook or transaction hash.
