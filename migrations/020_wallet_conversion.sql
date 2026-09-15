INSERT INTO financial_assets(code,scale,synthetic,approved,evidence_ref) VALUES
  ('USDT_BSC',18,false,false,'https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955')
ON CONFLICT (code) DO NOTHING;

INSERT INTO token_asset_registry(asset_code,symbol,chain_id,contract_address,decimals,approved,evidence_ref) VALUES
  ('USDT_BSC','USDT',56,'0x55d398326f99059ff775485246999027b3197955',18,false,
   'https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955')
ON CONFLICT (asset_code) DO NOTHING;

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_bucket_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_bucket_check
  CHECK (bucket IN ('escrow_asset','user_available','user_reserved','user_withdrawal_pending',
    'protocol_fee','reconciliation_suspense','market_escrow','liquidity_reserve','conversion_inventory'));

ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN ('deposit_finalized','reservation_held','reservation_released','reservation_consumed',
    'withdrawal_held','withdrawal_finalized','financial_correction','clob_execution','resolution_redemption',
    'amm_treasury_funded','amm_execution','rfq_execution','conversion_inventory_funded','wallet_conversion'));

CREATE TABLE conversion_rate_snapshots (
  id uuid PRIMARY KEY,
  source_asset text NOT NULL REFERENCES financial_assets(code),
  destination_asset text NOT NULL REFERENCES financial_assets(code),
  rate_numerator numeric(78,0) NOT NULL CHECK (rate_numerator > 0),
  rate_denominator numeric(78,0) NOT NULL CHECK (rate_denominator > 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  minimum_source_minor numeric(78,0) NOT NULL CHECK (minimum_source_minor > 0),
  source_ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_asset <> destination_asset),
  CHECK ((source_asset='NGN' AND destination_asset='USDT_BSC') OR
         (source_asset='USDT_BSC' AND destination_asset='NGN')),
  CHECK (expires_at > created_at)
);
CREATE INDEX conversion_rate_pair_expiry ON conversion_rate_snapshots(source_asset,destination_asset,expires_at DESC);

CREATE TABLE wallet_conversion_quotes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  rate_snapshot_id uuid NOT NULL REFERENCES conversion_rate_snapshots(id),
  source_asset text NOT NULL REFERENCES financial_assets(code),
  destination_asset text NOT NULL REFERENCES financial_assets(code),
  source_amount_minor numeric(78,0) NOT NULL CHECK (source_amount_minor > 0),
  fee_minor numeric(78,0) NOT NULL CHECK (fee_minor >= 0 AND fee_minor < source_amount_minor),
  destination_amount_minor numeric(78,0) NOT NULL CHECK (destination_amount_minor > 0),
  rate_numerator numeric(78,0) NOT NULL CHECK (rate_numerator > 0),
  rate_denominator numeric(78,0) NOT NULL CHECK (rate_denominator > 0),
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','executed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  CHECK (source_asset <> destination_asset),
  CHECK ((state='quoted' AND executed_at IS NULL) OR (state='executed' AND executed_at IS NOT NULL))
);
CREATE INDEX wallet_conversion_quote_owner ON wallet_conversion_quotes(owner_id,created_at DESC);

CREATE TABLE wallet_conversion_trades (
  id uuid PRIMARY KEY,
  quote_id uuid NOT NULL UNIQUE REFERENCES wallet_conversion_quotes(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  source_journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  destination_journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals(id),
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER conversion_rate_append_only BEFORE UPDATE OR DELETE ON conversion_rate_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER conversion_trade_append_only BEFORE UPDATE OR DELETE ON wallet_conversion_trades
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_wallet_conversion_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.rate_snapshot_id <> OLD.rate_snapshot_id OR
    NEW.source_asset <> OLD.source_asset OR NEW.destination_asset <> OLD.destination_asset OR
    NEW.source_amount_minor <> OLD.source_amount_minor OR NEW.fee_minor <> OLD.fee_minor OR
    NEW.destination_amount_minor <> OLD.destination_amount_minor OR NEW.rate_numerator <> OLD.rate_numerator OR
    NEW.rate_denominator <> OLD.rate_denominator OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Wallet conversion quote terms are immutable';
  END IF;
  IF NOT (OLD.state='quoted' AND NEW.state='executed') THEN
    RAISE EXCEPTION 'Invalid wallet conversion quote transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_conversion_quote_guard BEFORE UPDATE ON wallet_conversion_quotes
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_conversion_quote();
CREATE TRIGGER wallet_conversion_quote_no_delete BEFORE DELETE ON wallet_conversion_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
