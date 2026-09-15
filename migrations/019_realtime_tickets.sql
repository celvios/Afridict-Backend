CREATE TABLE realtime_tickets (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX realtime_ticket_expiry ON realtime_tickets(expires_at) WHERE consumed_at IS NULL;

