CREATE TABLE token_asset_registry (
  asset_code text PRIMARY KEY REFERENCES financial_assets(code),
  symbol text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id>0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[a-f0-9]{40}$'),
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  UNIQUE(chain_id,contract_address)
);

CREATE TABLE manual_crypto_withdrawals (
  withdrawal_id uuid PRIMARY KEY REFERENCES withdrawals(id),
  token_contract text NOT NULL CHECK (token_contract ~ '^0x[a-f0-9]{40}$'),
  chain_id bigint NOT NULL CHECK (chain_id>0),
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  transaction_hash text UNIQUE CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[a-f0-9]{64}$'),
  submitted_at timestamptz,
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (transaction_hash IS NULL OR approved_by IS NOT NULL)
);

ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_state_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_state_check CHECK (state IN
  ('reserved','approved','submitting','submitted','uncertain','finalized','cancelled','exception'));

CREATE OR REPLACE FUNCTION guard_withdrawal_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.reservation_id <> OLD.reservation_id OR
    NEW.asset_code <> OLD.asset_code OR NEW.amount_minor <> OLD.amount_minor OR
    NEW.destination_ref <> OLD.destination_ref OR NEW.rail <> OLD.rail OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Withdrawal identity is immutable';
  END IF;
  IF NOT ((NEW.state = OLD.state) OR
    (OLD.state = 'reserved' AND NEW.state IN ('approved','submitting','submitted','cancelled','exception')) OR
    (OLD.state = 'approved' AND NEW.state IN ('submitted','exception')) OR
    (OLD.state = 'submitting' AND NEW.state IN ('submitted','uncertain','exception')) OR
    (OLD.state = 'submitted' AND NEW.state IN ('uncertain','finalized','exception')) OR
    (OLD.state = 'uncertain' AND NEW.state IN ('submitted','finalized','exception'))) THEN
    RAISE EXCEPTION 'Invalid withdrawal state transition';
  END IF;
  RETURN NEW;
END;
$$;
