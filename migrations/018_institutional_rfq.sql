ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN ('deposit_finalized','reservation_held','reservation_released','reservation_consumed',
    'withdrawal_held','withdrawal_finalized','financial_correction','clob_execution','resolution_redemption',
    'amm_treasury_funded','amm_execution','rfq_execution'));

CREATE TABLE rfq_entities (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL UNIQUE CHECK (length(legal_name) BETWEEN 2 AND 160),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  exposure_limit_minor numeric(78,0) NOT NULL CHECK (exposure_limit_minor > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='pending' AND approved_by IS NULL AND approved_at IS NULL) OR
    (status IN ('active','suspended') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by<>created_by)
);
CREATE FUNCTION guard_rfq_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.legal_name<>OLD.legal_name OR NEW.exposure_limit_minor<>OLD.exposure_limit_minor OR
    NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR
    (OLD.status='pending' AND (NEW.status<>'active' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL)) OR
    (OLD.status='active' AND (NEW.status<>'suspended' OR NEW.approved_by<>OLD.approved_by OR NEW.approved_at<>OLD.approved_at)) OR
    OLD.status='suspended' THEN
    RAISE EXCEPTION 'RFQ entity identity, approval and limits are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rfq_entity_guard BEFORE UPDATE ON rfq_entities FOR EACH ROW EXECUTE FUNCTION guard_rfq_entity();
CREATE TRIGGER rfq_entity_no_delete BEFORE DELETE ON rfq_entities FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE rfq_entity_memberships (
  entity_id uuid NOT NULL REFERENCES rfq_entities(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('requester','dealer')),
  signing_public_key text,
  signing_key_fingerprint text CHECK (signing_key_fingerprint ~ '^[a-f0-9]{64}$'),
  added_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(entity_id,account_id,role),
  CHECK ((role='dealer' AND signing_public_key IS NOT NULL AND signing_key_fingerprint IS NOT NULL) OR
    (role='requester' AND signing_public_key IS NULL AND signing_key_fingerprint IS NULL))
);
CREATE TRIGGER rfq_memberships_append_only BEFORE UPDATE OR DELETE ON rfq_entity_memberships
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE rfq_requests (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES rfq_entities(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  market_id uuid NOT NULL REFERENCES clob_markets(market_id),
  outcome_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','cancelled','expired')),
  accepted_quote_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='accepted')=(accepted_quote_id IS NOT NULL))
);
CREATE INDEX rfq_request_market ON rfq_requests(market_id,state,created_at,id);
CREATE INDEX rfq_request_owner ON rfq_requests(owner_id,created_at DESC);

