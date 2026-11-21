-- Connect reward redemption to folios and make campaign lookup efficient.
-- The charge/tax snapshots let a mistaken redemption be reversed exactly.

ALTER TABLE public.loyalty_rewards
  ADD COLUMN IF NOT EXISTS charge_id uuid REFERENCES public.charges(id),
  ADD COLUMN IF NOT EXISTS applied_discount_cents integer,
  ADD COLUMN IF NOT EXISTS applied_tax_cents integer;
--> statement-breakpoint
ALTER TABLE public.loyalty_rewards DROP CONSTRAINT IF EXISTS loyalty_rewards_applied_discount_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_applied_discount_check CHECK (applied_discount_cents IS NULL OR applied_discount_cents > 0);
--> statement-breakpoint
ALTER TABLE public.loyalty_rewards DROP CONSTRAINT IF EXISTS loyalty_rewards_applied_tax_check;
--> statement-breakpoint
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_applied_tax_check CHECK (applied_tax_cents IS NULL OR applied_tax_cents >= 0);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS loyalty_campaign_members_membership ON public.loyalty_campaign_members(membership_id,campaign_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_rewards_reservation ON public.loyalty_rewards(property_id,reservation_id,redeemed_at);
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
  coalesce(lm.custom_reward_expires_days,lp.reward_expires_days) AS reward_expires_days
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
