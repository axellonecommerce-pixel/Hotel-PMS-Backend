-- Database-level checks behind the API's own rules. Apply after 0025.
-- Safe to re-run.
--
-- 1. No double-booked room: a room cannot hold two active stays (reserved or
--    checked in) on overlapping nights. The API already checks this with row
--    locks when booking, moving, extending or reinstating; this trigger is
--    the backstop if a future code path forgets. It is checked when the
--    transaction commits, so a room move (free one room, take another) works.
-- 2. Basic value checks (valid statuses, departure not before arrival,
--    amounts not negative). Each is added only when no existing row breaks
--    it; otherwise it is skipped with a NOTICE, so old data never blocks
--    editing a reservation.

CREATE OR REPLACE FUNCTION public.innseva_room_overlap_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  room_ids uuid[];
  clash record;
BEGIN
  IF TG_TABLE_NAME = 'reservation_rooms' THEN
    room_ids := ARRAY[NEW.id];
  ELSE
    room_ids := ARRAY(SELECT id FROM reservation_rooms WHERE reservation_id = NEW.id);
  END IF;
  SELECT rm.number AS room_number, other.confirmation_number AS other_confirmation INTO clash
  FROM reservation_rooms rr
  JOIN reservations r ON r.id = rr.reservation_id
  JOIN reservation_rooms o ON o.room_id = rr.room_id AND o.id <> rr.id AND o.reservation_id <> rr.reservation_id
  JOIN reservations other ON other.id = o.reservation_id
  LEFT JOIN rooms rm ON rm.id = rr.room_id
  WHERE rr.id = ANY(room_ids)
    AND rr.room_id IS NOT NULL
    AND rr.status IN ('reserved', 'checked_in') AND r.status IN ('reserved', 'checked_in')
    AND o.status IN ('reserved', 'checked_in') AND other.status IN ('reserved', 'checked_in')
    -- Same rule as the API: a stay occupies at least one night.
    AND other.arrival_date < greatest(r.departure_date, r.arrival_date + 1)
    AND greatest(other.departure_date, other.arrival_date + 1) > r.arrival_date
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23P01',
      MESSAGE = format('Room %s is already booked for these dates (reservation %s).', coalesce(clash.room_number, '?'), clash.other_confirmation);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.innseva_room_overlap_check() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reservation_rooms_no_overlap ON public.reservation_rooms;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reservation_rooms_no_overlap
  AFTER INSERT OR UPDATE OF room_id, status ON public.reservation_rooms
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.innseva_room_overlap_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS reservations_no_overlap ON public.reservations;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reservations_no_overlap
  AFTER UPDATE OF arrival_date, departure_date, status ON public.reservations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.innseva_room_overlap_check();
--> statement-breakpoint

-- Value checks, each only when all existing rows already pass it.
DO $$
DECLARE
  item record;
  violations bigint;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('reservations', 'reservations_status_valid', 'status IN (''reserved'', ''checked_in'', ''checked_out'', ''no_show'', ''cancelled'')'),
    ('reservation_rooms', 'reservation_rooms_status_valid', 'status IN (''reserved'', ''checked_in'', ''checked_out'', ''no_show'', ''cancelled'')'),
    ('reservations', 'reservations_dates_valid', 'departure_date >= arrival_date'),
    ('refunds', 'refunds_amount_positive', 'amount_cents > 0'),
    ('security_deposits', 'security_deposits_amount_not_negative', 'amount_cents >= 0'),
    ('nightly_rates', 'nightly_rates_not_negative', 'final_rate_cents >= 0 AND base_rate_cents >= 0')
  ) AS t(table_name, constraint_name, condition) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.constraint_name) THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE NOT (%s)', item.table_name, item.condition) INTO violations;
    IF violations = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', item.table_name, item.constraint_name, item.condition);
    ELSE
      RAISE NOTICE 'Skipped % on %: % existing row(s) do not pass it.', item.constraint_name, item.table_name, violations;
    END IF;
  END LOOP;
END $$;
