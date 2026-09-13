ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_state_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_state_check CHECK (state IN
  ('reserved','submitting','submitted','uncertain','finalized','cancelled','exception'));

CREATE OR REPLACE FUNCTION guard_withdrawal_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.reservation_id <> OLD.reservation_id OR
    NEW.asset_code <> OLD.asset_code OR NEW.amount_minor <> OLD.amount_minor OR
    NEW.destination_ref <> OLD.destination_ref OR NEW.rail <> OLD.rail OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Withdrawal identity is immutable';
  END IF;
  IF NOT ((NEW.state = OLD.state) OR
    (OLD.state = 'reserved' AND NEW.state IN ('submitting','submitted','cancelled','exception')) OR
    (OLD.state = 'submitting' AND NEW.state IN ('submitted','uncertain','exception')) OR
    (OLD.state = 'submitted' AND NEW.state IN ('uncertain','finalized','exception')) OR
    (OLD.state = 'uncertain' AND NEW.state IN ('submitted','finalized','exception'))) THEN
    RAISE EXCEPTION 'Invalid withdrawal state transition';
  END IF;
  RETURN NEW;
END;
$$;