CREATE TABLE rfq_quotes (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES rfq_requests(id),
  dealer_entity_id uuid NOT NULL REFERENCES rfq_entities(id),
  dealer_owner_id uuid NOT NULL REFERENCES accounts(id),
  price numeric(78,0) NOT NULL CHECK (price BETWEEN 1 AND 999999),
  expires_at timestamptz NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{8,128}$'),
  signing_key_fingerprint text NOT NULL CHECK (signing_key_fingerprint ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','rejected','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(dealer_entity_id,nonce)
);
ALTER TABLE rfq_requests ADD CONSTRAINT rfq_request_accepted_quote_fkey
  FOREIGN KEY(accepted_quote_id) REFERENCES rfq_quotes(id);
CREATE INDEX rfq_quote_request ON rfq_quotes(request_id,state,created_at,id);

CREATE TABLE rfq_fills (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES rfq_requests(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES rfq_quotes(id),
  market_id uuid NOT NULL REFERENCES clob_markets(market_id),
  requester_entity_id uuid NOT NULL REFERENCES rfq_entities(id),
  dealer_entity_id uuid NOT NULL REFERENCES rfq_entities(id),
  requester_owner_id uuid NOT NULL REFERENCES accounts(id),
  dealer_owner_id uuid NOT NULL REFERENCES accounts(id),
  requester_side text NOT NULL CHECK (requester_side IN ('buy','sell')),
  outcome_id text NOT NULL,
  price numeric(78,0) NOT NULL CHECK (price BETWEEN 1 AND 999999),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  buyer_collateral numeric(78,0) NOT NULL CHECK (buyer_collateral > 0),
  seller_collateral numeric(78,0) NOT NULL CHECK (seller_collateral > 0),
  buyer_fee numeric(78,0) NOT NULL CHECK (buyer_fee >= 0),
  seller_fee numeric(78,0) NOT NULL CHECK (seller_fee >= 0),
  journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(market_id,sequence),
  CHECK (requester_entity_id<>dealer_entity_id AND requester_owner_id<>dealer_owner_id),
  CHECK (buyer_collateral+seller_collateral=quantity*1000000)
);
CREATE INDEX rfq_fills_market ON rfq_fills(market_id,sequence);
CREATE FUNCTION verify_rfq_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row rfq_requests%ROWTYPE; quote_row rfq_quotes%ROWTYPE;
  journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT * INTO request_row FROM rfq_requests WHERE id=NEW.request_id;
  SELECT * INTO quote_row FROM rfq_quotes WHERE id=NEW.quote_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.id::text;
  SELECT asset_code INTO market_asset FROM clob_markets WHERE market_id=NEW.market_id;
  IF request_row.id IS NULL OR quote_row.id IS NULL OR request_row.state<>'open' OR quote_row.state<>'open' OR
    quote_row.request_id<>request_row.id OR NEW.market_id<>request_row.market_id OR
    NEW.requester_entity_id<>request_row.entity_id OR NEW.dealer_entity_id<>quote_row.dealer_entity_id OR
    NEW.requester_owner_id<>request_row.owner_id OR NEW.dealer_owner_id<>quote_row.dealer_owner_id OR
    NEW.requester_side<>request_row.side OR NEW.outcome_id<>request_row.outcome_id OR
    NEW.price<>quote_row.price OR NEW.quantity<>request_row.quantity OR journal_kind<>'rfq_execution' OR
    journal_asset<>market_asset THEN
    RAISE EXCEPTION 'RFQ fill must match its open signed quote, request and execution journal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rfq_fill_guard BEFORE INSERT ON rfq_fills FOR EACH ROW EXECUTE FUNCTION verify_rfq_fill();
CREATE TRIGGER rfq_fills_append_only BEFORE UPDATE OR DELETE ON rfq_fills
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE rfq_redemptions (
  fill_id uuid PRIMARY KEY REFERENCES rfq_fills(id),
  market_id uuid NOT NULL REFERENCES resolution_cases(market_id),
  buyer_minor numeric(78,0) NOT NULL CHECK (buyer_minor >= 0),
  seller_minor numeric(78,0) NOT NULL CHECK (seller_minor >= 0),
  journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_minor+seller_minor>0)
);
CREATE INDEX rfq_redemptions_market ON rfq_redemptions(market_id,fill_id);
CREATE FUNCTION verify_rfq_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*1000000,m.asset_code INTO expected,market_asset
  FROM rfq_fills f JOIN clob_markets m ON m.market_id=f.market_id
  WHERE f.id=NEW.fill_id AND f.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
  WHERE id=NEW.journal_id AND reference_id=NEW.fill_id::text;
  IF expected IS NULL OR NEW.buyer_minor+NEW.seller_minor<>expected OR
    case_state IS DISTINCT FROM 'finalized' OR journal_kind IS DISTINCT FROM 'resolution_redemption' OR
    journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'RFQ redemption must conserve one finalized fill payout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rfq_redemption_guard BEFORE INSERT ON rfq_redemptions
  FOR EACH ROW EXECUTE FUNCTION verify_rfq_redemption();
CREATE TRIGGER rfq_redemptions_append_only BEFORE UPDATE OR DELETE ON rfq_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_rfq_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.entity_id<>OLD.entity_id OR NEW.owner_id<>OLD.owner_id OR
    NEW.market_id<>OLD.market_id OR NEW.outcome_id<>OLD.outcome_id OR NEW.side<>OLD.side OR
    NEW.quantity<>OLD.quantity OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at OR
    OLD.state<>'open' OR NEW.state NOT IN ('accepted','cancelled','expired') THEN
    RAISE EXCEPTION 'RFQ request identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rfq_request_guard BEFORE UPDATE ON rfq_requests FOR EACH ROW EXECUTE FUNCTION guard_rfq_request();
CREATE TRIGGER rfq_request_no_delete BEFORE DELETE ON rfq_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_rfq_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.dealer_entity_id<>OLD.dealer_entity_id OR
    NEW.dealer_owner_id<>OLD.dealer_owner_id OR NEW.price<>OLD.price OR NEW.expires_at<>OLD.expires_at OR
    NEW.nonce<>OLD.nonce OR NEW.signing_key_fingerprint<>OLD.signing_key_fingerprint OR
    NEW.signature<>OLD.signature OR NEW.payload_hash<>OLD.payload_hash OR NEW.created_at<>OLD.created_at OR
    OLD.state<>'open' OR NEW.state NOT IN ('accepted','rejected','expired') THEN
    RAISE EXCEPTION 'RFQ quote identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rfq_quote_guard BEFORE UPDATE ON rfq_quotes FOR EACH ROW EXECUTE FUNCTION guard_rfq_quote();
CREATE TRIGGER rfq_quote_no_delete BEFORE DELETE ON rfq_quotes FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE clob_events DROP CONSTRAINT clob_events_event_type_check;
ALTER TABLE clob_events ADD CONSTRAINT clob_events_event_type_check CHECK (event_type IN
  ('activated','halted','order_accepted','fill','order_cancelled','resolution_proposed',
   'resolution_challenged','resolution_finalized','redemption_batch','amm_execution','rfq_execution'));

CREATE OR REPLACE FUNCTION verify_settlement_payout_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM resolution_redemptions r WHERE r.fill_id=NEW.fill_id) AND
     NOT EXISTS (SELECT 1 FROM amm_redemptions r JOIN amm_quotes q ON q.id=r.quote_id
       WHERE r.quote_id=NEW.fill_id AND r.owner_id=NEW.owner_id AND
         (CASE WHEN q.side='buy' THEN 'buyer' ELSE 'seller' END)=NEW.payout_side AND r.user_minor=NEW.amount_minor) AND
     NOT EXISTS (SELECT 1 FROM rfq_redemptions r JOIN rfq_fills f ON f.id=r.fill_id
       WHERE r.fill_id=NEW.fill_id AND
         (CASE WHEN NEW.payout_side='buyer' THEN
           CASE WHEN f.requester_side='buy' THEN f.requester_owner_id ELSE f.dealer_owner_id END
          ELSE CASE WHEN f.requester_side='sell' THEN f.requester_owner_id ELSE f.dealer_owner_id END END)=NEW.owner_id AND
         (CASE WHEN NEW.payout_side='buyer' THEN r.buyer_minor ELSE r.seller_minor END)=NEW.amount_minor) THEN
    RAISE EXCEPTION 'Settlement item must reference an immutable redemption payout';
  END IF;
  RETURN NEW;
END;
$$;
