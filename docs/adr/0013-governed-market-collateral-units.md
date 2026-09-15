# ADR 0013: Governed market collateral and contract units

Status: accepted for the synthetic execution architecture; real-money activation remains approval-gated.

## Context

The original synthetic engine used one six-decimal demo asset and treated both the probability-price scale and one contract payout as 1,000,000 minor units. That equality does not hold for NGN, which has two decimals, or USDT-BSC, which has 18. Allowing an activation request to name an asset also duplicated a decision already represented by the published collateral policy.

## Decision

Each approved collateral binding maps one immutable policy reference to an exact financial asset and `contract_unit_minor`. The contract unit is the total payout for one winning share in that asset's smallest ledger unit. The probability price scale remains 1,000,000 for every asset.

Trading activation accepts no asset selection. It resolves the published market's collateral policy, verifies the binding and asset approval, and copies the asset and contract unit into the market trading record. That copy cannot change. CLOB, AMM, RFQ, resolution and redemption calculations use the copied contract unit, while all reservations and journals continue to use the copied asset code.

For a price `p`, payout unit `u`, and quantity `q`, buyer collateral is `q × floor(u × p / 1,000,000)` and seller collateral is `q × (u - floor(u × p / 1,000,000))`. Prices that round either side to zero in the asset's precision are rejected. Fees round up per share and then multiply by quantity. Buyer and seller collateral always sum to `q × u`.

A public collateral-policy endpoint returns the governed asset, asset scale, contract unit, probability scale, and trading state without exposing account data. An authenticated market-collateral endpoint adds the caller's balances and any funded caller wallet with a current direct conversion rate into the required asset. The backend selects the correct wallet automatically for orders. Currency conversion still requires a separate customer-approved quote acceptance.

## Consequences

- NGN and USDT markets can share matching semantics without sharing monetary units.
- The frontend can render exact prices and required wallet balances without guessing from a symbol.
- Market governance controls asset selection; activation cannot substitute a different asset.
- Existing demo bindings retain a 1,000,000-unit default through migration.
- Production bindings require accounting, custody, legal, market-risk and token approval before activation.
