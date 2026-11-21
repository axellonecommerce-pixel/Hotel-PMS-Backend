-- Self-service property offers, complete per-customer overrides, campaigns,
-- reminder history, and reward snapshots. Apply after 0032.

ALTER TABLE public.loyalty_programs
  ADD COLUMN IF NOT EXISTS reward_percent_basis_points integer,
  ADD COLUMN IF NOT EXISTS terms text,
  ADD COLUMN IF NOT EXISTS reward_expires_days integer,
  ADD COLUMN IF NOT EXISTS reminder_settings jsonb NOT NULL DEFAULT '{"enabled":false,"nightsRemaining":[2,1],"sendRewardReady":true,"smsTemplate":"Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.","emailSubject":"Your loyalty progress","emailTemplate":"Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}."}'::jsonb;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_reward_percent_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs ADD CONSTRAINT loyalty_programs_reward_percent_check CHECK (reward_percent_basis_points IS NULL OR reward_percent_basis_points BETWEEN 1 AND 10000);
--> statement-breakpoint
ALTER TABLE public.loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_reward_expiry_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs ADD CONSTRAINT loyalty_programs_reward_expiry_check CHECK (reward_expires_days IS NULL OR reward_expires_days BETWEEN 1 AND 3650);
--> statement-breakpoint

ALTER TABLE public.loyalty_memberships
  ADD COLUMN IF NOT EXISTS custom_reward_type text,
  ADD COLUMN IF NOT EXISTS custom_reward_value_cents integer,
  ADD COLUMN IF NOT EXISTS custom_reward_percent_basis_points integer,
  ADD COLUMN IF NOT EXISTS custom_terms text,
  ADD COLUMN IF NOT EXISTS custom_reward_expires_days integer;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_reward_type_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_reward_type_check CHECK (custom_reward_type IS NULL OR custom_reward_type IN ('free_night','fixed_discount','percent_discount','member_rate'));
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_reward_percent_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_reward_percent_check CHECK (custom_reward_percent_basis_points IS NULL OR custom_reward_percent_basis_points BETWEEN 1 AND 10000);
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_reward_expiry_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_reward_expiry_check CHECK (custom_reward_expires_days IS NULL OR custom_reward_expires_days BETWEEN 1 AND 3650);
--> statement-breakpoint

ALTER TABLE public.loyalty_rewards
  ADD COLUMN IF NOT EXISTS reward_type text NOT NULL DEFAULT 'free_night',
  ADD COLUMN IF NOT EXISTS percent_basis_points integer,
  ADD COLUMN IF NOT EXISTS terms text,
  ADD COLUMN IF NOT EXISTS redemption_note text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.loyalty_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  audience text NOT NULL DEFAULT 'custom' CHECK (audience IN ('all','local','nearby','inactive','close_to_reward','custom')),
  nights_required integer CHECK (nights_required BETWEEN 1 AND 365),
  reward_type text CHECK (reward_type IN ('free_night','fixed_discount','percent_discount','member_rate')),
  reward_value_cents integer,
  reward_percent_basis_points integer CHECK (reward_percent_basis_points BETWEEN 1 AND 10000),
  reward_description text,
  terms text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_campaigns_property_status ON public.loyalty_campaigns(property_id,status,starts_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_campaign_members (
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.loyalty_campaigns(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id,membership_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.loyalty_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
  subject text,
  message text NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  idempotency_key text NOT NULL,
  actor_auth_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id,idempotency_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_reminders_due ON public.loyalty_reminders(status,scheduled_for);
--> statement-breakpoint

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['loyalty_campaigns','loyalty_campaign_members','loyalty_reminders'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',table_name);
    EXECUTE format('DROP POLICY IF EXISTS "hotel data isolation" ON public.%I',table_name);
    EXECUTE format('CREATE POLICY "hotel data isolation" ON public.%I FOR ALL TO authenticated USING (property_id IN (SELECT public.current_property_ids())) WITH CHECK (property_id IN (SELECT public.current_property_ids()))',table_name);
    IF to_regprocedure('public.innseva_audit_row()') IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',table_name || '_audit',table_name);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.innseva_audit_row()',table_name || '_audit',table_name);
    END IF;
  END LOOP;
END $$;
