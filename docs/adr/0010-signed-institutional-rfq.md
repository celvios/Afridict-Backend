# ADR 0010: Signed institutional RFQ execution

Status: accepted and implemented for isolated synthetic execution. Production activation is not approved.

## Context

Institutional counterparties need negotiated prices without placing their interest in the public order book. A caller-provided dealer name or `signed` flag cannot establish quote authority, and reserving only one side at quote time either creates unnecessary collateral holds or permits an unbacked acceptance. RFQ exposure must also share the same balance authority as CLOB, AMM, and withdrawals.

## Decision

Compliance officers create institutional entities with immutable per-market exposure limits. A second compliance officer activates each entity. Memberships are append-only and assign an account as a requester or dealer. Every dealer membership binds one approved Ed25519 SPKI public key and its SHA-256 fingerprint.

A requester creates an expiring direction, outcome, and quantity. A dealer signs the exact UTF-8 serialization produced by `rfqSigningPayload`: numeric version 1 followed by string request ID, canonical integer price, normalized UTC expiry, and nonce. The service verifies the signature and persists the signature, key fingerprint, payload hash, and economic fields. The nonce is unique per dealer entity.

Acceptance locks the market and both owner/asset authorities, then rechecks market time, jurisdiction, eligibility, memberships, entity status, quote expiry, and both exposure limits. It reserves both counterparties, moves the exact complementary collateral into market escrow, posts additive fees, creates one immutable fill and sequenced event, and terminally rejects competing quotes in one transaction. RFQ fills use the same portfolio, governed redemption, reconciliation, and testnet settlement paths as other executions.

## Consequences

Quotes are attributable and independently verifiable from stored material. Dealer private keys stay outside Afridict. Quote creation does not hold collateral; acceptance can therefore fail cleanly if either balance or policy changed. The conservative entity exposure rule counts full fixed payout exposure without cross-outcome netting. Key rotation, entity suspension workflows, institutional credit, bilateral netting, external legal agreements, and production key custody remain future governed work.
