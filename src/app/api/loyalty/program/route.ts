import { z } from "zod";

import { propertyAccessResponse, requirePropertySession, requireSettingsSection } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { issueAvailableRewards } from "@/server/loyalty/service";
import { recordChange } from "@/server/realtime/change-events";

const reminderSchema = z.object({
  enabled: z.boolean().default(false),
  nightsRemaining: z.array(z.number().int().min(1).max(30)).max(10).default([2, 1]),
  sendRewardReady: z.boolean().default(true),
  pushTitle: z.string().trim().min(3).max(80),
  pushTemplate: z.string().trim().min(10).max(500),
  emailSubject: z.string().trim().min(3).max(120),
  emailTemplate: z.string().trim().min(10).max(2_000),
});

const programSchema = z.object({
  name: z.string().trim().min(3).max(120),
  status: z.enum(["active", "paused"]),
  nightsRequired: z.number().int().min(1).max(365),
  rewardType: z.enum(["free_night", "fixed_discount", "percent_discount", "member_rate"]),
  rewardValueCents: z.number().int().min(1).max(10_000_000).nullable(),
  rewardPercentBasisPoints: z.number().int().min(1).max(10_000).nullable(),
  rewardDescription: z.string().trim().min(3).max(160),
  terms: z.string().trim().max(2_000).nullable(),
  rewardExpiresDays: z.number().int().min(1).max(3_650).nullable(),
  qualificationType: z.enum(["none", "days", "date_range"]).default("none"),
  qualificationDays: z.number().int().min(1).max(3_650).nullable().default(null),
  qualificationStartsOn: z.string().date().nullable().default(null),
  qualificationEndsOn: z.string().date().nullable().default(null),
  reminderSettings: reminderSchema,
}).superRefine((value, context) => {
  if ((value.rewardType === "fixed_discount" || value.rewardType === "member_rate") && !value.rewardValueCents) {
    context.addIssue({ code: "custom", path: ["rewardValueCents"], message: "Enter a dollar value for this reward." });
  }
  if (value.rewardType === "percent_discount" && !value.rewardPercentBasisPoints) {
    context.addIssue({ code: "custom", path: ["rewardPercentBasisPoints"], message: "Enter a percentage for this reward." });
  }
  if (value.qualificationType === "days" && !value.qualificationDays) context.addIssue({ code: "custom", path: ["qualificationDays"], message: "Enter how many days customers have to complete the nights." });
  if (value.qualificationType === "date_range" && (!value.qualificationStartsOn || !value.qualificationEndsOn)) context.addIssue({ code: "custom", path: ["qualificationStartsOn"], message: "Choose both the first and last qualifying date." });
  if (value.qualificationStartsOn && value.qualificationEndsOn && value.qualificationEndsOn < value.qualificationStartsOn) context.addIssue({ code: "custom", path: ["qualificationEndsOn"], message: "The last qualifying date must be on or after the first date." });
});

const defaultReminders = {
  enabled: false, nightsRemaining: [2, 1], sendRewardReady: true,
  pushTitle: "Your motel loyalty progress",
  pushTemplate: "Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.",
  emailSubject: "Your loyalty progress",
  emailTemplate: "Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.",
};

