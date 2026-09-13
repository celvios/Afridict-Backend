CREATE TABLE private_payout_details (
  withdrawal_id uuid PRIMARY KEY REFERENCES withdrawals(id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  key_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER private_payout_details_immutable BEFORE UPDATE OR DELETE ON private_payout_details
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
