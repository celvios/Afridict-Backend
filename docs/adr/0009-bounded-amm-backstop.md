# ADR 0009: Bounded AMM backstop risk model

Status: accepted and implemented for isolated synthetic execution. Production activation is not approved.

## Context

The primary synthetic CLOB may have insufficient depth. An AMM backstop needs a deterministic price and an explicit treasury liability before it can fill an order. A price chosen by a client, an unreserved subsidy, or floating-point rounding would permit unbacked or unfair execution. Generalized categorical and scalar payout vectors make automatic netting across outcomes unsafe without a reviewed worst-case proof.

## Decision

The initial AMM model quotes one fully collateralized share against a server-owned reference price. The quote applies a bounded adverse price impact proportional to requested quantity and the approved inventory limit. All calculations use exact integers. A buy price increases and a sell price decreases; both must satisfy the caller's limit price and the policy's maximum slippage. The buyer and seller collateral together equal the fixed payout of 1,000,000 minor units per share. Fees are additive and do not reduce reserved collateral.

The AMM's own collateral for every quote is conservatively counted in full against both its subsidy commitment and worst-case loss budget. Exposure is cumulative without netting opposite sides or different outcomes. The preview refuses inventory, subsidy, loss, price-scale, uint256, or slippage breaches. Execution locks the trading market, pool, quote, and owner/asset reservation authority; reserves user collateral; consumes treasury collateral; appends balanced journals; advances the market event sequence; and updates exposure in one database transaction. A quote preview alone does none of those things.

The reference price must come from an approved, fresh, server-side price source. Neither a client-supplied price nor the current book midpoint is automatically approved as a fair oracle. The implemented routes are limited to the isolated synthetic demo and reject production configuration.

## Consequences

The conservative exposure rule uses more subsidy than an optimized multi-outcome AMM, but avoids relying on unproven payout offsets. Executed quotes become portfolio positions and immutable redemption inputs; user payouts can enter the existing testnet settlement manifest. Reconciliation counts the remaining liquidity reserve as a custody liability. Production activation still requires an approved external reference-price adapter, real treasury authority, custody, legal, market-integrity, operational review, and combined CLOB/AMM/RFQ/withdrawal load testing.
