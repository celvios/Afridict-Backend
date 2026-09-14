# Robinhood Chain testnet settlement setup

The repository contains a testnet-only settlement contract and backend integration boundary. No contract has been deployed or funded by this code, and the running API does not configure a signer by default. Mainnet settlement remains disabled.

## Local verification

Use Node.js 22.16 or later and install the locked dependencies with `npm ci`. Run `npm run check` to typecheck, lint, test, compile the API, regenerate the OpenAPI schema and validate it. The contract test compiles `contracts/AfridictSettlement.sol` with the pinned Solidity compiler and compares its `commitBatch` ABI with the backend encoder. `tests/resolution-api.test.ts` uses an injected signer and two independent observer fakes; it does not broadcast a transaction. Set `TEST_DATABASE_URL` to a dedicated database named `afridict_test` to run that suite against PostgreSQL instead of PGlite. The test creates and drops only a uniquely named schema inside that database.

## Testnet integration prerequisites

1. Security and finance approve an exact ERC-20 collateral token on Robinhood Chain testnet (chain ID 46630), its decimals, custody model, funding source and claim policy. This contract assumes a standard non-rebasing, non-fee-on-transfer token.
2. Deploy `AfridictSettlement` with the approved token address, a dedicated operator address and a distinct guardian address. Verify the source and constructor arguments on the testnet explorer. Keep the operator key in an externally managed signer; do not place a private key in the API configuration or repository.
3. Record the contract address, collateral token address, hash of deployed runtime bytecode, approved finality-policy reference, confirmation depth and at least two independent named RPC observers in `chain_settlement_bindings`. Insert an approved binding only after code and token identity have been independently checked. Public Robinhood RPC endpoints are rate-limited and are unsuitable as both production observers.
4. Wire a signer that implements `SettlementSubmitter.submit` and `lookup` with durable idempotency for `settlement:<batch-id>:<attempt>`. The `lookup` method must resolve a timeout before another attempt may be made. Wire two or more `RobinhoodRpcObserver` instances through `SettlementDependencies` when building the application. The default server intentionally leaves this dependency absent.
5. Fund the deployed contract with enough approved collateral to cover all outstanding batch liabilities before calling `commitBatch`. The contract refuses commitments that exceed its actual token balance. This funding must reconcile with the off-chain ledger and cannot be inferred from the database alone.

## Workflow

A finance operator prepares a batch with `POST /v1/admin/markets/{id}/settlement-batches` after governed finalization and ledger redemption. Preparation includes at most 100 positive payouts and fixes every recipient smart account, amount, Merkle root and exact calldata. Submit it with `POST /v1/admin/settlement-batches/{id}/submit`, then call `POST /v1/admin/settlement-batches/{id}/refresh` until the independent observer quorum and approved confirmation depth are satisfied. A timeout is `uncertain`, not a failure. Reverted or reorged attempts enter `exception`; inspect them before replacement.

The authenticated owner reads `GET /v1/markets/{id}/settlement-claims`. When `claim_ready` is true, the client may call `claim(batch_key,item_index,recipient_address,amount_minor,proof)` on the published `contract_address` with a Robinhood Chain testnet wallet. Anyone can relay a valid proof, but the contract always transfers to the fixed recipient address in the leaf. The response shows a claim proof, not an on-chain claim status; a claim-event indexer and contract/ledger reconciler remain required for production.

Network values are documented by [Robinhood Chain](https://docs.robinhood.com/chain/connecting/). The [ADR](adr/0007-robinhood-chain-claim-settlement.md) records the finality and trust assumptions.
