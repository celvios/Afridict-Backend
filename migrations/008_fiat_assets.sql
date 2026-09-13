-- Currency definitions do not activate a payment rail or approve custody.
-- Human-reviewed rail configuration must set approved=true under migration-owner control.
INSERT INTO financial_assets(code,scale,synthetic,approved,evidence_ref) VALUES
  ('NGN',2,false,false,'https://docs.swervpay.co/payout/introduction'),
  ('USD',2,false,false,'https://docs.swervpay.co/collection/introduction')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE fiat_rail_registry (
  provider text NOT NULL,
  asset_code text NOT NULL REFERENCES financial_assets(code),
  collections_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  reviewed_at timestamptz,
  PRIMARY KEY(provider,asset_code),
  CHECK (approved OR (collections_enabled=false AND payouts_enabled=false))
);

INSERT INTO fiat_rail_registry(provider,asset_code,evidence_ref) VALUES
  ('swervpay','NGN','https://docs.swervpay.co/payout/introduction'),
  ('swervpay','USD','https://docs.swervpay.co/collection/introduction');
