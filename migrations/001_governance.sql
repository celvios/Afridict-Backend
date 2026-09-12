CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  roles text[] NOT NULL DEFAULT ARRAY['user'],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE eligibility (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  status text NOT NULL CHECK (status IN ('pending', 'eligible', 'restricted')),
  policy_version text NOT NULL,
  evidence_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eligibility_reviews (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  proposer_id uuid NOT NULL REFERENCES accounts(id),
  approver_id uuid REFERENCES accounts(id),
  decision text NOT NULL CHECK (decision IN ('eligible', 'restricted')),
  policy_version text NOT NULL,
  evidence_ref text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (proposer_id IS DISTINCT FROM approver_id)
);

CREATE TABLE market_templates (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  market_type text NOT NULL CHECK (market_type IN ('binary', 'categorical', 'scalar')),
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE country_policies (
  jurisdiction text NOT NULL,
  category text NOT NULL,
  policy_version text NOT NULL,
  publication_allowed boolean NOT NULL DEFAULT false,
  trading_enabled boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  PRIMARY KEY (jurisdiction, category)
);

CREATE TABLE evidence_sources (
  name text NOT NULL,
  uri text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  PRIMARY KEY (name, uri)
);

CREATE TABLE policy_registry (
  kind text NOT NULL CHECK (kind IN ('eligibility', 'adjudication', 'bond', 'payout', 'collateral')),
  policy_ref text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  evidence_ref text NOT NULL,
  PRIMARY KEY (kind, policy_ref)
);

CREATE TABLE market_proposals (
  id uuid PRIMARY KEY,
  proposer_id uuid NOT NULL REFERENCES accounts(id),
  terms jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE markets (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES accounts(id),
  source_proposal_id uuid UNIQUE REFERENCES market_proposals(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'review', 'rejected', 'scheduled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  terms jsonb NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX markets_catalog ON markets(state, id);
CREATE INDEX markets_creator ON markets(creator_id);

CREATE TABLE market_reviews (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES markets(id),
  market_version integer NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES accounts(id),
  review_type text NOT NULL CHECK (review_type IN ('product', 'legal', 'integrity', 'resolution')),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  policy_hash text NOT NULL,
  reason text NOT NULL,
  evidence_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, market_version, review_type)
);

CREATE TABLE command_results (
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key),
  CHECK ((status_code IS NULL) = (response IS NULL))
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  authority text NOT NULL,
  action text NOT NULL,
  resource_id text NOT NULL,
  request_id text NOT NULL,
  reason text NOT NULL,
  evidence_ref text,
  before_state jsonb,
  after_state jsonb,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_resource ON audit_events(resource_id, created_at);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_deliveries (
  event_id uuid NOT NULL REFERENCES outbox(id),
  consumer text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  PRIMARY KEY (event_id, consumer)
);
CREATE TABLE inbox (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only record cannot be mutated'; END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER outbox_append_only BEFORE UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER review_append_only BEFORE UPDATE OR DELETE ON market_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION protect_published_market() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published market is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER published_market_immutable BEFORE UPDATE OR DELETE ON markets
  FOR EACH ROW EXECUTE FUNCTION protect_published_market();
