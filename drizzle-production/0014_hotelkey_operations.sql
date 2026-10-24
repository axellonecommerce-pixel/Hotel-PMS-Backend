-- HotelKey operations: rate calendar, paid outs, house accounts, folio
-- transfers, lost and found, and preventive maintenance.

CREATE TABLE IF NOT EXISTS rate_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- Settings room-type id ("room-type-…"), the id rate plans are keyed by.
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  rate_cents integer CHECK (rate_cents IS NULL OR rate_cents >= 0),
  min_stay integer CHECK (min_stay IS NULL OR min_stay BETWEEN 1 AND 60),
  closed boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (property_id, room_type_id, stay_date)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS paid_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  paid_to text NOT NULL,
  reason text NOT NULL,
  note text,
  created_by_auth_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS paid_outs_property_date ON paid_outs(property_id, business_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS house_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'permanent' CHECK (kind IN ('permanent', 'temporary')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes text,
  closed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS house_account_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  house_account_id uuid NOT NULL REFERENCES house_accounts(id) ON DELETE CASCADE,
  charge_type text NOT NULL,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN IF NOT EXISTS house_account_id uuid REFERENCES house_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS folio_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('charge', 'payment')),
  charge_id uuid REFERENCES charges(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES payments(id) ON DELETE CASCADE,
  from_folio_id uuid NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  to_folio_id uuid NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  business_date date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lost_found_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  item text NOT NULL,
  description text,
  location text NOT NULL,
  found_date date NOT NULL,
  found_by text NOT NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  guest_name text,
  storage_location text,
  status text NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'returned', 'disposed')),
  closed_date date,
  closed_by text,
  closed_note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- NULL means a property-wide task (pool, boiler, parking lot).
  room_number text,
  frequency_days integer NOT NULL CHECK (frequency_days BETWEEN 1 AND 730),
  next_due_date date NOT NULL,
  last_done_date date,
  last_done_by text,
  notes text,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['rate_calendar','paid_outs','house_accounts','house_account_charges','folio_transfers','lost_found_items','maintenance_schedules']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_tenant_isolation', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (property_id IN (SELECT public.current_property_ids())) WITH CHECK (property_id IN (SELECT public.current_property_ids()))', table_name || '_tenant_isolation', table_name);
  END LOOP;
END $$;
