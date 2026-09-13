CREATE TABLE chain_settlement_bindings (
  asset_code text PRIMARY KEY REFERENCES financial_assets(code),
  chain_id bigint NOT NULL CHECK (chain_id IN (4663,46630)),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[a-f0-9]{40}$'),
  collateral_token_address text NOT NULL CHECK (collateral_token_address ~ '^0x[a-f0-9]{40}$'),
  contract_code_hash text NOT NULL CHECK (contract_code_hash ~ '^0x[a-f0-9]{64}$'),
  finality_policy_ref text NOT NULL,
  confirmations integer NOT NULL CHECK (confirmations BETWEEN 1 AND 1000000),
  observer_quorum integer NOT NULL CHECK (observer_quorum BETWEEN 2 AND 10),
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  UNIQUE (chain_id,contract_address)
);

CREATE TABLE settlement_batches (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES resolution_cases(market_id),
  asset_code text NOT NULL REFERENCES chain_settlement_bindings(asset_code),
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  resolution_hash text NOT NULL CHECK (resolution_hash ~ '^[a-f0-9]{64}$'),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^0x[a-f0-9]{64}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  calldata text NOT NULL CHECK (calldata ~ '^0x[a-f0-9]+$'),
  calldata_hash text NOT NULL CHECK (calldata_hash ~ '^0x[a-f0-9]{64}$'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  total_minor numeric(78,0) NOT NULL CHECK (total_minor > 0),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN
    ('prepared','submitted','confirmed','finalized','exception')),
  current_submission_id uuid,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id,manifest_hash)
);

CREATE TABLE settlement_batch_items (
  batch_id uuid NOT NULL REFERENCES settlement_batches(id),
  item_index integer NOT NULL CHECK (item_index BETWEEN 0 AND 99),
  fill_id uuid NOT NULL REFERENCES resolution_redemptions(fill_id),
  payout_side text NOT NULL CHECK (payout_side IN ('buyer','seller')),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[a-f0-9]{40}$'),
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^0x[a-f0-9]{64}$'),
  merkle_proof jsonb NOT NULL,
  PRIMARY KEY (batch_id,item_index),
  UNIQUE (fill_id,payout_side),
  CHECK (jsonb_typeof(merkle_proof)='array')
);

CREATE TABLE settlement_submissions (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES settlement_batches(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  signer_request_id text NOT NULL UNIQUE,
  transaction_hash text CHECK (transaction_hash ~ '^0x[a-f0-9]{64}$'),
  transaction_nonce numeric(78,0) CHECK (transaction_nonce >= 0),
  state text NOT NULL CHECK (state IN
    ('uncertain','submitted','confirmed','finalized','reverted','replaced','reorged')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id,attempt),
  UNIQUE (transaction_hash)
);

ALTER TABLE settlement_batches ADD CONSTRAINT settlement_current_submission
  FOREIGN KEY (current_submission_id) REFERENCES settlement_submissions(id);

CREATE TABLE settlement_observations (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES settlement_submissions(id),
  observer_id text NOT NULL,
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[a-f0-9]{64}$'),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[a-f0-9]{64}$'),
  head_number numeric(78,0) NOT NULL CHECK (head_number >= block_number),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[a-f0-9]{40}$'),
  calldata_hash text NOT NULL CHECK (calldata_hash ~ '^0x[a-f0-9]{64}$'),
  receipt_success boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id,observer_id,block_hash,head_number)
);

CREATE INDEX settlement_batches_market ON settlement_batches(market_id,created_at,id);
CREATE INDEX settlement_items_owner ON settlement_batch_items(owner_id,batch_id,item_index);
CREATE INDEX settlement_observations_submission ON settlement_observations(submission_id,observed_at);

CREATE TRIGGER settlement_bindings_append_only BEFORE UPDATE OR DELETE ON chain_settlement_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER settlement_items_append_only BEFORE UPDATE OR DELETE ON settlement_batch_items
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER settlement_observations_append_only BEFORE UPDATE OR DELETE ON settlement_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_settlement_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.market_id<>OLD.market_id OR NEW.asset_code<>OLD.asset_code OR
    NEW.chain_id<>OLD.chain_id OR NEW.contract_address<>OLD.contract_address OR
    NEW.resolution_hash<>OLD.resolution_hash OR NEW.merkle_root<>OLD.merkle_root OR
    NEW.manifest_hash<>OLD.manifest_hash OR NEW.calldata<>OLD.calldata OR
    NEW.calldata_hash<>OLD.calldata_hash OR NEW.item_count<>OLD.item_count OR
    NEW.total_minor<>OLD.total_minor OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR
    NOT ((NEW.state=OLD.state) OR
      (OLD.state='prepared' AND NEW.state IN ('submitted','exception')) OR
      (OLD.state='submitted' AND NEW.state IN ('confirmed','finalized','exception')) OR
      (OLD.state='confirmed' AND NEW.state IN ('finalized','submitted','exception')) OR
      (OLD.state='finalized' AND NEW.state IN ('submitted','exception')) OR
      (OLD.state='exception' AND NEW.state IN ('submitted','exception'))) THEN
    RAISE EXCEPTION 'Settlement batch identity is immutable and state transitions are monotonic';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_batch_guard BEFORE UPDATE ON settlement_batches
  FOR EACH ROW EXECUTE FUNCTION guard_settlement_batch();

CREATE FUNCTION guard_settlement_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.batch_id<>OLD.batch_id OR NEW.attempt<>OLD.attempt OR
    NEW.signer_request_id<>OLD.signer_request_id OR NEW.submitted_at<>OLD.submitted_at OR
    (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash) OR
    (OLD.transaction_nonce IS NOT NULL AND NEW.transaction_nonce IS DISTINCT FROM OLD.transaction_nonce) OR
    ((NEW.transaction_hash IS NULL)<>(NEW.transaction_nonce IS NULL)) OR
    NOT ((NEW.state=OLD.state) OR
      (OLD.state='uncertain' AND NEW.state='submitted' AND NEW.transaction_hash IS NOT NULL) OR
      (OLD.state='submitted' AND NEW.state IN ('confirmed','finalized','reverted','replaced','reorged')) OR
      (OLD.state='confirmed' AND NEW.state IN ('finalized','reorged')) OR
      (OLD.state='finalized' AND NEW.state='reorged') OR
      (OLD.state IN ('reverted','reorged') AND NEW.state='replaced')) THEN
    RAISE EXCEPTION 'Settlement submission identity is immutable and state transitions are monotonic';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_submission_guard BEFORE UPDATE ON settlement_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_settlement_submission();
