# Implementation inventory and PR plan

Reviewed 13 September 2026 against repository files, all eight commits on `main`, local changes, remote branches, tests, migrations, provider ports, documentation, and GitHub PR/issue state. No frontend directory or frontend implementation exists in this repository. Existing commits are already shared on `main`; they will not be destructively rewritten. `backup/pre-pr-restructure` preserves the pre-PR-restructure head.

## Current implementation

| Area | Status | Evidence and remaining work |
| --- | --- | --- |
| Project foundation | COMPLETE | Fastify/TypeScript, PostgreSQL, migrations, CI, Docker, config and OpenAPI generation |
| Frontend architecture | NOT STARTED | Frontend directory was removed at owner request; API types and handoff exist |
| Design system | NOT STARTED | No UI assets or components in this backend repository |
| Authentication | PARTIAL | OIDC token verification and Google/password discovery exist; identity provider, sessions and recovery are unselected |
| Registration | PARTIAL | Normalized profile and consent capture exist; upstream credential registration is pending |
| Email verification | PARTIAL | Provider port exists; persisted workflow is PR #1; production Twilio/SendGrid configuration unvalidated |
| Phone verification | PARTIAL | E.164 normalization and Twilio port exist; persisted workflow is PR #1 |
| Twilio | PARTIAL | Verify adapter and tests exist; credentials, service policy, monitoring and production validation remain |
| SendGrid | NOT STARTED | Transactional email port only; adapter, outbox worker, domain authentication and event processing absent |
| Persona | NOT STARTED | Normalized interface only; adapter, inquiry/session, signed webhooks and ordering absent |
| Capability model | PARTIAL | Fail-closed action decisions exist; production action gates and policy registries remain |
| Wallet architecture | PARTIAL | Ledger buckets and projections exist for generic assets; required NGN/USD separation absent |
| Double-entry ledger | COMPLETE | Balanced append-only journals, exact integer amounts and mutation guards are tested; production accounting approval remains a gate |
| NGN wallet / USD wallet | NOT STARTED | No authoritative currency-specific accounts or projections |
| SwervPay | NOT STARTED | No adapter or validated provider contract |
| NGN deposits / withdrawals | NOT STARTED | Existing workflows are explicitly synthetic generic collateral flows |
| Bank resolution / payment methods | NOT STARTED | No domain model or API |
| Markets | PARTIAL | Generalized definitions, governance, evidence policy and publication exist; opening/trading lifecycle absent |
| CLOB / orderbook | NOT STARTED | No order journal, sequencing or matching engine |
| Collateral reservation | PARTIAL | Shared owner/asset reservation authority exists; order fill/cancel transitions absent |
| Positions / portfolio | NOT STARTED | Balance and statement reads exist; positions and valuation do not |
| Settlement | PARTIAL | Synthetic finalized deposit/withdrawal journals exist; trade batches and contracts absent |
| Robinhood Chain | PARTIAL | Smart-account and finality observation schemas exist; RPC, signing, indexing and reorg adapters absent |
| Crypto deposits / withdrawals | PARTIAL | Synthetic generic workflows only; real chain rails absent |
| Realtime | NOT STARTED | No WebSocket feeds or resume protocol |
| Notifications | NOT STARTED | Transactional outbox primitive exists; no delivery workers/providers |
| Transaction history | PARTIAL | User ledger statement endpoint exists; normalized cross-domain transaction model absent |
| Admin | PARTIAL | Market/compliance governance and audit endpoints exist; finance/resolution/operations consoles incomplete |
| Reconciliation | PARTIAL | Stored ledger/partner/chain comparison and exceptions exist; independent provider/chain sources absent |
| Audit logging | COMPLETE | Append-only attributable audit and outbox records cover implemented privileged workflows |
| Tests | PARTIAL | Money balance, duplicate webhook, concurrent withdrawal and governance tests exist; CLOB, resolution, chain and provider failure suites remain |
| Observability | PARTIAL | Request IDs and safe logs exist; metrics, traces, alerts and SLOs absent |
| Documentation | PARTIAL | Architecture/setup/ADRs are PR #9; runbooks and API lifecycle policy remain |

## Existing commit classification

| Commit | Substantial work |
| --- | --- |
| `acada8c` | Initial OpenAPI contract |
| `43957b8` | Service foundation, identity/eligibility, market governance, CI, migrations and financial reference model |
| `3a80d6c` | Audited external market-proposal rejection |
| `d7fc08c` | Ledger, reservations, synthetic funding/finality and reconciliation |
| `8346c66` | Account assurance and capability policy |
| `26ed0e3` | Federated password/Google authentication discovery |
| `b2e514d` | Contact provider ports, Twilio Verify adapter and phone normalization |
| `0eaa35a` | Registration profile and policy acceptance |

`43957b8` spans several domains, but it is already public and shared. Rewriting it would damage the real commit history. New work uses focused branches and PRs.

## Meaningful PR sequence

| PR | Proposed title | Existing work included | Missing work | Dependency | Risk |
| --- | --- | --- | --- | --- | --- |
| #1 | `feat(auth): add resilient contact verification workflows` | Provider ports, profile, assurance | Production calibration and durable dispatch worker | Current main | Provider timeout ambiguity |
| #9 | `docs: define Afridict architecture and operating model` | Architecture behind all current commits | Runbooks evolve with implementation | Current main | Documentation drift |
| 3 | `feat(identity): integrate Persona identity lifecycle` | Assurance and capability model | Adapter, inquiry session, signed/reordered webhooks | Current main | KYC privacy and event ordering |
| 4 | `feat(wallet): introduce separate NGN and USD accounting` | Ledger and reservation core | Currency-specific accounts/projections and accounting approval | Ledger core | Competing balance authority |
| 5 | `feat(payments): integrate SwervPay NGN rails` | Funding state-machine patterns | Provider contract, bank resolution, deposits, payouts, reconciliation | PR 3 and 4 | Unknown commercial/provider semantics |
| 6 | `feat(trading): add collateralized deterministic CLOB` | Markets and shared reservations | Orders, journal, matcher, positions and races | PR 4 | Overspend or nondeterminism |
| 7 | `feat(resolution): add governed finalization and redemption` | Published evidence policies | Proposals, disputes, adjudication, payout conservation | PR 6 | Unauthorized/incorrect payouts |
| 8 | `feat(settlement): integrate Robinhood Chain finality` | Observation/finality schemas | Multi-RPC, submission, indexing, reorg and batches | PR 6 and 7 | Premature settlement |
| 9 | `test(platform): harden recovery and operational assurance` | Current invariant/reconciliation tests | Failure injection, load, surveillance and DR drills | Prior domain PRs | Hidden cross-domain failures |

PR numbers 3–9 in this table are sequence labels until GitHub assigns numbers. Each will be created only when it contains independently reviewable implementation and tests; no empty or cosmetic PRs will be manufactured.
