-- One matched contract has a fixed payout of 1,000,000 asset minor units.
-- Activation is explicitly governed; newly published markets start halted.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_bucket_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_bucket_check
  CHECK (bucket IN ('escrow_asset','user_available','user_reserved',
    'user_withdrawal_pending','protocol_fee','reconciliation_suspense','market_escrow'));
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN ('deposit_finalized','reservation_held','reservation_released',
    'reservation_consumed','withdrawal_held','withdrawal_finalized','financial_correction','clob_execution'));

CREATE TABLE clob_asset_bindings (
  policy_ref text PRIMARY KEY,
  asset_code text NOT NULL REFERENCES financial_assets(code),
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL
);

CREATE TABLE clob_markets (
  market_id uuid PRIMARY KEY REFERENCES markets(id),
  asset_code text NOT NULL REFERENCES financial_assets(code),
  status text NOT NULL DEFAULT 'halted' CHECK (status IN ('halted','open')),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  activated_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clob_orders (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES clob_markets(market_id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES collateral_reservations(id),
  outcome_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  limit_price numeric(78,0) NOT NULL CHECK (limit_price BETWEEN 1 AND 999999),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  remaining numeric(78,0) NOT NULL CHECK (remaining >= 0 AND remaining <= quantity),
  reserved_per_share numeric(78,0) NOT NULL CHECK (reserved_per_share > 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','filled','cancelled')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id,sequence),
  CHECK ((state = 'filled' AND remaining = 0) OR
    (state IN ('open','cancelled') AND remaining > 0))
);
CREATE INDEX clob_book ON clob_orders(market_id,outcome_id,side,limit_price,sequence) WHERE state='open';
CREATE INDEX clob_owner_orders ON clob_orders(owner_id,market_id,sequence DESC);

CREATE TABLE clob_fills (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES clob_markets(market_id),
  maker_order_id uuid NOT NULL REFERENCES clob_orders(id),
  taker_order_id uuid NOT NULL REFERENCES clob_orders(id),
  outcome_id text NOT NULL,
  price numeric(78,0) NOT NULL CHECK (price BETWEEN 1 AND 999999),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  buyer_collateral numeric(78,0) NOT NULL CHECK (buyer_collateral > 0),
  seller_collateral numeric(78,0) NOT NULL CHECK (seller_collateral > 0),
  buyer_fee numeric(78,0) NOT NULL CHECK (buyer_fee >= 0),
  seller_fee numeric(78,0) NOT NULL CHECK (seller_fee >= 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id,sequence),
  CHECK (buyer_collateral + seller_collateral = quantity * 1000000),
  CHECK (maker_order_id <> taker_order_id)
);
CREATE INDEX clob_market_fills ON clob_fills(market_id,sequence);
CREATE TRIGGER clob_fills_append_only BEFORE UPDATE OR DELETE ON clob_fills
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE clob_events (
  market_id uuid NOT NULL REFERENCES clob_markets(market_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('activated','halted','order_accepted','fill','order_cancelled')),
  order_id uuid REFERENCES clob_orders(id),
  fill_id uuid REFERENCES clob_fills(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id,sequence)
);
CREATE TRIGGER clob_events_append_only BEFORE UPDATE OR DELETE ON clob_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_clob_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.market_id <> OLD.market_id OR NEW.owner_id <> OLD.owner_id OR
    NEW.reservation_id <> OLD.reservation_id OR NEW.outcome_id <> OLD.outcome_id OR
    NEW.side <> OLD.side OR NEW.limit_price <> OLD.limit_price OR
    NEW.quantity <> OLD.quantity OR NEW.reserved_per_share <> OLD.reserved_per_share OR
    NEW.sequence <> OLD.sequence OR NEW.created_at <> OLD.created_at OR
    NEW.remaining > OLD.remaining OR
    (OLD.state <> 'open' AND NEW.state <> OLD.state) OR
    (NEW.state='open' AND NEW.remaining=0) THEN
    RAISE EXCEPTION 'CLOB order identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clob_order_guard BEFORE UPDATE ON clob_orders
  FOR EACH ROW EXECUTE FUNCTION guard_clob_order();

ALTER TABLE reconciliation_runs ADD COLUMN market_collateral_minor numeric(78,0) NOT NULL DEFAULT 0
  CHECK (market_collateral_minor >= 0);
ALTER TABLE reconciliation_runs ADD COLUMN protocol_fee_minor numeric(78,0) NOT NULL DEFAULT 0
  CHECK (protocol_fee_minor >= 0);
