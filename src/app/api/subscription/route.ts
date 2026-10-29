import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

/** The motel's own InnSeva subscription and payments, read-only (set by the platform admin). */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    if (!hasProductionDatabase()) return Response.json({ subscription: null, payments: [] });
    const sql = productionSql();
    const [subscription] = await sql<Array<Record<string, unknown>>>`
      select plan_name as "planName",billing_cycle as "billingCycle",amount_cents as "amountCents",currency_code as "currencyCode",
        starts_on::text as "startsOn",expires_on::text as "expiresOn",status
      from platform_subscriptions where property_id=${session.propertyId}::uuid
    `;
    const payments = await sql<Array<Record<string, unknown>>>`
      select id,amount_cents as "amountCents",received_on::text as "receivedOn",payment_method as "paymentMethod",reference
      from platform_subscription_payments where property_id=${session.propertyId}::uuid order by received_on desc limit 50
    `;
    return Response.json({ subscription: subscription ?? null, payments });
  } catch (error) { return propertyAccessResponse(error); }
}
