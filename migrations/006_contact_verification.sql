CREATE TABLE contact_verifications (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  channel text NOT NULL CHECK (channel IN ('email','phone')),
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[a-f0-9]{64}$'),
  provider_reference text,
  state text NOT NULL CHECK (state IN ('pending','delivery_uncertain','approved','expired','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_verification_account ON contact_verifications(account_id,channel,created_at DESC);

CREATE TABLE contact_verification_events (
  id uuid PRIMARY KEY,
  verification_id uuid REFERENCES contact_verifications(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  channel text NOT NULL CHECK (channel IN ('email','phone')),
  action text NOT NULL CHECK (action IN ('send','check')),
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[a-f0-9]{64}$'),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_verification_event_account ON contact_verification_events(account_id,action,created_at DESC);
CREATE INDEX contact_verification_event_destination ON contact_verification_events(destination_hash,action,created_at DESC);
CREATE INDEX contact_verification_event_ip ON contact_verification_events(ip_hash,action,created_at DESC);
CREATE TRIGGER contact_verification_event_append_only BEFORE UPDATE OR DELETE ON contact_verification_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_contact_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.channel <> OLD.channel OR
     NEW.destination_hash <> OLD.destination_hash OR NEW.created_at <> OLD.created_at OR
     NEW.expires_at <> OLD.expires_at OR NEW.resend_available_at <> OLD.resend_available_at THEN
    RAISE EXCEPTION 'Contact verification identity is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'Verification attempts are monotonic'; END IF;
  IF NOT ((NEW.state=OLD.state) OR
    (OLD.state IN ('pending','delivery_uncertain') AND NEW.state IN ('pending','delivery_uncertain','approved','expired','failed'))) THEN
    RAISE EXCEPTION 'Invalid contact verification transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contact_verification_guard BEFORE UPDATE ON contact_verifications
  FOR EACH ROW EXECUTE FUNCTION guard_contact_verification();
