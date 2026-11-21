import { z } from "zod";
import type { TransactionSql } from "postgres";

import { propertyAccessResponse, requirePropertySession, requireSettingsSection } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { issueAvailableRewards } from "@/server/loyalty/service";
import { recordChange } from "@/server/realtime/change-events";

const offerSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(3).max(120),
  audience: z.enum(["all", "local", "nearby", "inactive", "close_to_reward", "custom"]),
  nightsRequired: z.number().int().min(1).max(365),
  rewardType: z.enum(["free_night", "fixed_discount", "percent_discount", "member_rate"]),
  rewardValueCents: z.number().int().min(1).max(10_000_000).nullable(),
  rewardPercentBasisPoints: z.number().int().min(1).max(10_000).nullable(),
  rewardDescription: z.string().trim().min(3).max(160), terms: z.string().trim().max(2_000).nullable(),
  startsAt: z.string().datetime().nullable(), endsAt: z.string().datetime().nullable(),
  memberIds: z.array(z.string().uuid()).max(5_000).default([]),
}).superRefine((value, context) => {
  if ((value.rewardType === "fixed_discount" || value.rewardType === "member_rate") && !value.rewardValueCents) context.addIssue({ code: "custom", path: ["rewardValueCents"], message: "Enter a dollar value." });
  if (value.rewardType === "percent_discount" && !value.rewardPercentBasisPoints) context.addIssue({ code: "custom", path: ["rewardPercentBasisPoints"], message: "Enter a percentage." });
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) context.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after the start date." });
  if (value.audience === "custom" && !value.memberIds.length) context.addIssue({ code: "custom", path: ["memberIds"], message: "Choose at least one member." });
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), campaign: offerSchema }),
  z.object({ action: z.enum(["activate", "pause", "end", "delete"]), campaignId: z.string().uuid() }),
]);

async function readCampaigns(propertyId: string) {
  const sql = productionSql();
  const campaigns = await sql<Array<Record<string, unknown>>>`
    select lc.id,lc.name,lc.status,lc.audience,lc.nights_required as "nightsRequired",lc.reward_type as "rewardType",
      lc.reward_value_cents as "rewardValueCents",lc.reward_percent_basis_points as "rewardPercentBasisPoints",
      lc.reward_description as "rewardDescription",lc.terms,lc.starts_at::text as "startsAt",lc.ends_at::text as "endsAt",
      lc.created_at::text as "createdAt",lc.updated_at::text as "updatedAt",
      coalesce((select count(*) from loyalty_campaign_members lcm where lcm.campaign_id=lc.id),0)::int as "memberCount",
      coalesce((select jsonb_agg(lcm.membership_id) from loyalty_campaign_members lcm where lcm.campaign_id=lc.id),'[]'::jsonb) as "memberIds"
    from loyalty_campaigns lc where lc.property_id=${propertyId}::uuid order by lc.updated_at desc
  `;
  const members = await sql<Array<Record<string, unknown>>>`
    select lm.id,g.first_name as "firstName",g.last_name as "lastName",lm.member_number as "memberNumber",
      coalesce(g.address->>'city','') as city,coalesce(g.address->>'state','') as state,
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id),0),0)::int as "progressNights",
      eo.nights_required as "nightsRequired"
    from loyalty_memberships lm join guests g on g.id=lm.guest_id join loyalty_effective_offers eo on eo.membership_id=lm.id
    where lm.property_id=${propertyId}::uuid and lm.status='active' and g.guest_status<>'do_not_rent'
    order by g.last_name,g.first_name
  `;
  return { campaigns, members };
}