async function readProgram(propertyId: string) {
  const [program] = await productionSql()<Array<Record<string, unknown>>>`
    select id,name,status,nights_required as "nightsRequired",reward_type as "rewardType",
      reward_value_cents as "rewardValueCents",reward_percent_basis_points as "rewardPercentBasisPoints",
      reward_description as "rewardDescription",terms,reward_expires_days as "rewardExpiresDays",
      qualification_type as "qualificationType",qualification_days as "qualificationDays",
      qualification_starts_on::text as "qualificationStartsOn",qualification_ends_on::text as "qualificationEndsOn",
      reminder_settings as "reminderSettings",created_at::text as "createdAt",updated_at::text as "updatedAt"
    from loyalty_programs where property_id=${propertyId}::uuid
  `;
  return program ?? null;
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    requireSettingsSection(session, "Loyalty & Offers");
    return Response.json({ program: await readProgram(session.propertyId), defaults: { ...defaultReminders } });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    requireSettingsSection(session, "Loyalty & Offers");
    const parsed = programSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Offer settings are invalid." }, { status: 400 });
    const input = parsed.data;
    await productionSql().begin(async (tx) => {
      const [program] = await tx<Array<{ id: string }>>`
        insert into loyalty_programs
          (property_id,name,status,nights_required,reward_type,reward_value_cents,reward_percent_basis_points,reward_description,terms,reward_expires_days,
           qualification_type,qualification_days,qualification_starts_on,qualification_ends_on,reminder_settings,updated_at)
        values
          (${session.propertyId}::uuid,${input.name},${input.status},${input.nightsRequired},${input.rewardType},
           ${input.rewardValueCents},${input.rewardPercentBasisPoints},${input.rewardDescription},${input.terms},${input.rewardExpiresDays},
           ${input.qualificationType},${input.qualificationType === "days" ? input.qualificationDays : null},
           ${input.qualificationType === "date_range" ? input.qualificationStartsOn : null}::date,
           ${input.qualificationType === "date_range" ? input.qualificationEndsOn : null}::date,${tx.json(input.reminderSettings)},now())
        on conflict (property_id) do update set name=excluded.name,status=excluded.status,nights_required=excluded.nights_required,
          reward_type=excluded.reward_type,reward_value_cents=excluded.reward_value_cents,
          reward_percent_basis_points=excluded.reward_percent_basis_points,reward_description=excluded.reward_description,
          terms=excluded.terms,reward_expires_days=excluded.reward_expires_days,
          qualification_anchor_at=case when (loyalty_programs.qualification_type,loyalty_programs.qualification_days,loyalty_programs.qualification_starts_on,loyalty_programs.qualification_ends_on)
            is distinct from (excluded.qualification_type,excluded.qualification_days,excluded.qualification_starts_on,excluded.qualification_ends_on) then now() else loyalty_programs.qualification_anchor_at end,
          qualification_type=excluded.qualification_type,qualification_days=excluded.qualification_days,
          qualification_starts_on=excluded.qualification_starts_on,qualification_ends_on=excluded.qualification_ends_on,
          reminder_settings=excluded.reminder_settings,updated_at=now()
        returning id
      `;
      if (input.status === "active") {
        const members = await tx<Array<{ id: string; nightsRequired: number; rewardDescription: string; rewardType: string; rewardValueCents: number | null; rewardPercentBasisPoints: number | null; terms: string | null; rewardExpiresDays: number | null }>>`
          select lm.id,eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",
            eo.reward_type as "rewardType",eo.reward_value_cents as "rewardValueCents",
            eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,eo.reward_expires_days as "rewardExpiresDays"
          from loyalty_memberships lm join loyalty_effective_offers eo on eo.membership_id=lm.id
          where lm.property_id=${session.propertyId}::uuid and lm.program_id=${program.id}::uuid and lm.status='active' for update of lm
        `;
        for (const member of members) await issueAvailableRewards(tx, session.propertyId, {
          id: member.id, programId: program.id,
          nightsRequired: member.nightsRequired,
          rewardDescription: member.rewardDescription,
          rewardValueCents: member.rewardValueCents,
          rewardType: member.rewardType,
          rewardPercentBasisPoints: member.rewardPercentBasisPoints,
          terms: member.terms,
          rewardExpiresDays: member.rewardExpiresDays,
        }, session.authUserId);
      }
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: { section: "Loyalty & Offers" } });
    return Response.json({ program: await readProgram(session.propertyId) });
  } catch (error) { return propertyAccessResponse(error); }
}

export const GET = withRequestContext(routeGET);
export const PUT = withRequestContext(routePUT);
