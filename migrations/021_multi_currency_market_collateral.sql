ALTER TABLE clob_asset_bindings ADD COLUMN contract_unit_minor numeric(78,0) NOT NULL DEFAULT 1000000
  CHECK (contract_unit_minor > 1);
ALTER TABLE clob_markets ADD COLUMN contract_unit_minor numeric(78,0) NOT NULL DEFAULT 1000000
  CHECK (contract_unit_minor > 1);
ALTER TABLE amm_pools ADD COLUMN contract_unit_minor numeric(78,0) NOT NULL DEFAULT 1000000
  CHECK (contract_unit_minor > 1);

CREATE FUNCTION guard_clob_asset_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_ref<>OLD.policy_ref OR NEW.asset_code<>OLD.asset_code OR
    NEW.contract_unit_minor<>OLD.contract_unit_minor OR NEW.evidence_ref<>OLD.evidence_ref THEN
    RAISE EXCEPTION 'Collateral binding identity and contract unit are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clob_asset_binding_guard BEFORE UPDATE ON clob_asset_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_clob_asset_binding();
CREATE TRIGGER clob_asset_binding_no_delete BEFORE DELETE ON clob_asset_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_clob_market_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.market_id<>OLD.market_id OR NEW.asset_code<>OLD.asset_code OR
    NEW.contract_unit_minor<>OLD.contract_unit_minor OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Market collateral identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clob_market_collateral_guard BEFORE UPDATE ON clob_markets
  FOR EACH ROW EXECUTE FUNCTION guard_clob_market_collateral();

CREATE FUNCTION verify_amm_pool_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE market_asset text; market_unit numeric;
BEGIN
  SELECT asset_code,contract_unit_minor INTO market_asset,market_unit FROM clob_markets WHERE market_id=NEW.market_id;
  IF market_asset IS NULL OR NEW.asset_code<>market_asset OR NEW.contract_unit_minor<>market_unit OR
    (TG_OP='UPDATE' AND (NEW.market_id<>OLD.market_id OR NEW.outcome_id<>OLD.outcome_id OR
      NEW.asset_code<>OLD.asset_code OR NEW.contract_unit_minor<>OLD.contract_unit_minor)) THEN
    RAISE EXCEPTION 'AMM collateral must match the immutable market collateral';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amm_pool_collateral_guard BEFORE INSERT OR UPDATE ON amm_pools
  FOR EACH ROW EXECUTE FUNCTION verify_amm_pool_collateral();

ALTER TABLE clob_fills DROP CONSTRAINT clob_fills_check;
ALTER TABLE rfq_fills DROP CONSTRAINT rfq_fills_check1;

CREATE FUNCTION verify_clob_fill_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract_unit numeric;
BEGIN
  SELECT contract_unit_minor INTO contract_unit FROM clob_markets WHERE market_id=NEW.market_id;
  IF contract_unit IS NULL OR NEW.buyer_collateral+NEW.seller_collateral<>NEW.quantity*contract_unit THEN
    RAISE EXCEPTION 'CLOB fill must conserve the governed contract unit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clob_fill_collateral_guard BEFORE INSERT ON clob_fills
  FOR EACH ROW EXECUTE FUNCTION verify_clob_fill_collateral();

CREATE OR REPLACE FUNCTION verify_resolution_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*m.contract_unit_minor,m.asset_code INTO expected,market_asset
  FROM clob_fills f JOIN clob_markets m ON m.market_id=f.market_id
  WHERE f.id=NEW.fill_id AND f.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
  WHERE id=NEW.journal_id AND reference_id=NEW.fill_id::text;
  IF expected IS NULL OR NEW.buyer_minor+NEW.seller_minor<>expected OR
    case_state IS DISTINCT FROM 'finalized' OR
    journal_kind IS DISTINCT FROM 'resolution_redemption' OR journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'Redemption must conserve one finalized matched payout';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_amm_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; quote_owner uuid; quote_state text; case_state text;
  journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT q.quantity*m.contract_unit_minor,q.owner_id,q.state,p.asset_code
    INTO expected,quote_owner,quote_state,market_asset
  FROM amm_quotes q JOIN amm_pools p ON p.market_id=q.market_id AND p.outcome_id=q.outcome_id
  JOIN clob_markets m ON m.market_id=q.market_id
  WHERE q.id=NEW.quote_id AND q.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.quote_id::text;
  IF expected IS NULL OR NEW.owner_id<>quote_owner OR NEW.user_minor+NEW.treasury_minor<>expected OR
    quote_state IS DISTINCT FROM 'executed' OR case_state IS DISTINCT FROM 'finalized' OR
    journal_kind IS DISTINCT FROM 'resolution_redemption' OR journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'AMM redemption must conserve one finalized executed quote';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_rfq_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row rfq_requests%ROWTYPE; quote_row rfq_quotes%ROWTYPE;
  journal_kind text; journal_asset text; market_asset text; contract_unit numeric;
BEGIN
  SELECT * INTO request_row FROM rfq_requests WHERE id=NEW.request_id;
  SELECT * INTO quote_row FROM rfq_quotes WHERE id=NEW.quote_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.id::text;
  SELECT asset_code,contract_unit_minor INTO market_asset,contract_unit FROM clob_markets WHERE market_id=NEW.market_id;
  IF request_row.id IS NULL OR quote_row.id IS NULL OR request_row.state<>'open' OR quote_row.state<>'open' OR
    quote_row.request_id<>request_row.id OR NEW.market_id<>request_row.market_id OR
    NEW.requester_entity_id<>request_row.entity_id OR NEW.dealer_entity_id<>quote_row.dealer_entity_id OR
    NEW.requester_owner_id<>request_row.owner_id OR NEW.dealer_owner_id<>quote_row.dealer_owner_id OR
    NEW.requester_side<>request_row.side OR NEW.outcome_id<>request_row.outcome_id OR
    NEW.price<>quote_row.price OR NEW.quantity<>request_row.quantity OR journal_kind<>'rfq_execution' OR
    journal_asset<>market_asset OR NEW.buyer_collateral+NEW.seller_collateral<>NEW.quantity*contract_unit THEN
    RAISE EXCEPTION 'RFQ fill must match its signed quote, request, governed collateral and execution journal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_rfq_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*m.contract_unit_minor,m.asset_code INTO expected,market_asset
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
