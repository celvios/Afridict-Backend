ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_bucket_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_bucket_check
  CHECK (bucket IN ('escrow_asset','user_available','user_reserved','user_withdrawal_pending',
    'protocol_fee','reconciliation_suspense','market_escrow','liquidity_reserve'));

ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN ('deposit_finalized','reservation_held','reservation_released','reservation_consumed',
    'withdrawal_held','withdrawal_finalized','financial_correction','clob_execution','resolution_redemption',
    'amm_treasury_funded','amm_execution'));

CREATE TABLE amm_pools (
  market_id uuid NOT NULL REFERENCES markets(id),
  outcome_id text NOT NULL,
  asset_code text NOT NULL REFERENCES financial_assets(code),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','halted')),
  inventory_limit numeric(78,0) NOT NULL CHECK (inventory_limit > 0),
  subsidy_limit numeric(78,0) NOT NULL CHECK (subsidy_limit > 0),
  loss_limit numeric(78,0) NOT NULL CHECK (loss_limit > 0 AND loss_limit <= subsidy_limit),
  max_slippage_bps integer NOT NULL CHECK (max_slippage_bps BETWEEN 0 AND 10000),
  impact_bps integer NOT NULL CHECK (impact_bps BETWEEN 0 AND 10000),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  shares_committed numeric(78,0) NOT NULL DEFAULT 0 CHECK (shares_committed >= 0),
  subsidy_committed numeric(78,0) NOT NULL DEFAULT 0 CHECK (subsidy_committed >= 0),
  worst_case_loss_committed numeric(78,0) NOT NULL DEFAULT 0 CHECK (worst_case_loss_committed >= 0),
  funded_minor numeric(78,0) NOT NULL DEFAULT 0 CHECK (funded_minor >= 0),
  activated_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id,outcome_id),
  CHECK (shares_committed <= inventory_limit AND subsidy_committed <= subsidy_limit AND
    worst_case_loss_committed <= loss_limit AND subsidy_committed <= funded_minor)
);

CREATE TABLE amm_reference_prices (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  outcome_id text NOT NULL,
  price numeric(78,0) NOT NULL CHECK (price BETWEEN 1 AND 999999),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
  source_ref text NOT NULL UNIQUE,
  recorded_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (market_id,outcome_id) REFERENCES amm_pools(market_id,outcome_id)
);
CREATE INDEX amm_reference_latest ON amm_reference_prices(market_id,outcome_id,observed_at DESC);
CREATE TRIGGER amm_reference_append_only BEFORE UPDATE OR DELETE ON amm_reference_prices
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE amm_quotes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  market_id uuid NOT NULL,
  outcome_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  reference_price_id uuid NOT NULL REFERENCES amm_reference_prices(id),
  price numeric(78,0) NOT NULL CHECK (price BETWEEN 1 AND 999999),
  user_collateral numeric(78,0) NOT NULL CHECK (user_collateral > 0),
  amm_collateral numeric(78,0) NOT NULL CHECK (amm_collateral > 0),
  fee numeric(78,0) NOT NULL CHECK (fee >= 0),
  user_total numeric(78,0) NOT NULL CHECK (user_total = user_collateral + fee),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','executed','expired')),
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (market_id,outcome_id) REFERENCES amm_pools(market_id,outcome_id),
  CHECK ((state='executed') = (executed_at IS NOT NULL))
);
CREATE INDEX amm_owner_quotes ON amm_quotes(owner_id,created_at DESC);

CREATE FUNCTION guard_amm_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.market_id<>OLD.market_id OR
    NEW.outcome_id<>OLD.outcome_id OR NEW.side<>OLD.side OR NEW.quantity<>OLD.quantity OR
    NEW.reference_price_id<>OLD.reference_price_id OR NEW.price<>OLD.price OR
    NEW.user_collateral<>OLD.user_collateral OR NEW.amm_collateral<>OLD.amm_collateral OR
    NEW.fee<>OLD.fee OR NEW.user_total<>OLD.user_total OR NEW.expires_at<>OLD.expires_at OR
    NEW.created_at<>OLD.created_at OR OLD.state<>'quoted' OR NEW.state NOT IN ('executed','expired') THEN
    RAISE EXCEPTION 'AMM quote identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amm_quote_guard BEFORE UPDATE ON amm_quotes FOR EACH ROW EXECUTE FUNCTION guard_amm_quote();
CREATE TRIGGER amm_quote_no_delete BEFORE DELETE ON amm_quotes FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE amm_redemptions (
  quote_id uuid PRIMARY KEY REFERENCES amm_quotes(id),
  market_id uuid NOT NULL REFERENCES resolution_cases(market_id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  user_minor numeric(78,0) NOT NULL CHECK (user_minor >= 0),
  treasury_minor numeric(78,0) NOT NULL CHECK (treasury_minor >= 0),
  journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_minor+treasury_minor>0)
);
CREATE INDEX amm_redemptions_market ON amm_redemptions(market_id,quote_id);
CREATE FUNCTION verify_amm_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; quote_owner uuid; quote_state text; case_state text;
  journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT q.quantity*1000000,q.owner_id,q.state,p.asset_code
    INTO expected,quote_owner,quote_state,market_asset
  FROM amm_quotes q JOIN amm_pools p ON p.market_id=q.market_id AND p.outcome_id=q.outcome_id
  WHERE q.id=NEW.quote_id AND q.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.quote_id::text;
  IF expected IS NULL OR NEW.owner_id<>quote_owner OR quote_state IS DISTINCT FROM 'executed' OR
    NEW.user_minor+NEW.treasury_minor<>expected OR case_state IS DISTINCT FROM 'finalized' OR
    journal_kind IS DISTINCT FROM 'resolution_redemption' OR journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'AMM redemption must conserve one finalized executed quote payout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amm_redemption_guard BEFORE INSERT ON amm_redemptions
  FOR EACH ROW EXECUTE FUNCTION verify_amm_redemption();
CREATE TRIGGER amm_redemptions_append_only BEFORE UPDATE OR DELETE ON amm_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE reconciliation_runs ADD COLUMN liquidity_reserve_minor numeric(78,0) NOT NULL DEFAULT 0
  CHECK (liquidity_reserve_minor >= 0);

ALTER TABLE clob_events DROP CONSTRAINT clob_events_event_type_check;
ALTER TABLE clob_events ADD CONSTRAINT clob_events_event_type_check CHECK (event_type IN
  ('activated','halted','order_accepted','fill','order_cancelled','resolution_proposed',
   'resolution_challenged','resolution_finalized','redemption_batch','amm_execution'));
ALTER TABLE clob_events DROP CONSTRAINT clob_events_fill_id_fkey;

ALTER TABLE settlement_batch_items DROP CONSTRAINT settlement_batch_items_fill_id_fkey;
CREATE FUNCTION verify_settlement_payout_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM resolution_redemptions r WHERE r.fill_id=NEW.fill_id) AND
     NOT EXISTS (SELECT 1 FROM amm_redemptions r JOIN amm_quotes q ON q.id=r.quote_id
       WHERE r.quote_id=NEW.fill_id AND r.owner_id=NEW.owner_id AND
         (CASE WHEN q.side='buy' THEN 'buyer' ELSE 'seller' END)=NEW.payout_side AND
         r.user_minor=NEW.amount_minor) THEN
    RAISE EXCEPTION 'Settlement item must reference an immutable redemption payout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_payout_source_guard BEFORE INSERT ON settlement_batch_items
  FOR EACH ROW EXECUTE FUNCTION verify_settlement_payout_source();
