-- Product direction uses a contract-specific BEP-20 stablecoin for USD-value
-- transfers. A generic USD fiat asset must not imply a Swervpay rail.
DELETE FROM fiat_rail_registry WHERE provider='swervpay' AND asset_code='USD';
DELETE FROM financial_assets WHERE code='USD' AND approved=false;