async function audienceMemberIds(tx: TransactionSql<Record<string, never>>, propertyId: string, campaignId: string, audience: string) {
  if (audience === "custom") return tx<Array<{ id: string }>>`select membership_id as id from loyalty_campaign_members where campaign_id=${campaignId}::uuid and property_id=${propertyId}::uuid`;
  return tx<Array<{ id: string }>>`
    select lm.id from loyalty_memberships lm join guests g on g.id=lm.guest_id
    join properties p on p.id=lm.property_id join loyalty_effective_offers eo on eo.membership_id=lm.id
    where lm.property_id=${propertyId}::uuid and lm.status='active' and g.guest_status<>'do_not_rent' and (
      ${audience}='all'
      or (${audience}='local' and nullif(lower(g.address->>'city'),'')=lower(p.city))
      or (${audience}='nearby' and nullif(lower(g.address->>'state'),'')=lower(p.state))
      or (${audience}='inactive' and not exists(select 1 from reservations r where r.main_guest_id=g.id and r.status='checked_out' and r.departure_date>=(now() at time zone p.timezone)::date-90))
      or (${audience}='close_to_reward' and greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id),0),0) between greatest(eo.nights_required-2,1) and eo.nights_required-1)
    )
  `;
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage"); requireSettingsSection(session, "Loyalty & Offers");
    return Response.json(await readCampaigns(session.propertyId));
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage"); requireSettingsSection(session, "Loyalty & Offers");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Campaign details are invalid." }, { status: 400 });
    const input = parsed.data;
    await productionSql().begin(async (tx) => {
      if (input.action === "save") {
        const campaign = input.campaign;
        const [saved] = campaign.id
          ? await tx<Array<{ id: string }>>`update loyalty_campaigns set name=${campaign.name},audience=${campaign.audience},nights_required=${campaign.nightsRequired},reward_type=${campaign.rewardType},reward_value_cents=${campaign.rewardValueCents},reward_percent_basis_points=${campaign.rewardPercentBasisPoints},reward_description=${campaign.rewardDescription},terms=${campaign.terms},starts_at=${campaign.startsAt},ends_at=${campaign.endsAt},updated_at=now() where id=${campaign.id}::uuid and property_id=${session.propertyId}::uuid and status<>'ended' returning id`
          : await tx<Array<{ id: string }>>`insert into loyalty_campaigns (property_id,name,audience,nights_required,reward_type,reward_value_cents,reward_percent_basis_points,reward_description,terms,starts_at,ends_at) values (${session.propertyId}::uuid,${campaign.name},${campaign.audience},${campaign.nightsRequired},${campaign.rewardType},${campaign.rewardValueCents},${campaign.rewardPercentBasisPoints},${campaign.rewardDescription},${campaign.terms},${campaign.startsAt},${campaign.endsAt}) returning id`;
        if (!saved) throw new Error("Campaign not found or already ended.");
        if (campaign.audience === "custom") {
          await tx`delete from loyalty_campaign_members where campaign_id=${saved.id}::uuid and property_id=${session.propertyId}::uuid`;
          if (campaign.memberIds.length) await tx`insert into loyalty_campaign_members (property_id,campaign_id,membership_id) select ${session.propertyId}::uuid,${saved.id}::uuid,id from loyalty_memberships where property_id=${session.propertyId}::uuid and id=any(${campaign.memberIds}::uuid[]) and status='active' on conflict do nothing`;
        }
        return;
      }
      const [campaign] = await tx<Array<{ id: string; audience: string; status: string }>>`select id,audience,status from loyalty_campaigns where id=${input.campaignId}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!campaign) throw new Error("Campaign not found.");
      if (input.action === "delete") { if (campaign.status === "active") throw new Error("Pause an active campaign before deleting it."); await tx`delete from loyalty_campaigns where id=${campaign.id}::uuid`; return; }
      if (input.action === "pause" || input.action === "end") { await tx`update loyalty_campaigns set status=${input.action === "pause" ? "paused" : "ended"},updated_at=now() where id=${campaign.id}::uuid`; return; }
      await tx`update loyalty_campaigns set status='paused',updated_at=now() where property_id=${session.propertyId}::uuid and status='active' and id<>${campaign.id}::uuid`;
      if (campaign.audience !== "custom") {
        const matched = await audienceMemberIds(tx, session.propertyId, campaign.id, campaign.audience);
        await tx`delete from loyalty_campaign_members where campaign_id=${campaign.id}::uuid and property_id=${session.propertyId}::uuid`;
        if (matched.length) await tx`insert into loyalty_campaign_members (property_id,campaign_id,membership_id) select ${session.propertyId}::uuid,${campaign.id}::uuid,id from loyalty_memberships where id=any(${matched.map((member) => member.id)}::uuid[]) on conflict do nothing`;
      }
      await tx`update loyalty_campaigns set status='active',updated_at=now() where id=${campaign.id}::uuid`;
      const members = await tx<Array<{ id: string; programId: string; nightsRequired: number; rewardDescription: string; rewardType: string; rewardValueCents: number | null; rewardPercentBasisPoints: number | null; terms: string | null; rewardExpiresDays: number | null }>>`
        select lm.id,lm.program_id as "programId",eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",eo.reward_type as "rewardType",eo.reward_value_cents as "rewardValueCents",eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,eo.reward_expires_days as "rewardExpiresDays"
        from loyalty_campaign_members lcm join loyalty_memberships lm on lm.id=lcm.membership_id join loyalty_effective_offers eo on eo.membership_id=lm.id
        where lcm.campaign_id=${campaign.id}::uuid and lm.status='active' for update of lm
      `;
      for (const member of members) await issueAvailableRewards(tx, session.propertyId, member, session.authUserId);
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: { section: "Loyalty campaigns" } });
    return Response.json(await readCampaigns(session.propertyId));
  } catch (error) {
    if (error instanceof Error && /campaign|pause/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
