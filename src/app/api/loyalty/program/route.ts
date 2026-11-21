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
  smsTemplate: z.string().trim().min(10).max(500),
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
  reminderSettings: reminderSchema,
}).superRefine((value, context) => {
  if ((value.rewardType === "fixed_discount" || value.rewardType === "member_rate") && !value.rewardValueCents) {
    context.addIssue({ code: "custom", path: ["rewardValueCents"], message: "Enter a dollar value for this reward." });
  }
  if (value.rewardType === "percent_discount" && !value.rewardPercentBasisPoints) {
    context.addIssue({ code: "custom", path: ["rewardPercentBasisPoints"], message: "Enter a percentage for this reward." });
  }
});

const defaultReminders = {
  enabled: false, nightsRemaining: [2, 1], sendRewardReady: true,
  smsTemplate: "Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.",
  emailSubject: "Your loyalty progress",
  emailTemplate: "Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.",
};

async function readProgram(propertyId: string) {
  const [program] = await productionSql()<Array<Record<string, unknown>>>`
    select id,name,status,nights_required as "nightsRequired",reward_type as "rewardType",
      reward_value_cents as "rewardValueCents",reward_percent_basis_points as "rewardPercentBasisPoints",
      reward_description as "rewardDescription",terms,reward_expires_days as "rewardExpiresDays",
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
          (property_id,name,status,nights_required,reward_type,reward_value_cents,reward_percent_basis_points,reward_description,terms,reward_expires_days,reminder_settings,updated_at)
        values
          (${session.propertyId}::uuid,${input.name},${input.status},${input.nightsRequired},${input.rewardType},
           ${input.rewardValueCents},${input.rewardPercentBasisPoints},${input.rewardDescription},${input.terms},${input.rewardExpiresDays},${tx.json(input.reminderSettings)},now())
        on conflict (property_id) do update set name=excluded.name,status=excluded.status,nights_required=excluded.nights_required,
          reward_type=excluded.reward_type,reward_value_cents=excluded.reward_value_cents,
          reward_percent_basis_points=excluded.reward_percent_basis_points,reward_description=excluded.reward_description,
          terms=excluded.terms,reward_expires_days=excluded.reward_expires_days,reminder_settings=excluded.reminder_settings,updated_at=now()
        returning id
      `;
      if (input.status === "active") {
        const members = await tx<Array<{ id: string; customNightsRequired: number | null; customRewardDescription: string | null; customRewardType: string | null; customRewardValueCents: number | null; customRewardPercentBasisPoints: number | null; customTerms: string | null; customRewardExpiresDays: number | null }>>`
          select id,custom_nights_required as "customNightsRequired",custom_reward_description as "customRewardDescription",
            custom_reward_type as "customRewardType",custom_reward_value_cents as "customRewardValueCents",
            custom_reward_percent_basis_points as "customRewardPercentBasisPoints",custom_terms as "customTerms",
            custom_reward_expires_days as "customRewardExpiresDays"
          from loyalty_memberships where property_id=${session.propertyId}::uuid and program_id=${program.id}::uuid and status='active' for update
        `;
        for (const member of members) await issueAvailableRewards(tx, session.propertyId, {
          id: member.id, programId: program.id,
          nightsRequired: member.customNightsRequired ?? input.nightsRequired,
          rewardDescription: member.customRewardDescription || input.rewardDescription,
          rewardValueCents: member.customRewardValueCents ?? input.rewardValueCents,
          rewardType: member.customRewardType ?? input.rewardType,
          rewardPercentBasisPoints: member.customRewardPercentBasisPoints ?? input.rewardPercentBasisPoints,
          terms: member.customTerms ?? input.terms,
          rewardExpiresDays: member.customRewardExpiresDays ?? input.rewardExpiresDays,
        }, session.authUserId);
      }
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: { section: "Loyalty & Offers" } });
    return Response.json({ program: await readProgram(session.propertyId) });
  } catch (error) { return propertyAccessResponse(error); }
}

export const GET = withRequestContext(routeGET);
export const PUT = withRequestContext(routePUT);
