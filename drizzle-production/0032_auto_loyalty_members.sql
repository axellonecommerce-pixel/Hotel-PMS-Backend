-- Every guest with a saved, active ID receives a stable loyalty member ID.
-- Reconcile completed paid stays using nights actually stayed (not day-use or
-- unused scheduled nights), then bring rewards back in line with the ledger.

INSERT INTO public.loyalty_programs (property_id,name,nights_required,reward_description)
SELECT p.id,p.name || ' Rewards',10,'One free night'
FROM public.properties p
WHERE EXISTS (
  SELECT 1 FROM public.guests g
  JOIN public.guest_identities gi ON gi.guest_id=g.id AND gi.property_id=g.property_id AND gi.deleted_at IS NULL
  WHERE g.property_id=p.id AND g.archived_at IS NULL AND g.guest_status <> 'do_not_rent'
)
ON CONFLICT (property_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO public.loyalty_memberships (property_id,guest_id,program_id,member_number)
SELECT g.property_id,g.id,lp.id,'INN-' || upper(g.id::text)
FROM public.guests g
JOIN public.loyalty_programs lp ON lp.property_id=g.property_id
WHERE g.archived_at IS NULL AND g.guest_status <> 'do_not_rent'
  AND EXISTS (
    SELECT 1 FROM public.guest_identities gi
    WHERE gi.guest_id=g.id AND gi.property_id=g.property_id AND gi.deleted_at IS NULL
  )
ON CONFLICT (property_id,guest_id) DO NOTHING;
--> statement-breakpoint

UPDATE public.loyalty_memberships lm
SET status=CASE WHEN lm.status='active' THEN 'paused' ELSE lm.status END,
  sms_consent=false,email_consent=false,updated_at=now()
FROM public.guests g
WHERE g.id=lm.guest_id AND g.property_id=lm.property_id AND g.guest_status='do_not_rent';
--> statement-breakpoint

UPDATE public.loyalty_wallet_passes wp
SET status='revoked',updated_at=now()
FROM public.loyalty_memberships lm
JOIN public.guests g ON g.id=lm.guest_id AND g.property_id=lm.property_id
WHERE wp.membership_id=lm.id AND wp.property_id=lm.property_id AND g.guest_status='do_not_rent';
--> statement-breakpoint

WITH completed AS (
  SELECT r.property_id,r.id AS reservation_id,r.main_guest_id,r.version,r.confirmation_number,
    greatest(
      least(
        r.departure_date,
        coalesce((SELECT max((rr.checked_out_at AT TIME ZONE p.timezone)::date) FROM public.reservation_rooms rr WHERE rr.reservation_id=r.id),r.departure_date)
      ) - r.arrival_date,
      0
    )::int AS actual_nights
  FROM public.reservations r
  JOIN public.properties p ON p.id=r.property_id
  WHERE r.status='checked_out'
    AND EXISTS (
      SELECT 1 FROM public.charges c JOIN public.folios f ON f.id=c.folio_id
      WHERE f.reservation_id=r.id AND c.status='posted' AND c.type='Room Rent' AND c.amount_cents>0
    )
), reconciled AS (
  SELECT c.*,lm.id AS membership_id,
    coalesce((
      SELECT sum(lt.nights_delta) FROM public.loyalty_transactions lt
      WHERE lt.membership_id=lm.id AND lt.reservation_id=c.reservation_id
        AND lt.type IN ('enrollment_credit','stay_credit','stay_reversal')
    ),0)::int AS credited_nights
  FROM completed c
  JOIN public.loyalty_memberships lm ON lm.property_id=c.property_id AND lm.guest_id=c.main_guest_id
)
INSERT INTO public.loyalty_transactions
  (property_id,membership_id,reservation_id,type,nights_delta,description,idempotency_key)
SELECT property_id,membership_id,reservation_id,
  CASE WHEN actual_nights-credited_nights > 0 THEN 'enrollment_credit' ELSE 'stay_reversal' END,
  actual_nights-credited_nights,
  CASE WHEN actual_nights-credited_nights > 0
    THEN 'Past stay ' || confirmation_number
    ELSE 'Corrected to nights actually stayed · ' || confirmation_number
  END,
  'auto-loyalty-0032:' || reservation_id::text || ':actual:' || actual_nights::text
FROM reconciled
WHERE actual_nights <> credited_nights
ON CONFLICT (property_id,idempotency_key) DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  member_row record;
  member_balance integer;
  reward_id uuid;
  reward_nights integer;
  reward_sequence integer;
BEGIN
  FOR member_row IN
    SELECT lm.id,lm.property_id,lm.program_id,lm.status,
      coalesce(lm.custom_nights_required,lp.nights_required)::int AS nights_required,
      coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) AS reward_description,
      lp.reward_value_cents,
      coalesce((SELECT sum(lt.nights_delta) FROM public.loyalty_transactions lt WHERE lt.membership_id=lm.id),0)::int AS balance
    FROM public.loyalty_memberships lm
    JOIN public.loyalty_programs lp ON lp.id=lm.program_id
  LOOP
    member_balance := member_row.balance;
    reward_id := NULL;
    reward_nights := NULL;
    WHILE member_balance < 0 LOOP
      SELECT lr.id,(-lt.nights_delta)::int INTO reward_id,reward_nights
      FROM public.loyalty_rewards lr
      JOIN public.loyalty_transactions lt ON lt.reward_id=lr.id AND lt.type='reward_issued'
      WHERE lr.membership_id=member_row.id AND lr.status='available'
      ORDER BY lr.issued_at DESC,lr.id DESC LIMIT 1;
      EXIT WHEN reward_id IS NULL OR reward_nights IS NULL OR reward_nights <= 0;
      UPDATE public.loyalty_rewards SET status='void',updated_at=now() WHERE id=reward_id;
      INSERT INTO public.loyalty_transactions
        (property_id,membership_id,reward_id,type,nights_delta,description,idempotency_key)
      VALUES
        (member_row.property_id,member_row.id,reward_id,'reward_voided',reward_nights,
         'Reward voided after qualifying-night correction','migration-0032-reward-voided:' || reward_id::text)
      ON CONFLICT (property_id,idempotency_key) DO NOTHING;
      SELECT coalesce(sum(nights_delta),0)::int INTO member_balance
      FROM public.loyalty_transactions WHERE membership_id=member_row.id;
      reward_id := NULL;
      reward_nights := NULL;
    END LOOP;

    IF member_row.status='active' THEN
      WHILE member_balance >= member_row.nights_required LOOP
        SELECT count(*)::int + 1 INTO reward_sequence FROM public.loyalty_rewards WHERE membership_id=member_row.id;
        INSERT INTO public.loyalty_rewards (property_id,membership_id,program_id,status,description,value_cents)
        VALUES (member_row.property_id,member_row.id,member_row.program_id,'available',member_row.reward_description,member_row.reward_value_cents)
        RETURNING id INTO reward_id;
        INSERT INTO public.loyalty_transactions
          (property_id,membership_id,reward_id,type,nights_delta,description,idempotency_key)
        VALUES
          (member_row.property_id,member_row.id,reward_id,'reward_issued',-member_row.nights_required,
           'Reward unlocked: ' || member_row.reward_description,'reward:' || member_row.id::text || ':' || reward_sequence::text);
        member_balance := member_balance - member_row.nights_required;
      END LOOP;
    END IF;
  END LOOP;
END $$;
