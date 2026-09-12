ALTER TABLE policy_registry DROP CONSTRAINT policy_registry_kind_check;
ALTER TABLE policy_registry ADD CONSTRAINT policy_registry_kind_check
  CHECK (kind IN ('eligibility','adjudication','bond','payout','collateral','finality'));
