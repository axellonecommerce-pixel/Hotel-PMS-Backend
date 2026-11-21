import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { issueAvailableRewards } from "@/server/loyalty/service";
import { recordChange } from "@/server/realtime/change-events";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enroll"), guestId: z.string().uuid(), nightsRequired: z.number().int().min(1).max(365).default(10), rewardDescription: z.string().trim().min(3).max(160).default("One free night"), smsConsent: z.boolean().default(false), emailConsent: z.boolean().default(false) }),
  z.object({ action: z.literal("adjust"), membershipId: z.string().uuid(), nightsDelta: z.number().int().min(-365).max(365).refine((value) => value !== 0), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal("update"), membershipId: z.string().uuid(), status: z.enum(["active", "paused", "closed"]).optional(), customNightsRequired: z.number().int().min(1).max(365).nullable().optional(), customRewardDescription: z.string().trim().max(160).nullable().optional(), smsConsent: z.boolean().optional(), emailConsent: z.boolean().optional() }),
  z.object({ action: z.literal("wallet_link"), membershipId: z.string().uuid() }),
]);

function prefix(name: string) {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const value = (words.length > 1 ? words.map((word) => word[0]).join("") : words[0] ?? "INN").slice(0, 6);
  return value.length >= 2 ? value : "INN";
}

