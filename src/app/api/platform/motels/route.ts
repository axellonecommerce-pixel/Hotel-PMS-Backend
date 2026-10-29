import { z } from "zod";

import { hasProductionDatabase, productionSql } from "@/server/db/production";
import {
  platformAdminAccessResponse,
  requirePlatformAdmin,
} from "@/server/auth/platform-admin";
import { provisionPlatformMotel } from "@/server/provisioning/platform-motel";

const motelSchema = z
  .object({
    name: z.string().trim().min(1),
    addressLine1: z.string().trim().min(1),
    city: z.string().trim().min(1),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).default("US"),
    region: z.string().trim().min(1),
    postalCode: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    timezone: z.string().trim().min(1).refine((zone) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
    }, "Choose a valid time zone."),
    ownerName: z.string().trim().min(1),
    ownerEmail: z.string().trim().email(),
    ownerPassword: z.string().min(10).max(128).optional(),
    planName: z.string().trim().min(1),
    billingCycle: z.enum(["monthly", "quarterly", "yearly", "custom"]),
    amountCents: z.number().int().nonnegative(),
    startsOn: z.string().date(),
    expiresOn: z.string().date(),
    status: z.enum(["trial", "active", "past_due", "suspended", "cancelled"]),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => data.expiresOn >= data.startsOn, {
    message: "Expiry must be on or after the start date.",
    path: ["expiresOn"],
  });

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    if (!hasProductionDatabase())
      return Response.json(
        { error: "The Platform Admin requires the production database." },
        { status: 503 },
      );
    const motels = await productionSql()<Array<Record<string, unknown>>>`
      select p.id,p.name,p.address_line_1 as "addressLine1",p.postal_code as "postalCode",p.city,p.region,p.country_code as "countryCode",p.timezone,p.phone,p.status as "propertyStatus",p.created_at as "createdAt",
        s.plan_name as "planName",s.billing_cycle as "billingCycle",s.amount_cents as "amountCents",s.currency_code as "currencyCode",
        s.starts_on as "startsOn",s.expires_on as "expiresOn",s.status as "subscriptionStatus",s.notes,
        owner.email as "ownerEmail", owner.name as "ownerName",
        coalesce(payments."paymentTotalCents",0)::int as "paymentTotalCents"
      from properties p
      left join platform_subscriptions s on s.property_id=p.id
      left join lateral (
        select e.email,e.name from employees e
        join property_memberships m on m.id=e.membership_id
        where e.property_id=p.id and m.role='owner' order by e.created_at asc limit 1
      ) owner on true
      left join lateral (
        select sum(amount_cents)::int as "paymentTotalCents" from platform_subscription_payments where property_id=p.id
      ) payments on true
      where p.status <> 'deleted'
      order by s.expires_on asc nulls last,p.name asc
    `;
    const today = new Date().toISOString().slice(0, 10);
    const metrics = {
      total: motels.length,
      active: motels.filter(
        (m) =>
          m.subscriptionStatus === "active" || m.subscriptionStatus === "trial",
      ).length,
      expiringSoon: motels.filter(
        (m) =>
          typeof m.expiresOn === "string" &&
          m.expiresOn >= today &&
          m.expiresOn <=
            new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      ).length,
      pastDue: motels.filter((m) => m.subscriptionStatus === "past_due").length,
    };
    return Response.json({ motels, metrics });
  } catch (error) {
    return platformAdminAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformAdmin(request);
    if (!hasProductionDatabase())
      return Response.json(
        { error: "The Platform Admin requires the production database." },
        { status: 503 },
      );
    const parsed = motelSchema.safeParse(await request.json());
    if (!parsed.success)
      return Response.json(
        {
          error:
            parsed.error.issues[0]?.message ?? "Complete the motel details.",
        },
        { status: 400 },
      );
    const motel = await provisionPlatformMotel(parsed.data);
    return Response.json({ motel }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      /already|exists|duplicate/i.test(error.message)
    )
      return Response.json(
        { error: "That owner email is already in use." },
        { status: 409 },
      );
    if (
      error instanceof Error &&
      /Supabase administrator access|invalid api key|invalid jwt|not allowed/i.test(
        error.message,
      )
    ) {
      return Response.json(
        {
          error:
            "Motel creation is not configured: add a valid SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) to the backend environment.",
        },
        { status: 503 },
      );
    }
    if (
      error instanceof Error &&
      /platform_subscriptions|relation .* does not exist/i.test(error.message)
    ) {
      return Response.json(
        {
          error:
            "The backend database migration for motel subscriptions has not been applied yet.",
        },
        { status: 503 },
      );
    }
    try {
      return platformAdminAccessResponse(error);
    } catch {
      return Response.json(
        {
          error:
            "The motel could not be created. Check the backend deployment logs for the provisioning error.",
        },
        { status: 500 },
      );
    }
  }
}
