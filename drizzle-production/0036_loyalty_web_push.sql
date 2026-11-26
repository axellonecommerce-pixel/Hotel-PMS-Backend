CREATE TABLE IF NOT EXISTS public.loyalty_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES public.loyalty_memberships(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  endpoint_hash text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  card_path text NOT NULL CHECK (card_path ~ '^/l/[A-Za-z0-9_-]{32,100}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, endpoint_hash)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_push_subscriptions_member_active ON public.loyalty_push_subscriptions(membership_id,status);
--> statement-breakpoint
ALTER TABLE public.loyalty_push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.loyalty_push_subscriptions FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.loyalty_reminders DROP CONSTRAINT IF EXISTS loyalty_reminders_channel_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_reminders ADD CONSTRAINT loyalty_reminders_channel_check CHECK (channel IN ('sms','email','push'));
--> statement-breakpoint
DO $$ BEGIN
  IF to_regprocedure('public.innseva_audit_row()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS loyalty_push_subscriptions_audit ON public.loyalty_push_subscriptions;
    CREATE TRIGGER loyalty_push_subscriptions_audit AFTER INSERT OR UPDATE OR DELETE ON public.loyalty_push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.innseva_audit_row();
  END IF;
END $$;
