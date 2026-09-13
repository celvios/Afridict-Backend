CREATE TABLE identity_inquiries (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  provider text NOT NULL CHECK (provider IN ('persona')),
  provider_reference text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','IN_REVIEW','VERIFIED','FAILED','REQUIRES_RETRY')),
  last_provider_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,provider_reference)
);
CREATE INDEX identity_inquiry_account ON identity_inquiries(account_id,created_at DESC);

CREATE TABLE identity_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  provider_reference text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  event_name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied boolean NOT NULL,
  PRIMARY KEY (provider,event_id)
);
CREATE INDEX identity_event_inquiry ON identity_provider_events(provider,provider_reference,occurred_at DESC);
CREATE TRIGGER identity_provider_event_append_only BEFORE UPDATE OR DELETE ON identity_provider_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
