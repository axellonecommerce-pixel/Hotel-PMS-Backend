import { z } from "zod";

import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { platformAdminAccessResponse, requirePlatformAdmin } from "@/server/auth/platform-admin";
import { purgeMotel } from "@/server/provisioning/motel-purge";
import { updateOwnerAuthUser } from "@/server/provisioning/platform-motel";

const validTimezone = (zone: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } };

const changeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscription"), planName: z.string().trim().min(1), billingCycle: z.enum(["monthly", "quarterly", "yearly", "custom"]), amountCents: z.number().int().nonnegative(), startsOn: z.string().date(), expiresOn: z.string().date(), status: z.enum(["trial", "active", "past_due", "suspended", "cancelled"]), notes: z.string().trim().max(2000).optional() }),
  // Everything entered when the motel was created.
  z.object({
    action: z.literal("details"),
    name: z.string().trim().min(1), addressLine1: z.string().trim().min(1), city: z.string().trim().min(1),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()),
    region: z.string().trim().min(1), postalCode: z.string().trim().min(1), phone: z.string().trim().min(1),
    timezone: z.string().trim().min(1).refine(validTimezone, "Choose a valid time zone."),
    ownerName: z.string().trim().min(1), ownerEmail: z.string().trim().email(),
    ownerPassword: z.string().min(10, "The new password needs at least 10 characters.").max(128).optional(),
  }),
  z.object({ action: z.literal("payment"), amountCents: z.number().int().positive(), receivedOn: z.string().date(), paymentMethod: z.string().trim().min(1), reference: z.string().trim().max(200).optional(), note: z.string().trim().max(2000).optional() }),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ propertyId: string }> }) {
  try {
    await requirePlatformAdmin(request);
    if (!hasProductionDatabase()) return Response.json({ error: "The Platform Admin requires the production database." }, { status: 503 });
    const { propertyId } = await params;
    if (!z.string().uuid().safeParse(propertyId).success) return Response.json({ error: "Invalid motel." }, { status: 400 });
    const parsed = changeSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Subscription details are invalid." }, { status: 400 });
    if (parsed.data.action === "details") {
      const input = parsed.data;
      const sql = productionSql();
      const [owner] = await sql<Array<{ employeeId: string; authUserId: string; email: string | null }>>`
        select e.id as "employeeId", m.auth_user_id as "authUserId", e.email from employees e
        join property_memberships m on m.id=e.membership_id
        where e.property_id=${propertyId}::uuid and m.role='owner' order by e.created_at limit 1
      `;
      const [exists] = await sql<Array<{ id: string }>>`select id from properties where id=${propertyId}::uuid and status<>'deleted'`;
      if (!exists) return Response.json({ error: "That motel was not found." }, { status: 404 });
      const emailChanged = Boolean(owner && (owner.email ?? "").toLowerCase() !== input.ownerEmail.toLowerCase());
      // The sign-in changes first: if Supabase refuses (email in use), nothing else changes.
      if (owner && (emailChanged || input.ownerPassword)) {
        try { await updateOwnerAuthUser(owner.authUserId, { email: emailChanged ? input.ownerEmail : undefined, password: input.ownerPassword }); }
        catch (error) {
          const message = error instanceof Error ? error.message : "The owner sign-in could not be updated.";
          return Response.json({ error: /already|exists|registered/i.test(message) ? "That owner email is already in use." : message }, { status: /already|exists|registered/i.test(message) ? 409 : 502 });
        }
      }
      await sql.begin(async (tx) => {
        await tx`
          update properties set name=${input.name},address_line_1=${input.addressLine1},city=${input.city},region=${input.region},
            postal_code=${input.postalCode},country_code=${input.countryCode},phone=${input.phone},timezone=${input.timezone},updated_at=now()
          where id=${propertyId}::uuid
        `;
        if (owner) {
          await tx`update employees set name=${input.ownerName},email=${input.ownerEmail},updated_at=now() where id=${owner.employeeId}::uuid`;
        }
        // The motel's own Settings › Property shows the same details.
        await tx`
          update property_settings set value=jsonb_set(
            jsonb_set(value,'{property}',coalesce(value->'property','{}'::jsonb) || ${tx.json({ name: input.name, addressLine1: input.addressLine1, city: input.city, state: input.region, country: input.countryCode, postalCode: input.postalCode, phone: input.phone, timezone: input.timezone })}::jsonb),
            '{users}',coalesce((select jsonb_agg(case when item->>'id'=${owner?.employeeId ?? ""} then item || jsonb_build_object('name',${input.ownerName}::text) else item end)
              from jsonb_array_elements(case when jsonb_typeof(value->'users')='array' then value->'users' else '[]'::jsonb end) item),'[]'::jsonb)
          ),updated_at=now()
          where property_id=${propertyId}::uuid and key='application_settings'
        `;
      });
      return Response.json({ updated: true });
    }
    if (parsed.data.action === "payment") {
      const [record] = await productionSql()<Array<{ id: string }>>`
        insert into platform_subscription_payments (property_id,amount_cents,received_on,payment_method,reference,note)
        values (${propertyId}::uuid,${parsed.data.amountCents},${parsed.data.receivedOn}::date,${parsed.data.paymentMethod},${parsed.data.reference ?? null},${parsed.data.note ?? null}) returning id
      `;
      return Response.json({ payment: record }, { status: 201 });
    }
    await productionSql()`
      update platform_subscriptions set plan_name=${parsed.data.planName},billing_cycle=${parsed.data.billingCycle},amount_cents=${parsed.data.amountCents},starts_on=${parsed.data.startsOn}::date,expires_on=${parsed.data.expiresOn}::date,status=${parsed.data.status},notes=${parsed.data.notes ?? null},updated_at=now()
      where property_id=${propertyId}::uuid
    `;
    return Response.json({ updated: true });
  } catch (error) { return platformAdminAccessResponse(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ propertyId: string }> }) {
  try {
    await requirePlatformAdmin(request);
    if (!hasProductionDatabase()) return Response.json({ error: "The Platform Admin requires the production database." }, { status: 503 });
    const { propertyId } = await params;
    if (!z.string().uuid().safeParse(propertyId).success) return Response.json({ error: "Invalid motel." }, { status: 400 });
    const deleted = await purgeMotel(propertyId);
    if (!deleted) return Response.json({ error: "That motel was not found." }, { status: 404 });
    return Response.json({ deleted: true, permanent: true });
  } catch (error) { return platformAdminAccessResponse(error); }
}
