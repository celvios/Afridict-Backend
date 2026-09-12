CREATE TABLE financial_assets (
  code text PRIMARY KEY,
  scale integer NOT NULL CHECK (scale BETWEEN 0 AND 36),
  synthetic boolean NOT NULL DEFAULT false,
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  bucket text NOT NULL CHECK (bucket IN ('escrow_asset', 'user_available', 'user_reserved',
    'user_withdrawal_pending', 'protocol_fee', 'reconciliation_suspense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((bucket LIKE 'user_%') = (owner_id IS NOT NULL)),
  CHECK ((bucket = 'escrow_asset' AND normal_side = 'debit') OR
    (bucket <> 'escrow_asset' AND normal_side = 'credit'))
);
CREATE UNIQUE INDEX ledger_account_identity ON ledger_accounts (owner_id, asset_code, bucket) NULLS NOT DISTINCT;

CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY,
  effect_id text NOT NULL UNIQUE,
  asset_code text NOT NULL REFERENCES financial_assets(code),
  kind text NOT NULL CHECK (kind IN ('deposit_finalized', 'reservation_held', 'reservation_released',
    'reservation_consumed', 'withdrawal_held', 'withdrawal_finalized', 'financial_correction')),
  reference_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  debit numeric(78,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(78,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX ledger_entries_account ON ledger_entries(account_id, journal_id);
CREATE INDEX ledger_entries_journal ON ledger_entries(journal_id);

CREATE FUNCTION enforce_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count bigint;
DECLARE difference numeric;
DECLARE wrong_asset bigint;
BEGIN
  SELECT count(*), COALESCE(sum(e.debit - e.credit),0),
         count(*) FILTER (WHERE a.asset_code <> j.asset_code)
  INTO entry_count, difference, wrong_asset
  FROM ledger_entries e
  JOIN ledger_accounts a ON a.id = e.account_id
  JOIN ledger_journals j ON j.id = e.journal_id
  WHERE e.journal_id = NEW.id;
  IF entry_count < 2 OR difference <> 0 OR wrong_asset <> 0 THEN
    RAISE EXCEPTION 'Journal % is not balanced for one asset', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_journal_at_commit AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();

CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER entry_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER account_identity_immutable BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE collateral_reservations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  purpose text NOT NULL CHECK (purpose IN ('clob', 'amm', 'rfq', 'withdrawal')),
  reference_id text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  consumed numeric(78,0) NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  released numeric(78,0) NOT NULL DEFAULT 0 CHECK (released >= 0),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','partially_consumed','consumed','release_pending','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purpose, reference_id),
  CHECK (consumed + released <= amount)
);

CREATE TABLE financial_exceptions (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  reference_id text NOT NULL,
  asset_code text REFERENCES financial_assets(code),
  expected_minor numeric(78,0),
  observed_minor numeric(78,0),
  severity text NOT NULL CHECK (severity IN ('warning','material','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  owner_ref text NOT NULL,
  details_code text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (scope, reference_id, details_code)
);

CREATE TABLE smart_accounts (
  owner_id uuid PRIMARY KEY REFERENCES accounts(id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  address text NOT NULL CHECK (address ~ '^0x[a-f0-9]{40}$'),
  status text NOT NULL CHECK (status IN ('provisioning','active','recovery_pending','suspended')),
  recovery_policy_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address)
);

CREATE TABLE deposit_intents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  target_minor numeric(78,0) NOT NULL CHECK (target_minor > 0),
  rail text NOT NULL,
  beneficiary_ref text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_partner' CHECK (state IN
    ('awaiting_partner','partner_confirmed','chain_observed','reconciled_available','expired','exception')),
  partner_id text,
  partner_reference text,
  partner_minor numeric(78,0),
  chain_observation_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, partner_reference)
);

CREATE TABLE partner_events (
  partner_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, event_id)
);

CREATE TABLE chain_observations (
  id uuid PRIMARY KEY,
  economic_effect_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('deposit_finalized','withdrawal_finalized')),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[a-f0-9]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[a-f0-9]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  account_address text NOT NULL CHECK (account_address ~ '^0x[a-f0-9]{40}$'),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  finality_policy_ref text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, block_hash, transaction_hash, log_index),
  UNIQUE (economic_effect_id)
);
ALTER TABLE deposit_intents ADD CONSTRAINT deposit_chain_observation
  FOREIGN KEY (chain_observation_id) REFERENCES chain_observations(id);

CREATE TABLE withdrawals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES collateral_reservations(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  destination_ref text NOT NULL,
  rail text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN
    ('reserved','submitted','uncertain','finalized','cancelled','exception')),
  provider_reference text UNIQUE,
  chain_observation_id uuid UNIQUE REFERENCES chain_observations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  status text NOT NULL CHECK (status IN ('balanced','exceptions_opened')),
  escrow_ledger_minor numeric(78,0) NOT NULL,
  chain_net_minor numeric(78,0) NOT NULL,
  partner_deposits_minor numeric(78,0) NOT NULL,
  finalized_deposits_minor numeric(78,0) NOT NULL,
  user_claims_minor numeric(78,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER partner_event_append_only BEFORE UPDATE OR DELETE ON partner_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER chain_observation_append_only BEFORE UPDATE OR DELETE ON chain_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER reconciliation_run_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
