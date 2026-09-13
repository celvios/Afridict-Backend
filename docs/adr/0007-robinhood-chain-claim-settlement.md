# ADR 0007: Robinhood Chain claim settlement and observed finality

Status: accepted for testnet integration. Mainnet activation and contract deployment are not approved.

## Context

The off-chain CLOB and governed resolver produce exact, immutable payout records. A transaction hash alone does not prove that the approved contract received the intended batch, succeeded, remained canonical, or was backed by enough collateral. Robinhood Chain is EVM-compatible and publishes chain IDs 46630 for testnet and 4663 for mainnet. Its public RPC is rate-limited and is not recommended for production. The network documentation does not define an application-specific confirmation count that Afridict can safely treat as universal finality.

## Decision

Afridict prepares at most 100 positive payouts per settlement batch. Each leaf is `sha256(abi.encodePacked(batchKey,index,recipient,amount))`; `batchKey` is the SHA-256 hash of the opaque batch UUID. Sorted-pair SHA-256 proofs avoid dependence on client ordering and use the EVM SHA-256 precompile. The database stores every leaf and proof, the root, exact `commitBatch` calldata, calldata hash, finalized resolution hash, total and recipient smart account. A unique fill-and-side constraint prevents a payout from entering two batches.

`AfridictSettlement` is an immutable, asset-specific claim contract. An operator may commit a batch only once and only while the contract is unpaused. The contract refuses commitments whose total would exceed its token balance plus existing liabilities. A separate guardian may pause commitments and claims but cannot change roots, recipients or amounts. Claims set their bitmap before transferring, and a reverted transfer rolls the whole call back. The operator and guardian must be different addresses.

Submission uses an injected, idempotent signer boundary. A stable signer request identifies each attempt. A timeout is recorded as `uncertain`; Afridict will not create a replacement until the signer lookup resolves whether a transaction exists. Reverted or reorged attempts may be replaced without changing the persisted calldata.

At least two distinctly named RPC observers must agree on the transaction hash, target address, exact calldata hash, successful receipt, block hash and approved runtime-code hash. The minimum observed head determines confirmation depth. The approved asset binding supplies the RPC quorum and confirmation threshold; neither is hard-coded as a statement about Robinhood Chain finality. Later disagreement disables claims and opens an exception. Testnet is the only permitted chain in this release.

The claim API returns proof material only to the authenticated owner of the bound smart account. It marks a proof ready only after the batch reaches observed finality. An on-chain claim transfers collateral to that fixed recipient even if another address submits the proof.

## Consequences and remaining gates

This design separates outcome finality, transaction submission, observed chain finality and user claiming. The generated OpenAPI contract exposes these states directly to admin and consumer clients. Database settlement remains a projection and does not itself move tokens.

Production still requires audited deployments, approved collateral-token addresses, institutional signer and guardian custody, two production-grade RPC providers, L1 assertion/finality monitoring, claim-event indexing, ledger-to-contract reconciliation, deployment verification, adversarial EVM tests and incident runbooks. Fee-on-transfer and rebasing tokens are not supported. No mainnet binding is seeded, no private key is accepted by the API, and no deployment transaction is included.

## References

- Robinhood Chain network configuration: https://docs.robinhood.com/chain/connecting/
- Robinhood Chain contract deployment guidance: https://docs.robinhood.com/chain/deploy-smart-contracts/
- Robinhood Chain node and BoLD information: https://docs.robinhood.com/chain/run-a-full-node/
