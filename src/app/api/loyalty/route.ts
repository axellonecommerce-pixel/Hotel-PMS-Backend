import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { ensureLoyaltyMembership, issueAvailableRewards } from "@/server/loyalty/service";
import { applyLoyaltyReward, restoreLoyaltyReward } from "@/server/loyalty/redemption";
import { recordChange } from "@/server/realtime/change-events";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enroll"), guestId: z.string().uuid(), nightsRequired: z.number().int().min(1).max(365).default(10), rewardDescription: z.string().trim().min(3).max(160).default("One free night"), smsConsent: z.boolean().default(false), emailConsent: z.boolean().default(false) }),
  z.object({ action: z.literal("adjust"), membershipId: z.string().uuid(), nightsDelta: z.number().int().min(-365).max(365).refine((value) => value !== 0), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal("update"), membershipId: z.string().uuid(), status: z.enum(["active", "paused", "closed"]).optional(), customNightsRequired: z.number().int().min(1).max(365).nullable().optional(), customRewardDescription: z.string().trim().max(160).nullable().optional(), customRewardType: z.enum(["free_night", "fixed_discount", "percent_discount", "member_rate"]).nullable().optional(), customRewardValueCents: z.number().int().min(1).max(10_000_000).nullable().optional(), customRewardPercentBasisPoints: z.number().int().min(1).max(10_000).nullable().optional(), customTerms: z.string().trim().max(2_000).nullable().optional(), customRewardExpiresDays: z.number().int().min(1).max(3_650).nullable().optional(), customQualificationType: z.enum(["none", "days", "date_range"]).nullable().optional(), customQualificationDays: z.number().int().min(1).max(3_650).nullable().optional(), customQualificationStartsOn: z.string().date().nullable().optional(), customQualificationEndsOn: z.string().date().nullable().optional(), smsConsent: z.boolean().optional(), emailConsent: z.boolean().optional() }),
  z.object({ action: z.literal("wallet_link"), membershipId: z.string().uuid() }),
  z.object({ action: z.literal("redeem_reward"), membershipId: z.string().uuid(), rewardId: z.string().uuid(), reservationId: z.string().uuid() }),
  z.object({ action: z.literal("restore_reward"), membershipId: z.string().uuid(), rewardId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }),
]);