async function details(propertyId: string, guestId: string) {
  const sql = productionSql();
  const [membership] = await sql<Array<Record<string, unknown>>>`
    select lm.id,lm.guest_id as "guestId",lm.member_number as "memberNumber",lm.status,
      lm.sms_consent as "smsConsent",lm.email_consent as "emailConsent",lm.joined_at::text as "joinedAt",
      lm.custom_nights_required as "customNightsRequired",lm.custom_reward_description as "customRewardDescription",
      lp.name as "programName",lp.nights_required as "programNightsRequired",lp.reward_description as "programRewardDescription",
      coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
      coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",
      greatest(coalesce((select sum(lt.nights_delta) from loyalty_transactions lt where lt.membership_id=lm.id),0),0)::int as "progressNights",
      greatest(coalesce((select sum(lt.nights_delta) from loyalty_transactions lt where lt.membership_id=lm.id and lt.type in ('enrollment_credit','stay_credit','stay_reversal')),0),0)::int as "totalQualifyingNights",
      (select count(*)::int from loyalty_rewards lr where lr.membership_id=lm.id and lr.status='available') as "availableRewards"
    from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
    where lm.property_id=${propertyId}::uuid and lm.guest_id=${guestId}::uuid
  `;
  if (!membership) return null;
  const membershipId = String(membership.id);
  const transactions = await sql<Array<Record<string, unknown>>>`
    select lt.id,lt.type,lt.nights_delta as "nightsDelta",lt.description,lt.created_at::text as "createdAt",
      r.confirmation_number as "confirmationNumber"
    from loyalty_transactions lt left join reservations r on r.id=lt.reservation_id
    where lt.property_id=${propertyId}::uuid and lt.membership_id=${membershipId}::uuid
    order by lt.created_at desc,lt.id desc limit 200
  `;
  const rewards = await sql<Array<Record<string, unknown>>>`
    select lr.id,lr.status,lr.description,lr.value_cents as "valueCents",lr.issued_at::text as "issuedAt",
      lr.reserved_at::text as "reservedAt",lr.redeemed_at::text as "redeemedAt",lr.expires_at::text as "expiresAt",
      r.confirmation_number as "confirmationNumber"
    from loyalty_rewards lr left join reservations r on r.id=lr.reservation_id
    where lr.property_id=${propertyId}::uuid and lr.membership_id=${membershipId}::uuid
    order by lr.issued_at desc
  `;
  const wallet = await sql<Array<Record<string, unknown>>>`
    select platform,status,created_at::text as "createdAt",last_synced_at::text as "lastSyncedAt"
    from loyalty_wallet_passes where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid
  `;
  return { ...membership, transactions, rewards, wallet };
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
    let guestId = "";
    let walletUrl: string | undefined;
    await productionSql().begin(async (tx) => {
      if (input.action === "enroll") {
        const [guest] = await tx<Array<{ id: string; status: string; propertyName: string }>>`
          select g.id,g.guest_status as status,p.name as "propertyName" from guests g join properties p on p.id=g.property_id
          where g.id=${input.guestId}::uuid and g.property_id=${session.propertyId}::uuid and g.archived_at is null for update of g
        `;
        if (!guest) throw new Error("Guest not found.");
        if (guest.status === "do_not_rent") throw new Error("A Do Not Rent guest cannot be enrolled in loyalty.");
        const [existing] = await tx<Array<{ id: string }>>`select id from loyalty_memberships where property_id=${session.propertyId}::uuid and guest_id=${guest.id}::uuid`;
        if (existing) throw new Error("This guest already has a loyalty membership.");
        const [program] = await tx<Array<{ id: string; rewardValueCents: number | null }>>`
          insert into loyalty_programs (property_id,name,nights_required,reward_description)
          values (${session.propertyId}::uuid,${`${guest.propertyName} Rewards`},${input.nightsRequired},${input.rewardDescription})
          on conflict (property_id) do update set property_id=excluded.property_id
          returning id,reward_value_cents as "rewardValueCents"
        `;
        const memberNumber = `${prefix(guest.propertyName)}-${randomBytes(3).toString("hex").toUpperCase()}`;
        const [member] = await tx<Array<{ id: string }>>`
          insert into loyalty_memberships
            (property_id,guest_id,program_id,member_number,custom_nights_required,custom_reward_description,sms_consent,email_consent,consented_at)
          values
            (${session.propertyId}::uuid,${guest.id}::uuid,${program.id}::uuid,${memberNumber},${input.nightsRequired},${input.rewardDescription},${input.smsConsent},${input.emailConsent},
             ${input.smsConsent || input.emailConsent ? new Date().toISOString() : null})
          returning id
        `;
        const stays = await tx<Array<{ id: string; version: number; nights: number; confirmationNumber: string }>>`
          select r.id,r.version,greatest(r.departure_date-r.arrival_date,1)::int as nights,r.confirmation_number as "confirmationNumber"
          from reservations r where r.property_id=${session.propertyId}::uuid and r.main_guest_id=${guest.id}::uuid and r.status='checked_out'
            and exists (select 1 from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent' and c.amount_cents>0)
          order by r.departure_date,r.id
        `;
        for (const stay of stays) await tx`
          insert into loyalty_transactions
            (property_id,membership_id,reservation_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
          values
            (${session.propertyId}::uuid,${member.id}::uuid,${stay.id}::uuid,'enrollment_credit',${stay.nights},${`Past stay ${stay.confirmationNumber}`},
             ${`stay:${stay.id}:v${stay.version}:target:${stay.nights}`},${session.authUserId}::uuid)
          on conflict (property_id,idempotency_key) do nothing
        `;
        await issueAvailableRewards(tx, session.propertyId, { id: member.id, programId: program.id, nightsRequired: input.nightsRequired, rewardDescription: input.rewardDescription, rewardValueCents: program.rewardValueCents }, session.authUserId);
        guestId = guest.id;
        return;
      }

      const [member] = await tx<Array<{ id: string; guestId: string; programId: string; nightsRequired: number; rewardDescription: string; rewardValueCents: number | null }>>`
        select lm.id,lm.guest_id as "guestId",lm.program_id as "programId",
          coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
          coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",lp.reward_value_cents as "rewardValueCents"
        from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
        where lm.id=${input.membershipId}::uuid and lm.property_id=${session.propertyId}::uuid for update of lm
      `;
      if (!member) throw new Error("Loyalty membership not found.");
      guestId = member.guestId;
      if (input.action === "adjust") {
        const [balance] = await tx<Array<{ nights: number }>>`select coalesce(sum(nights_delta),0)::int as nights from loyalty_transactions where membership_id=${member.id}::uuid`;
        if ((balance?.nights ?? 0) + input.nightsDelta < 0) throw new Error("This adjustment would make the night balance negative.");
        await tx`insert into loyalty_transactions (property_id,membership_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
          values (${session.propertyId}::uuid,${member.id}::uuid,'manual_adjustment',${input.nightsDelta},${input.reason},${`adjust:${randomBytes(12).toString("hex")}`},${session.authUserId}::uuid)`;
        await issueAvailableRewards(tx, session.propertyId, { id: member.id, programId: member.programId, nightsRequired: member.nightsRequired, rewardDescription: member.rewardDescription, rewardValueCents: member.rewardValueCents }, session.authUserId);
      } else if (input.action === "update") {
        await tx`update loyalty_memberships set
          status=coalesce(${input.status ?? null},status),
          custom_nights_required=case when ${input.customNightsRequired !== undefined} then ${input.customNightsRequired ?? null} else custom_nights_required end,
          custom_reward_description=case when ${input.customRewardDescription !== undefined} then ${input.customRewardDescription || null} else custom_reward_description end,
          sms_consent=case when ${input.smsConsent !== undefined} then ${input.smsConsent ?? false} else sms_consent end,
          email_consent=case when ${input.emailConsent !== undefined} then ${input.emailConsent ?? false} else email_consent end,
          consented_at=case when ${input.smsConsent === true || input.emailConsent === true} then coalesce(consented_at,now()) else consented_at end,
          updated_at=now() where id=${member.id}::uuid`;
        const [updated] = await tx<Array<{ status: string; nightsRequired: number; rewardDescription: string; rewardValueCents: number | null }>>`
          select lm.status,coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
            coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",lp.reward_value_cents as "rewardValueCents"
          from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id where lm.id=${member.id}::uuid
        `;
        if (updated?.status === "active") await issueAvailableRewards(tx, session.propertyId, { id: member.id, programId: member.programId, nightsRequired: updated.nightsRequired, rewardDescription: updated.rewardDescription, rewardValueCents: updated.rewardValueCents }, session.authUserId);
      } else {
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
    if (error instanceof Error && /guest|loyalty|membership|night balance|Do Not Rent/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
