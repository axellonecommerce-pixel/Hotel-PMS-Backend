-- Property-scoped guest loyalty: programs, memberships, immutable night
-- ledger, rewards, and revocable wallet-card links. Apply after 0030.

CREATE TABLE IF NOT EXISTS public.loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Loyalty Rewards',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  nights_required integer NOT NULL DEFAULT 10 CHECK (nights_required BETWEEN 1 AND 365),
  reward_type text NOT NULL DEFAULT 'free_night' CHECK (reward_type IN ('free_night','fixed_discount','percent_discount','member_rate')),
  reward_value_cents integer,
  reward_description text NOT NULL DEFAULT 'One free night',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES public.guests(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id),
  member_number text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  custom_nights_required integer CHECK (custom_nights_required BETWEEN 1 AND 365),
  custom_reward_description text,
  sms_consent boolean NOT NULL DEFAULT false,
  email_consent boolean NOT NULL DEFAULT false,
  consented_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, guest_id),
  UNIQUE (property_id, member_number)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_memberships_property_status
  ON public.loyalty_memberships(property_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','redeemed','expired','void')),
  description text NOT NULL,
  value_cents integer,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  reserved_at timestamptz,
  redeemed_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_rewards_member_status
  ON public.loyalty_rewards(membership_id, status, issued_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  reward_id uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('enrollment_credit','stay_credit','stay_reversal','manual_adjustment','reward_issued','reward_voided','redemption_reversal')),
  nights_delta integer NOT NULL CHECK (nights_delta <> 0),
  description text NOT NULL,
  idempotency_key text NOT NULL,
  actor_auth_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_transactions_member_time
  ON public.loyalty_transactions(membership_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_wallet_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('web','apple','google')),
  external_id text,
  token_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, platform),
  UNIQUE (token_hash)
);
--> statement-breakpoint

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['loyalty_programs','loyalty_memberships','loyalty_rewards','loyalty_transactions','loyalty_wallet_passes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "hotel data isolation" ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY "hotel data isolation" ON public.%I FOR ALL TO authenticated USING (property_id IN (SELECT public.current_property_ids())) WITH CHECK (property_id IN (SELECT public.current_property_ids()))',
      table_name
    );
    IF to_regprocedure('public.innseva_audit_row()') IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', table_name || '_audit', table_name);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.innseva_audit_row()', table_name || '_audit', table_name);
    END IF;
  END LOOP;
END $$;
