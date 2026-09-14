ALTER TABLE collateral_reservations DROP CONSTRAINT collateral_reservations_purpose_check;
ALTER TABLE collateral_reservations ADD CONSTRAINT collateral_reservations_purpose_check
  CHECK (purpose IN ('clob','amm','rfq','withdrawal','resolution_bond'));
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN ('deposit_finalized','reservation_held','reservation_released',
    'reservation_consumed','withdrawal_held','withdrawal_finalized','financial_correction',
    'clob_execution','resolution_redemption'));
ALTER TABLE clob_events DROP CONSTRAINT clob_events_event_type_check;
ALTER TABLE clob_events ADD CONSTRAINT clob_events_event_type_check
  CHECK (event_type IN ('activated','halted','order_accepted','fill','order_cancelled',
    'resolution_proposed','resolution_challenged','resolution_finalized','redemption_batch'));

CREATE TABLE resolution_policy_bindings (
  bond_policy_ref text NOT NULL,
  payout_policy_ref text NOT NULL,
  asset_code text NOT NULL REFERENCES financial_assets(code),
  bond_minor numeric(78,0) NOT NULL CHECK (bond_minor > 0),
  invalid_payout text NOT NULL CHECK (invalid_payout='refund_recorded_collateral'),
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  PRIMARY KEY (bond_policy_ref,payout_policy_ref,asset_code)
);

-- The archived artifact is externally controlled; only its opaque location and
-- digest enter this database. Record identity and hash are append-only.
CREATE TABLE resolution_evidence (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES markets(id),
  submitted_by uuid NOT NULL REFERENCES accounts(id),
  source_name text NOT NULL,
  source_uri text NOT NULL,
  artifact_ref text NOT NULL CHECK (artifact_ref ~ '^archive:[A-Za-z0-9._/-]{1,190}$'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id,record_hash)
);
CREATE INDEX resolution_evidence_market ON resolution_evidence(market_id,created_at);
CREATE TRIGGER resolution_evidence_append_only BEFORE UPDATE OR DELETE ON resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resolution_cases (
  market_id uuid PRIMARY KEY REFERENCES markets(id),
  proposed_by uuid NOT NULL REFERENCES accounts(id),
  proposal jsonb NOT NULL,
  proposal_evidence_id uuid NOT NULL REFERENCES resolution_evidence(id),
  proposal_bond_id uuid NOT NULL UNIQUE REFERENCES collateral_reservations(id),
  proposed_at timestamptz NOT NULL,
  challenge_deadline timestamptz NOT NULL,
  timelock_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','challenged','finalized')),
  challenged_by uuid REFERENCES accounts(id),
  challenge jsonb,
  challenge_evidence_id uuid REFERENCES resolution_evidence(id),
  challenge_bond_id uuid UNIQUE REFERENCES collateral_reservations(id),
  challenged_at timestamptz,
  final_result jsonb,
  final_result_hash text CHECK (final_result_hash ~ '^[a-f0-9]{64}$'),
  finalized_by uuid REFERENCES accounts(id),
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (challenge_deadline>proposed_at AND timelock_until>challenge_deadline),
  CHECK ((state='proposed' AND challenged_by IS NULL AND final_result IS NULL) OR
    (state='challenged' AND challenged_by IS NOT NULL AND challenge IS NOT NULL AND final_result IS NULL) OR
    (state='finalized' AND final_result IS NOT NULL AND final_result_hash IS NOT NULL AND finalized_by IS NOT NULL)),
  CHECK (proposed_by IS DISTINCT FROM challenged_by)
);

CREATE TABLE resolution_ballots (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES resolution_cases(market_id),
  reviewer_id uuid NOT NULL REFERENCES accounts(id),
  decision text NOT NULL CHECK (decision IN ('proposal','challenge','recuse')),
  reason text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES resolution_evidence(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id,reviewer_id)
);
CREATE TRIGGER resolution_ballots_append_only BEFORE UPDATE OR DELETE ON resolution_ballots
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resolution_redemptions (
  fill_id uuid PRIMARY KEY REFERENCES clob_fills(id),
  market_id uuid NOT NULL REFERENCES resolution_cases(market_id),
  buyer_minor numeric(78,0) NOT NULL CHECK (buyer_minor >= 0),
  seller_minor numeric(78,0) NOT NULL CHECK (seller_minor >= 0),
  journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_minor+seller_minor>0)
);
CREATE INDEX resolution_redemptions_market ON resolution_redemptions(market_id,fill_id);
CREATE FUNCTION verify_resolution_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*1000000,m.asset_code INTO expected,market_asset
  FROM clob_fills f JOIN clob_markets m ON m.market_id=f.market_id
  WHERE f.id=NEW.fill_id AND f.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
  WHERE id=NEW.journal_id AND reference_id=NEW.fill_id::text;
  IF expected IS NULL OR NEW.buyer_minor+NEW.seller_minor<>expected OR
    case_state IS DISTINCT FROM 'finalized' OR
    journal_kind IS DISTINCT FROM 'resolution_redemption' OR
    journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'Redemption must conserve one finalized matched payout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resolution_redemption_guard BEFORE INSERT ON resolution_redemptions
  FOR EACH ROW EXECUTE FUNCTION verify_resolution_redemption();
CREATE TRIGGER resolution_redemptions_append_only BEFORE UPDATE OR DELETE ON resolution_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_resolution_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.market_id<>OLD.market_id OR NEW.proposed_by<>OLD.proposed_by OR
    NEW.proposal<>OLD.proposal OR NEW.proposal_evidence_id<>OLD.proposal_evidence_id OR
    NEW.proposal_bond_id<>OLD.proposal_bond_id OR NEW.proposed_at<>OLD.proposed_at OR
    NEW.challenge_deadline<>OLD.challenge_deadline OR NEW.timelock_until<>OLD.timelock_until OR
    (OLD.state='finalized') OR
    (OLD.state='proposed' AND NEW.state NOT IN ('challenged','finalized')) OR
    (OLD.state='challenged' AND NEW.state<>'finalized') OR
    (OLD.challenged_by IS NOT NULL AND
      (NEW.challenged_by<>OLD.challenged_by OR NEW.challenge<>OLD.challenge OR
       NEW.challenge_evidence_id<>OLD.challenge_evidence_id OR NEW.challenge_bond_id<>OLD.challenge_bond_id)) THEN
    RAISE EXCEPTION 'Resolution case identity and finality are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resolution_case_guard BEFORE UPDATE ON resolution_cases
  FOR EACH ROW EXECUTE FUNCTION guard_resolution_case();
