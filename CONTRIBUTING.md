# Contributing to Afridict Backend

Afridict is financial and prediction-market infrastructure. Changes must preserve exact accounting, deterministic state transitions, idempotent commands, explicit authority boundaries, and safe failure behavior.

## Local setup

Install Node.js 22.16–24 and npm. A synthetic environment needs no external credentials:

```bash
npm ci
npm run demo
```

For PostgreSQL integration, copy `.env.example` to the untracked `.env` file, choose a local-only `POSTGRES_PASSWORD`, and set `DATABASE_URL` to the matching `afridict` connection. Then run:

```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Check `http://127.0.0.1:3000/health/ready` for database readiness and `http://127.0.0.1:3000/docs` for the rendered API contract.

## Change workflow

Create a focused branch and keep each commit reviewable. Use conventional commit subjects such as `feat(funding): ...`, `fix(trading): ...`, or `test: ...`. Pair behavior changes with tests that prove the affected invariant. Avoid mixing formatting, unrelated refactors, and behavior in one commit.

Open a pull request that states the triggering problem, the resulting behavior, financial or security effects, migrations or contract changes, and exact validation performed. Link the owning issue when one exists. A reviewer must be able to assess a change without relying on conversation history.

Never commit credentials, private keys, provider payloads, customer data, raw identity evidence, production wallet addresses, or copied production records. Use synthetic examples and environment variable names only.

## Required verification

Run these commands from a clean working tree:

```bash
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run api:check
npm run api:lint
npm audit --omit=dev --audit-level=high
```

CI runs the same gates against PostgreSQL. Coverage floors are enforced in `vitest.config.ts`. Generated changes to `api/openapi.json` and `api/client-types.ts` belong in the same commit as the route or schema change.

## Financial and market changes

Tests for money movement must assert balanced journal entries, exact integer amounts, replay behavior, insufficient-funds behavior, reservation state, and rollback on failure. Concurrency-sensitive changes must run against real PostgreSQL and prove that total reservations, fills, redemptions, or settlement claims cannot exceed their authority.

Market changes must preserve immutable published policy hashes, independent review requirements, trading cutoffs, deterministic matching priority, evidence references, resolution quorum, and idempotent redemption. External webhook or chain observations never become financial authority without the documented verification and reconciliation step.

Document durable design choices in `docs/adr/`. Update the OpenAPI descriptions whenever frontend recovery behavior, authorization, state vocabulary, idempotency, or error handling changes.
