CREATE TABLE fiat_collection_requests (
  intent_id uuid PRIMARY KEY REFERENCES deposit_intents(id),
  provider text NOT NULL CHECK (provider='swervpay'),
  state text NOT NULL CHECK (state IN ('instruction_pending','instruction_creating','instructions_available','instruction_uncertain')),
  provider_reference text UNIQUE,
  account_name text,
  account_number text CHECK (account_number IS NULL OR account_number ~ '^[0-9]{10}$'),
  bank_code text,
  bank_name text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='instructions_available') = (provider_reference IS NOT NULL AND account_name IS NOT NULL
    AND account_number IS NOT NULL AND bank_code IS NOT NULL AND bank_name IS NOT NULL))
);
