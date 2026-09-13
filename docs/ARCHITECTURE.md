# System architecture

Afridict combines financial infrastructure with generalized prediction-market infrastructure. Binary, categorical, and scalar markets share one governed model. The planned execution stack is a deterministic CLOB, a bounded protocol AMM backstop, and institutional RFQ. Robinhood Chain is the committed settlement network.

```mermaid
flowchart LR
  Clients[Consumer, admin and developer clients] --> API[Fastify modular monolith]
  API --> PG[(PostgreSQL workflows)]
  API --> Ledger[(Append-only double-entry ledger)]
  API --> Outbox[Transactional outbox/inbox]
  API --> Providers[Identity, payment and evidence ports]
  API --> Chain[Robinhood Chain adapters]
  Chain --> Finalized[Finalized collateral and ownership]
  Providers --> Recon[Reconciliation and exceptions]
  Ledger --> Recon
  Finalized --> Recon
```

## Authoritative state

| Fact | Authority |
| --- | --- |
| Authentication | Configured OIDC issuer and verified immutable subject |
| Roles and capability decisions | Afridict PostgreSQL policy records |
| Contact possession | Afridict normalized timestamps backed by Twilio Verify results |
| Identity-document status | Afridict normalized state backed by Persona |
| Operational workflows | PostgreSQL state machines |
| Off-chain money | Append-only Afridict double-entry ledger |
| Orders and matches | Future deterministic CLOB journal |
| External NGN payment state | Future reconciled SwervPay records |
| Final collateral and outcome ownership | Finalized Robinhood Chain state |
| Market outcome | Governed evidence/resolution record plus chain finalization |

Read models, caches, partner webhooks, RPC responses, indexers, and transaction hashes are observations. They do not replace these authorities. Differences create owned reconciliation exceptions.

## Security and integrity

All financial values use explicit assets and integer minor units. Journals balance per asset and remain append-only. One owner/asset lock serializes reservations across withdrawals and future CLOB, AMM, and RFQ paths. Commands use idempotency records, privileged actions produce audit and outbox events, and production runs with a restricted database role.

Provider SDKs and payloads terminate at adapter boundaries. Domain modules use normalized Afridict types. Secrets, OTPs, raw KYC documents, and customer data are excluded from logs, examples, analytics, and general events.

The modular monolith is intentional. Services are extracted only for measured latency, fault isolation, security, scaling, deployment, or ownership needs. Deterministic matching may become a separate service when workload evidence justifies it.
