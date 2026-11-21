-- Optional earning-period caps for property, campaign, and customer offers.
-- A customer override wins first, then an active campaign, then the property default.

ALTER TABLE public.loyalty_programs
  ADD COLUMN IF NOT EXISTS qualification_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS qualification_days integer,
  ADD COLUMN IF NOT EXISTS qualification_starts_on date,
  ADD COLUMN IF NOT EXISTS qualification_ends_on date,
  ADD COLUMN IF NOT EXISTS qualification_anchor_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE public.loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_qualification_type_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs ADD CONSTRAINT loyalty_programs_qualification_type_check CHECK (qualification_type IN ('none','days','date_range'));
--> statement-breakpoint
ALTER TABLE public.loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_qualification_days_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs ADD CONSTRAINT loyalty_programs_qualification_days_check CHECK (qualification_days IS NULL OR qualification_days BETWEEN 1 AND 3650);
--> statement-breakpoint
ALTER TABLE public.loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_qualification_dates_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs ADD CONSTRAINT loyalty_programs_qualification_dates_check CHECK (qualification_starts_on IS NULL OR qualification_ends_on IS NULL OR qualification_ends_on >= qualification_starts_on);
--> statement-breakpoint

ALTER TABLE public.loyalty_memberships
  ADD COLUMN IF NOT EXISTS custom_qualification_type text,
  ADD COLUMN IF NOT EXISTS custom_qualification_days integer,
  ADD COLUMN IF NOT EXISTS custom_qualification_starts_on date,
  ADD COLUMN IF NOT EXISTS custom_qualification_ends_on date,
  ADD COLUMN IF NOT EXISTS custom_qualification_anchor_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_qualification_type_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_qualification_type_check CHECK (custom_qualification_type IS NULL OR custom_qualification_type IN ('none','days','date_range'));
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_qualification_days_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_qualification_days_check CHECK (custom_qualification_days IS NULL OR custom_qualification_days BETWEEN 1 AND 3650);
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships DROP CONSTRAINT IF EXISTS loyalty_memberships_custom_qualification_dates_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_memberships ADD CONSTRAINT loyalty_memberships_custom_qualification_dates_check CHECK (custom_qualification_starts_on IS NULL OR custom_qualification_ends_on IS NULL OR custom_qualification_ends_on >= custom_qualification_starts_on);
--> statement-breakpoint

ALTER TABLE public.loyalty_campaigns
  ADD COLUMN IF NOT EXISTS qualification_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS qualification_days integer,
  ADD COLUMN IF NOT EXISTS qualification_starts_on date,
  ADD COLUMN IF NOT EXISTS qualification_ends_on date,
  ADD COLUMN IF NOT EXISTS qualification_anchor_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns DROP CONSTRAINT IF EXISTS loyalty_campaigns_qualification_type_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns ADD CONSTRAINT loyalty_campaigns_qualification_type_check CHECK (qualification_type IN ('none','days','date_range'));
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns DROP CONSTRAINT IF EXISTS loyalty_campaigns_qualification_days_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns ADD CONSTRAINT loyalty_campaigns_qualification_days_check CHECK (qualification_days IS NULL OR qualification_days BETWEEN 1 AND 3650);
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns DROP CONSTRAINT IF EXISTS loyalty_campaigns_qualification_dates_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_campaigns ADD CONSTRAINT loyalty_campaigns_qualification_dates_check CHECK (qualification_starts_on IS NULL OR qualification_ends_on IS NULL OR qualification_ends_on >= qualification_starts_on);
--> statement-breakpoint

CREATE OR REPLACE VIEW public.loyalty_effective_offers WITH (security_invoker=true) AS
SELECT lm.property_id,lm.id AS membership_id,lm.program_id,
  active_campaign.id AS campaign_id,active_campaign.name AS campaign_name,
  coalesce(lm.custom_nights_required,active_campaign.nights_required,lp.nights_required)::int AS nights_required,
  coalesce(nullif(lm.custom_reward_description,''),active_campaign.reward_description,lp.reward_description) AS reward_description,
  coalesce(lm.custom_reward_type,active_campaign.reward_type,lp.reward_type) AS reward_type,
  coalesce(lm.custom_reward_value_cents,active_campaign.reward_value_cents,lp.reward_value_cents) AS reward_value_cents,
  coalesce(lm.custom_reward_percent_basis_points,active_campaign.reward_percent_basis_points,lp.reward_percent_basis_points) AS reward_percent_basis_points,
  coalesce(lm.custom_terms,active_campaign.terms,lp.terms) AS terms,
  coalesce(lm.custom_reward_expires_days,lp.reward_expires_days) AS reward_expires_days,
  CASE WHEN lm.custom_qualification_type IS NOT NULL THEN lm.custom_qualification_type
       WHEN active_campaign.id IS NOT NULL THEN active_campaign.qualification_type
       ELSE lp.qualification_type END AS qualification_type,
  CASE WHEN lm.custom_qualification_type IS NOT NULL THEN lm.custom_qualification_days
       WHEN active_campaign.id IS NOT NULL THEN active_campaign.qualification_days
       ELSE lp.qualification_days END AS qualification_days,
  CASE WHEN lm.custom_qualification_type IS NOT NULL THEN lm.custom_qualification_starts_on
       WHEN active_campaign.id IS NOT NULL THEN active_campaign.qualification_starts_on
       ELSE lp.qualification_starts_on END AS qualification_starts_on,
  CASE WHEN lm.custom_qualification_type IS NOT NULL THEN lm.custom_qualification_ends_on
       WHEN active_campaign.id IS NOT NULL THEN active_campaign.qualification_ends_on
       ELSE lp.qualification_ends_on END AS qualification_ends_on,
  CASE WHEN lm.custom_qualification_type IS NOT NULL THEN coalesce(lm.custom_qualification_anchor_at,lm.updated_at)
       WHEN active_campaign.id IS NOT NULL THEN active_campaign.qualification_anchor_at
       ELSE greatest(lm.joined_at,lp.qualification_anchor_at) END AS qualification_anchor_at
