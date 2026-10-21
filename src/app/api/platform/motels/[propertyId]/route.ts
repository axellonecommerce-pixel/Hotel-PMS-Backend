import { z } from "zod";

import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { platformAdminAccessResponse, requirePlatformAdmin } from "@/server/auth/platform-admin";

const changeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscription"), planName: z.string().trim().min(1), billingCycle: z.enum(["monthly", "quarterly", "yearly", "custom"]), amountCents: z.number().int().nonnegative(), startsOn: z.string().date(), expiresOn: z.string().date(), status: z.enum(["trial", "active", "past_due", "suspended", "cancelled"]), notes: z.string().trim().max(2000).optional() }),
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

// Archive instead of physically cascading through years of reservations and
// accounting records. The motel disappears from the platform and loses access,
// while the administrator can still recover records if deletion was accidental.
export async function DELETE(request: Request, { params }: { params: Promise<{ propertyId: string }> }) {
  try {
    await requirePlatformAdmin(request);
    if (!hasProductionDatabase()) return Response.json({ error: "The Platform Admin requires the production database." }, { status: 503 });
    const { propertyId } = await params;
    if (!z.string().uuid().safeParse(propertyId).success) return Response.json({ error: "Invalid motel." }, { status: 400 });
    const result = await productionSql()<Array<{ id: string }>>`
      update properties set status='deleted',updated_at=now() where id=${propertyId}::uuid and status <> 'deleted' returning id
    `;
    if (!result.length) return Response.json({ error: "That motel was not found or is already deleted." }, { status: 404 });
    await productionSql()`update property_memberships set active=false,updated_at=now() where property_id=${propertyId}::uuid`;
    await productionSql()`update platform_subscriptions set status='cancelled',updated_at=now() where property_id=${propertyId}::uuid`;
    return Response.json({ deleted: true });
  } catch (error) { return platformAdminAccessResponse(error); }
}