async function details(propertyId: string, guestId: string) {
  const sql = productionSql();
  const [membership] = await sql<Array<Record<string, unknown>>>`
    select lm.id as "membershipId",lm.guest_id as "guestId",lm.member_number as "memberNumber",lm.status,
      lm.sms_consent as "smsConsent",lm.email_consent as "emailConsent",lm.joined_at::text as "joinedAt",
      lm.custom_nights_required as "customNightsRequired",lm.custom_reward_description as "customRewardDescription",
      lm.custom_reward_type as "customRewardType",lm.custom_reward_value_cents as "customRewardValueCents",
      lm.custom_reward_percent_basis_points as "customRewardPercentBasisPoints",lm.custom_terms as "customTerms",
      lm.custom_reward_expires_days as "customRewardExpiresDays",
      lm.custom_qualification_type as "customQualificationType",lm.custom_qualification_days as "customQualificationDays",
      lm.custom_qualification_starts_on::text as "customQualificationStartsOn",lm.custom_qualification_ends_on::text as "customQualificationEndsOn",
      lp.name as "programName",lp.nights_required as "programNightsRequired",lp.reward_description as "programRewardDescription",
      lp.reward_type as "programRewardType",lp.reward_value_cents as "programRewardValueCents",
      lp.reward_percent_basis_points as "programRewardPercentBasisPoints",lp.terms as "programTerms",
      lp.reward_expires_days as "programRewardExpiresDays",
      lp.qualification_type as "programQualificationType",lp.qualification_days as "programQualificationDays",
      lp.qualification_starts_on::text as "programQualificationStartsOn",lp.qualification_ends_on::text as "programQualificationEndsOn",
      eo.campaign_name as "campaignName",eo.nights_required as "nightsRequired",
      eo.reward_description as "rewardDescription",eo.reward_type as "rewardType",
      eo.reward_value_cents as "rewardValueCents",eo.reward_percent_basis_points as "rewardPercentBasisPoints",
      eo.terms,eo.reward_expires_days as "rewardExpiresDays",eo.qualification_type as "qualificationType",
      eo.qualification_days as "qualificationDays",lmp.effective_starts_on::text as "qualificationStartsOn",
      lmp.effective_ends_on::text as "qualificationEndsOn",lmp.qualification_status as "qualificationStatus",
      lmp.progress_nights as "progressNights",
      greatest(coalesce((select sum(lt.nights_delta) from loyalty_transactions lt where lt.membership_id=lm.id and lt.type in ('enrollment_credit','stay_credit','stay_reversal')),0),0)::int as "totalQualifyingNights",
      (select count(*)::int from loyalty_rewards lr where lr.membership_id=lm.id and lr.status='available' and (lr.expires_at is null or lr.expires_at>now())) as "availableRewards"
    from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
    join loyalty_effective_offers eo on eo.membership_id=lm.id
    join loyalty_member_progress lmp on lmp.membership_id=lm.id
    where lm.property_id=${propertyId}::uuid and lm.guest_id=${guestId}::uuid
  `;
  if (!membership) return null;
  const membershipId = String(membership.membershipId);
  const transactions = await sql<Array<Record<string, unknown>>>`
    select lt.id,lt.type,lt.nights_delta as "nightsDelta",lt.description,lt.created_at::text as "createdAt",
      r.confirmation_number as "confirmationNumber"
    from loyalty_transactions lt left join reservations r on r.id=lt.reservation_id
    where lt.property_id=${propertyId}::uuid and lt.membership_id=${membershipId}::uuid
    order by lt.created_at desc,lt.id desc limit 200
  `;
  const rewards = await sql<Array<Record<string, unknown>>>`
    select lr.id,lr.status,lr.description,lr.value_cents as "valueCents",lr.reward_type as "rewardType",
      lr.percent_basis_points as "percentBasisPoints",lr.terms,lr.issued_at::text as "issuedAt",
      lr.reserved_at::text as "reservedAt",lr.redeemed_at::text as "redeemedAt",lr.expires_at::text as "expiresAt",
      lr.applied_discount_cents as "appliedDiscountCents",lr.applied_tax_cents as "appliedTaxCents",lr.redemption_note as "redemptionNote",
      r.confirmation_number as "confirmationNumber"
    from loyalty_rewards lr left join reservations r on r.id=lr.reservation_id
    where lr.property_id=${propertyId}::uuid and lr.membership_id=${membershipId}::uuid
    order by lr.issued_at desc
  `;
  const wallet = await sql<Array<Record<string, unknown>>>`
    select platform,status,created_at::text as "createdAt",last_synced_at::text as "lastSyncedAt"
    from loyalty_wallet_passes where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid
  `;
  const eligibleReservations = await sql<Array<Record<string, unknown>>>`
    select r.id,r.confirmation_number as "confirmationNumber",r.status,r.arrival_date::text as "arrivalDate",r.departure_date::text as "departureDate",
      (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)
       -coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0))::int as "balanceCents"
    from reservations r where r.property_id=${propertyId}::uuid and r.main_guest_id=${guestId}::uuid
      and r.status not in ('cancelled','no_show')
      and exists(select 1 from folios f where f.reservation_id=r.id and f.status='open')
      and exists(select 1 from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent' and c.amount_cents>0)
    order by r.arrival_date desc limit 25
  `;
  return { ...membership, transactions, rewards, wallet, eligibleReservations: eligibleReservations.filter((reservation) => Number(reservation.balanceCents) > 0) };
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const guestId = new URL(request.url).searchParams.get("guestId");
    if (!guestId || !z.string().uuid().safeParse(guestId).success) return Response.json({ error: "Choose a guest." }, { status: 400 });
    const membership = await details(session.propertyId, guestId);
    return Response.json({ membership });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Loyalty change is invalid." }, { status: 400 });
    const input = parsed.data;
    if (input.action === "update") {
      if (input.customQualificationType === "days" && !input.customQualificationDays) return Response.json({ error: "Enter how many days this customer has to complete the nights." }, { status: 400 });
      if (input.customQualificationType === "date_range" && (!input.customQualificationStartsOn || !input.customQualificationEndsOn)) return Response.json({ error: "Choose both qualifying dates for this customer." }, { status: 400 });
      if (input.customQualificationStartsOn && input.customQualificationEndsOn && input.customQualificationEndsOn < input.customQualificationStartsOn) return Response.json({ error: "The last qualifying date must be on or after the first date." }, { status: 400 });
    }
    let guestId = "";
    let walletUrl: string | undefined;
    await productionSql().begin(async (tx) => {
      if (input.action === "enroll") {
        const [guest] = await tx<Array<{ id: string; status: string }>>`
          select g.id,g.guest_status as status from guests g
          where g.id=${input.guestId}::uuid and g.property_id=${session.propertyId}::uuid and g.archived_at is null for update of g
        `;
        if (!guest) throw new Error("Guest not found.");
        if (guest.status === "do_not_rent") throw new Error("A Do Not Rent guest cannot be enrolled in loyalty.");
        const [existing] = await tx<Array<{ id: string }>>`select id from loyalty_memberships where property_id=${session.propertyId}::uuid and guest_id=${guest.id}::uuid`;
        if (existing) throw new Error("This guest already has a loyalty membership.");
        const member = await ensureLoyaltyMembership(tx, {
          propertyId: session.propertyId,
          guestId: guest.id,
          actorAuthUserId: session.authUserId,
          requireIdentity: false,
          customNightsRequired: input.nightsRequired,
          customRewardDescription: input.rewardDescription,
          smsConsent: input.smsConsent,
          emailConsent: input.emailConsent,
        });
        if (!member) throw new Error("Loyalty membership could not be created.");
        guestId = guest.id;
        return;
      }

      const [member] = await tx<Array<{ id: string; guestId: string; status: string; programStatus: string; guestStatus: string; programId: string; nightsRequired: number; rewardDescription: string; rewardValueCents: number | null; rewardType: string; rewardPercentBasisPoints: number | null; terms: string | null; rewardExpiresDays: number | null }>>`
        select lm.id,lm.guest_id as "guestId",lm.status,lp.status as "programStatus",g.guest_status as "guestStatus",lm.program_id as "programId",
          eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",
          eo.reward_value_cents as "rewardValueCents",eo.reward_type as "rewardType",
          eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,
          eo.reward_expires_days as "rewardExpiresDays"
        from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
        join loyalty_effective_offers eo on eo.membership_id=lm.id
        join guests g on g.id=lm.guest_id and g.property_id=lm.property_id
        where lm.id=${input.membershipId}::uuid and lm.property_id=${session.propertyId}::uuid for update of lm
      `;
      if (!member) throw new Error("Loyalty membership not found.");
      guestId = member.guestId;
      if (input.action === "adjust") {
        if (Math.abs(input.nightsDelta) > 10 && session.role !== "owner" && session.role !== "manager") throw new Error("An owner or manager must approve adjustments over 10 nights.");
        const [balance] = await tx<Array<{ nights: number }>>`select progress_nights as nights from loyalty_member_progress where membership_id=${member.id}::uuid`;
        if ((balance?.nights ?? 0) + input.nightsDelta < 0) throw new Error("This adjustment would make the night balance negative.");
        await tx`insert into loyalty_transactions (property_id,membership_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
          values (${session.propertyId}::uuid,${member.id}::uuid,'manual_adjustment',${input.nightsDelta},${input.reason},${`adjust:${randomBytes(12).toString("hex")}`},${session.authUserId}::uuid)`;
        if (member.status === "active" && member.programStatus === "active") await issueAvailableRewards(tx, session.propertyId, { id: member.id, programId: member.programId, nightsRequired: member.nightsRequired, rewardDescription: member.rewardDescription, rewardValueCents: member.rewardValueCents, rewardType: member.rewardType, rewardPercentBasisPoints: member.rewardPercentBasisPoints, terms: member.terms, rewardExpiresDays: member.rewardExpiresDays }, session.authUserId);
      } else if (input.action === "update") {
        if (input.status === "active" && member.guestStatus === "do_not_rent") throw new Error("A Do Not Rent guest cannot have an active loyalty membership.");
        await tx`update loyalty_memberships set
          status=coalesce(${input.status ?? null},status),
          custom_nights_required=case when ${input.customNightsRequired !== undefined} then ${input.customNightsRequired ?? null} else custom_nights_required end,
          custom_reward_description=case when ${input.customRewardDescription !== undefined} then ${input.customRewardDescription || null} else custom_reward_description end,
          custom_reward_type=case when ${input.customRewardType !== undefined} then ${input.customRewardType ?? null} else custom_reward_type end,
          custom_reward_value_cents=case when ${input.customRewardValueCents !== undefined} then ${input.customRewardValueCents ?? null} else custom_reward_value_cents end,
          custom_reward_percent_basis_points=case when ${input.customRewardPercentBasisPoints !== undefined} then ${input.customRewardPercentBasisPoints ?? null} else custom_reward_percent_basis_points end,
          custom_terms=case when ${input.customTerms !== undefined} then ${input.customTerms || null} else custom_terms end,
          custom_reward_expires_days=case when ${input.customRewardExpiresDays !== undefined} then ${input.customRewardExpiresDays ?? null} else custom_reward_expires_days end,
          custom_qualification_anchor_at=case when ${input.customQualificationType !== undefined || input.customQualificationDays !== undefined || input.customQualificationStartsOn !== undefined || input.customQualificationEndsOn !== undefined}
            and (custom_qualification_type,custom_qualification_days,custom_qualification_starts_on,custom_qualification_ends_on) is distinct from
              (${input.customQualificationType ?? null},${input.customQualificationType === "days" ? input.customQualificationDays ?? null : null},${input.customQualificationType === "date_range" ? input.customQualificationStartsOn ?? null : null}::date,${input.customQualificationType === "date_range" ? input.customQualificationEndsOn ?? null : null}::date)
            then now() else custom_qualification_anchor_at end,
          custom_qualification_type=case when ${input.customQualificationType !== undefined} then ${input.customQualificationType ?? null} else custom_qualification_type end,
          custom_qualification_days=case when ${input.customQualificationType !== undefined || input.customQualificationDays !== undefined} then ${input.customQualificationType === "days" ? input.customQualificationDays ?? null : null} else custom_qualification_days end,
          custom_qualification_starts_on=case when ${input.customQualificationType !== undefined || input.customQualificationStartsOn !== undefined} then ${input.customQualificationType === "date_range" ? input.customQualificationStartsOn ?? null : null}::date else custom_qualification_starts_on end,
          custom_qualification_ends_on=case when ${input.customQualificationType !== undefined || input.customQualificationEndsOn !== undefined} then ${input.customQualificationType === "date_range" ? input.customQualificationEndsOn ?? null : null}::date else custom_qualification_ends_on end,
          sms_consent=case when ${input.smsConsent !== undefined} then ${input.smsConsent ?? false} else sms_consent end,
          email_consent=case when ${input.emailConsent !== undefined} then ${input.emailConsent ?? false} else email_consent end,
          consented_at=case when ${input.smsConsent === true || input.emailConsent === true} then coalesce(consented_at,now()) else consented_at end,
          updated_at=now() where id=${member.id}::uuid`;
        const [updated] = await tx<Array<{ status: string; programStatus: string; nightsRequired: number; rewardDescription: string; rewardValueCents: number | null; rewardType: string; rewardPercentBasisPoints: number | null; terms: string | null; rewardExpiresDays: number | null }>>`
          select lm.status,lp.status as "programStatus",eo.nights_required as "nightsRequired",
            eo.reward_description as "rewardDescription",eo.reward_value_cents as "rewardValueCents",
            eo.reward_type as "rewardType",eo.reward_percent_basis_points as "rewardPercentBasisPoints",
            eo.terms,eo.reward_expires_days as "rewardExpiresDays"
          from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
          join loyalty_effective_offers eo on eo.membership_id=lm.id where lm.id=${member.id}::uuid
        `;
        if (updated?.status === "active" && updated.programStatus === "active") await issueAvailableRewards(tx, session.propertyId, { id: member.id, programId: member.programId, nightsRequired: updated.nightsRequired, rewardDescription: updated.rewardDescription, rewardValueCents: updated.rewardValueCents, rewardType: updated.rewardType, rewardPercentBasisPoints: updated.rewardPercentBasisPoints, terms: updated.terms, rewardExpiresDays: updated.rewardExpiresDays }, session.authUserId);
      } else if (input.action === "redeem_reward") {
        await applyLoyaltyReward(tx, { propertyId: session.propertyId, authUserId: session.authUserId }, { membershipId: member.id, rewardId: input.rewardId, reservationId: input.reservationId });
      } else if (input.action === "restore_reward") {
        await restoreLoyaltyReward(tx, { propertyId: session.propertyId, authUserId: session.authUserId }, { membershipId: member.id, rewardId: input.rewardId, reason: input.reason });
      } else {
        if (member.status !== "active" || member.guestStatus === "do_not_rent") throw new Error("Only an active loyalty member can receive a wallet card.");
        const token = randomBytes(32).toString("base64url");
        const hash = createHash("sha256").update(token).digest("hex");
        await tx`insert into loyalty_wallet_passes (property_id,membership_id,platform,token_hash,status)
          values (${session.propertyId}::uuid,${member.id}::uuid,'web',${hash},'active')
          on conflict (membership_id,platform) do update set token_hash=excluded.token_hash,status='active',updated_at=now()`;
        walletUrl = new URL(`/l/${token}`, request.url).toString();
      }
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "guest", entityId: guestId, action: "updated", entityVersion: Date.now(), payload: { change: `loyalty-${input.action}` } });
    return Response.json({ membership: await details(session.propertyId, guestId), ...(walletUrl ? { walletUrl } : {}) });
  } catch (error) {
    if (error instanceof Error && /guest|loyalty|membership|night balance|Do Not Rent|reward|adjustment|wallet/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
