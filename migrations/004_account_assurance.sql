CREATE TABLE account_assurance (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  identity_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (identity_status IN
    ('NOT_STARTED','PENDING','IN_REVIEW','VERIFIED','FAILED','REQUIRES_RETRY')),
  identity_evidence_ref text,
  identity_updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (identity_status <> 'VERIFIED' OR identity_evidence_ref IS NOT NULL)
);