FROM public.loyalty_memberships lm
JOIN public.loyalty_programs lp ON lp.id=lm.program_id
LEFT JOIN LATERAL (
  SELECT lc.* FROM public.loyalty_campaign_members lcm
  JOIN public.loyalty_campaigns lc ON lc.id=lcm.campaign_id AND lc.property_id=lcm.property_id
  WHERE lcm.membership_id=lm.id AND lc.status='active'
    AND (lc.starts_at IS NULL OR lc.starts_at<=now()) AND (lc.ends_at IS NULL OR lc.ends_at>now())
  ORDER BY lc.updated_at DESC,lc.id DESC LIMIT 1
) active_campaign ON true;
--> statement-breakpoint
REVOKE ALL ON public.loyalty_effective_offers FROM anon,authenticated;
--> statement-breakpoint

CREATE OR REPLACE VIEW public.loyalty_member_progress WITH (security_invoker=true) AS
WITH bounds AS (
  SELECT eo.*,
    CASE WHEN eo.qualification_type='days' THEN (eo.qualification_anchor_at AT TIME ZONE p.timezone)::date
         WHEN eo.qualification_type='date_range' THEN eo.qualification_starts_on END AS effective_starts_on,
    CASE WHEN eo.qualification_type='days' THEN (eo.qualification_anchor_at AT TIME ZONE p.timezone)::date + eo.qualification_days - 1
         WHEN eo.qualification_type='date_range' THEN eo.qualification_ends_on END AS effective_ends_on,
    (now() AT TIME ZONE p.timezone)::date AS property_today,p.timezone
  FROM public.loyalty_effective_offers eo JOIN public.properties p ON p.id=eo.property_id
), scored AS (
  SELECT b.*,
    CASE
      WHEN lt.id IS NULL THEN 0
      WHEN b.qualification_type='none' THEN lt.nights_delta
      WHEN lt.type IN ('enrollment_credit','stay_credit','stay_reversal')
        AND coalesce(r.departure_date,(lt.created_at AT TIME ZONE b.timezone)::date) BETWEEN b.effective_starts_on AND b.effective_ends_on THEN lt.nights_delta
      WHEN lt.type IN ('reward_issued','reward_voided')
        AND (lt.created_at AT TIME ZONE b.timezone)::date >= b.effective_starts_on THEN lt.nights_delta
      WHEN lt.type='manual_adjustment'
        AND (lt.created_at AT TIME ZONE b.timezone)::date BETWEEN b.effective_starts_on AND b.effective_ends_on THEN lt.nights_delta
      ELSE 0
    END::int AS effective_delta
  FROM bounds b
  LEFT JOIN public.loyalty_transactions lt ON lt.membership_id=b.membership_id AND lt.property_id=b.property_id
  LEFT JOIN public.reservations r ON r.id=lt.reservation_id
)
SELECT s.property_id,s.membership_id,s.program_id,s.campaign_id,s.campaign_name,s.nights_required,
  s.qualification_type,s.qualification_days,s.effective_starts_on,s.effective_ends_on,
  CASE WHEN s.qualification_type='none' THEN 'unlimited'
       WHEN s.property_today < s.effective_starts_on THEN 'upcoming'
       WHEN s.property_today > s.effective_ends_on THEN 'ended'
       ELSE 'active' END AS qualification_status,
  coalesce(sum(s.effective_delta),0)::int AS raw_progress_nights,
  greatest(coalesce(sum(s.effective_delta),0),0)::int AS progress_nights
FROM scored s
GROUP BY s.property_id,s.membership_id,s.program_id,s.campaign_id,s.campaign_name,s.nights_required,
  s.qualification_type,s.qualification_days,s.effective_starts_on,s.effective_ends_on,s.property_today;
--> statement-breakpoint
REVOKE ALL ON public.loyalty_member_progress FROM anon,authenticated;
