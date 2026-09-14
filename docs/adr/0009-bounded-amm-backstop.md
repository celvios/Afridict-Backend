# ADR 0009: Bounded AMM backstop risk model

Status: accepted for non-executable synthetic quote mathematics. Trading activation is not approved.

## Context

The primary synthetic CLOB may have insufficient depth. An AMM backstop needs a deterministic price and an explicit treasury liability before it can fill an order. A price chosen by a client, an unreserved subsidy, or floating-point rounding would permit unbacked or unfair execution. Generalized categorical and scalar payout vectors make automatic netting across outcomes unsafe without a reviewed worst-case proof.

## Decision

The initial AMM model quotes one fully collateralized share against a server-owned reference price. The quote applies a bounded adverse price impact proportional to requested quantity and the approved inventory limit. All calculations use exact integers. A buy price increases and a sell price decreases; both must satisfy the caller's limit price and the policy's maximum slippage. The buyer and seller collateral together equal the fixed payout of 1,000,000 minor units per share. Fees are additive and do not reduce reserved collateral.

The AMM's own collateral for every quote is conservatively counted in full against both its subsidy commitment and worst-case loss budget. Exposure is cumulative without netting opposite sides or different outcomes. The preview refuses inventory, subsidy, loss, price-scale, uint256, or slippage breaches. A later execution path must lock the market and owner/asset reservation authority, reserve treasury and user collateral, append balanced journals, and update exposure in one database transaction. Quote preview alone does none of those things.

The reference price must come from an approved, fresh, server-side price source. Neither a client-supplied price nor the current book midpoint is automatically approved as a fair oracle. No AMM route or real treasury funding is enabled by this decision.

## Consequences

The conservative exposure rule uses more subsidy than an optimized multi-outcome AMM, but avoids relying on unproven payout offsets. Before executable synthetic AMM admission, approve the reference-price source and freshness policy, treasury account and authority, quote expiry and replay semantics, market event ordering, halt behavior, reconciliation treatment, and combined CLOB/AMM/RFQ/withdrawal concurrency tests. Production activation additionally requires custody, legal, market-integrity and operational approval.
