# ADR 0012: Ring-fenced NGN and USDT wallet conversion

Status: accepted for implementation; production activation requires finance, custody, provider, legal and security approval.

## Context

Afridict needs separate NGN and USDT wallet balances and an explicit conversion flow so customers can fund in one asset and trade markets collateralized in another. A generic USD balance would hide the actual crypto asset, network, contract and precision. SwervPay publicly documents NGN payment services and an FX-rate operation, but the current integration evidence does not establish that it executes Afridict's NGN/USDT conversion or provides the immutable identity needed for ledger posting.

## Decision

The crypto wallet asset is `USDT_BSC`: USDT on BNB Smart Chain, chain ID 56, contract `0x55d398326f99059ff775485246999027b3197955`, with 18 decimals. The asset and token registry entry ship unapproved. Production approval requires custody and token diligence. Clients may label this wallet **USD (USDT)** but must retain the exact asset identity.

Finance publishes append-only rational rate snapshots for `NGN -> USDT_BSC` and `USDT_BSC -> NGN`. A rate is integer numerator and denominator, a fee in basis points, a source-asset minimum, evidence, and an expiry. SwervPay may be cited as rate evidence only after validation; it is not assumed to execute conversion.

A customer quote copies the rate, fee, exact source amount and floor-rounded destination amount and expires after at most 30 seconds. Creating a quote reserves nothing. Acceptance locks both customer assets and both treasury inventories in sorted order, verifies the quote and balances, then commits one source-asset journal and one destination-asset journal in the same database transaction. Both journals reference one immutable conversion trade. A retry uses the command idempotency contract; concurrent acceptance creates one trade.

The treasury uses a distinct `conversion_inventory` ledger bucket per asset. Funding that bucket recognizes externally safeguarded value and requires a finance role, reason, evidence and audit event. It does not initiate a bank or blockchain transfer. Conversion stops when destination inventory is insufficient. Treasury exposure, rate sourcing and rebalancing remain operational responsibilities.

## Consequences

- No cross-asset journal is treated as balanced; each asset conserves independently.
- Exact integer arithmetic avoids floating-point money and makes rounding reproducible.
- Source fees remain in source-asset inventory and are visible in the accepted quote.
- A quote is a price promise for a short interval, not a funds reservation.
- Real conversion remains disabled while either asset or the required operational controls are unapproved.
- Multi-currency market admission can later select the required collateral asset without silently converting during order placement.
