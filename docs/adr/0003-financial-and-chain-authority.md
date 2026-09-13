# ADR 0003: Separate ledger, workflow, and chain authority

Status: accepted.

PostgreSQL owns operational workflows. The append-only double-entry ledger owns off-chain financial records. Finalized Robinhood Chain state owns on-chain collateral and settled outcome ownership. Partner webhooks, RPC responses, transaction hashes, and indexers are observations that require configured finality and reconciliation.

Editable wallet balances and webhook-driven credits were rejected because retries, reordering, provider errors, and reorgs can create duplicate or unsupported money. Balances are projections from ledger entries; mismatches become explicit exceptions and corrections use new journals.
