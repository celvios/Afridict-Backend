CREATE FUNCTION check_reservation_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.asset_code <> OLD.asset_code OR
     NEW.purpose <> OLD.purpose OR NEW.reference_id <> OLD.reference_id OR NEW.amount <> OLD.amount OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Reservation identity is immutable';
  END IF;
  IF NEW.consumed < OLD.consumed OR NEW.released < OLD.released THEN
    RAISE EXCEPTION 'Reservation consumption and release are monotonic';
  END IF;
  IF NOT ((NEW.state = OLD.state) OR
    (OLD.state = 'held' AND NEW.state IN ('partially_consumed','consumed','release_pending')) OR
    (OLD.state = 'partially_consumed' AND NEW.state IN ('partially_consumed','consumed','release_pending')) OR
    (OLD.state = 'release_pending' AND NEW.state IN ('release_pending','released'))) THEN
    RAISE EXCEPTION 'Invalid reservation state transition';
  END IF;
  IF NEW.state = 'released' AND NEW.consumed+NEW.released <> NEW.amount THEN
    RAISE EXCEPTION 'Released reservation has remaining exposure';
  END IF;
  IF NEW.state = 'consumed' AND NEW.consumed+NEW.released <> NEW.amount THEN
    RAISE EXCEPTION 'Consumed reservation has remaining exposure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reservation_state_guard BEFORE UPDATE ON collateral_reservations
  FOR EACH ROW EXECUTE FUNCTION check_reservation_state();

CREATE FUNCTION reject_financial_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.asset_code <> OLD.asset_code OR
    NEW.target_minor <> OLD.target_minor OR NEW.rail <> OLD.rail OR
    NEW.beneficiary_ref <> OLD.beneficiary_ref OR NEW.expires_at <> OLD.expires_at OR
    NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Deposit intent identity is immutable';
  END IF;
  IF NOT ((NEW.state = OLD.state) OR
    (OLD.state = 'awaiting_partner' AND NEW.state IN ('partner_confirmed','expired','exception')) OR
    (OLD.state = 'partner_confirmed' AND NEW.state IN ('chain_observed','reconciled_available','exception')) OR
    (OLD.state = 'chain_observed' AND NEW.state IN ('reconciled_available','exception'))) THEN
    RAISE EXCEPTION 'Invalid deposit state transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deposit_identity_guard BEFORE UPDATE ON deposit_intents
  FOR EACH ROW EXECUTE FUNCTION reject_financial_identity_change();

CREATE FUNCTION guard_withdrawal_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id OR NEW.reservation_id <> OLD.reservation_id OR
    NEW.asset_code <> OLD.asset_code OR NEW.amount_minor <> OLD.amount_minor OR
    NEW.destination_ref <> OLD.destination_ref OR NEW.rail <> OLD.rail OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Withdrawal identity is immutable';
  END IF;
  IF NOT ((NEW.state = OLD.state) OR
    (OLD.state = 'reserved' AND NEW.state IN ('submitted','cancelled','exception')) OR
    (OLD.state = 'submitted' AND NEW.state IN ('uncertain','finalized','exception')) OR
    (OLD.state = 'uncertain' AND NEW.state IN ('submitted','finalized','exception'))) THEN
    RAISE EXCEPTION 'Invalid withdrawal state transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER withdrawal_change_guard BEFORE UPDATE ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_change();
