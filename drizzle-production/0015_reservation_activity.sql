-- HotelKey-style reservation activity log: who did what to a reservation and
-- when, in plain language, kept for the life of the reservation.
CREATE TABLE IF NOT EXISTS reservation_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  actor_auth_user_id uuid,
  actor_name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reservation_activity_reservation ON reservation_activity(reservation_id, created_at);
--> statement-breakpoint
ALTER TABLE public.reservation_activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS reservation_activity_tenant_isolation ON public.reservation_activity;
--> statement-breakpoint
CREATE POLICY reservation_activity_tenant_isolation
  ON public.reservation_activity
  FOR ALL
  TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
