import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";

const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("charge"), chargeType: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(200), amountCents: z.number().int().positive().max(10_000_000) }),
  z.object({ kind: z.literal("payment"), method: z.string().trim().min(1).max(80), amountCents: z.number().int().positive().max(10_000_000), reference: z.string().trim().max(120).optional() }),
]);
const voidSchema = z.object({ chargeId: z.string().uuid() });

class HouseAccountError extends Error {}

export async function GET(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const { accountId } = await context.params;
    const sql = productionSql();
    const charges = await sql<Array<{ id: string; businessDate: string; chargeType: string; description: string; amountCents: number; status: string }>>`
      select id, business_date::text as "businessDate", charge_type as "chargeType", description, amount_cents as "amountCents", status
      from house_account_charges where property_id=${session.propertyId}::uuid and house_account_id=${accountId}::uuid
      order by created_at desc
    `;
    const payments = await sql<Array<{ id: string; businessDate: string; method: string; amountCents: number; reference: string | null }>>`
      select id, effective_date::text as "businessDate", method, amount_cents as "amountCents", external_reference as reference
      from payments where property_id=${session.propertyId}::uuid and house_account_id=${accountId}::uuid
      order by created_at desc
    `;
    return Response.json({ charges, payments });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const { accountId } = await context.params;
    const parsed = entrySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter the charge or payment details." }, { status: 400 });
    const input = parsed.data;
    const created = await productionSql().begin(async (tx) => {
      const [account] = await tx<Array<{ id: string; status: string; name: string; balanceCents: number }>>`
        select ha.id, ha.status, ha.name,
          (coalesce((select sum(c.amount_cents) from house_account_charges c where c.house_account_id=ha.id and c.status='posted'),0)
            - coalesce((select sum(p.amount_cents) from payments p where p.house_account_id=ha.id),0))::int as "balanceCents"
        from house_accounts ha where ha.id=${accountId}::uuid and ha.property_id=${session.propertyId}::uuid for update
      `;
      if (!account) throw new HouseAccountError("House account not found.");
      if (account.status !== "open") throw new HouseAccountError("Reopen the house account before posting to it.");
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      if (input.kind === "charge") {
        // Extra charges are non-taxable at this property, like folio extras.
        const [charge] = await tx<Array<{ id: string }>>`
          insert into house_account_charges (property_id, house_account_id, charge_type, description, amount_cents, business_date)
          values (${session.propertyId}::uuid, ${account.id}::uuid, ${input.chargeType}, ${input.description}, ${input.amountCents}, ${businessDate}::date)
          returning id
        `;
        await postProductionLedger(tx, {
          propertyId: session.propertyId, businessDate, resourceType: "house-account-charge", resourceId: charge.id,
          description: `${account.name} · ${input.description}`, debitAccount: "House Account Receivable", creditAccount: `Revenue:${input.chargeType}`, amountCents: input.amountCents,
        });
        return { id: charge.id, kind: "charge" as const };
      }
      if (input.amountCents > account.balanceCents) throw new HouseAccountError("Payment cannot exceed the house account balance.");
      const [payment] = await tx<Array<{ id: string }>>`
        insert into payments (property_id, house_account_id, method, amount_cents, currency_code, effective_date, external_reference, note)
        values (${session.propertyId}::uuid, ${account.id}::uuid, ${input.method}, ${input.amountCents}, 'USD', ${businessDate}::date, ${input.reference ?? null}, ${`House account · ${account.name}`})
        returning id
      `;
      return { id: payment.id, kind: "payment" as const };
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof HouseAccountError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Void a charge posted to a house account; its revenue is reversed. */
export async function DELETE(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const { accountId } = await context.params;
    const parsed = voidSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select a charge to void." }, { status: 400 });
    const voided = await productionSql().begin(async (tx) => {
      const [charge] = await tx<Array<{ id: string; chargeType: string; description: string; amountCents: number }>>`
        select id, charge_type as "chargeType", description, amount_cents as "amountCents" from house_account_charges
        where id=${parsed.data.chargeId}::uuid and house_account_id=${accountId}::uuid and property_id=${session.propertyId}::uuid and status='posted' for update
      `;
      if (!charge) return false;
      await tx`update house_account_charges set status='voided' where id=${charge.id}::uuid`;
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: await propertyBusinessDate(tx, session.propertyId), resourceType: "house-account-charge-void", resourceId: charge.id,
        description: `${charge.description} void`, debitAccount: `Revenue:${charge.chargeType}`, creditAccount: "House Account Receivable", amountCents: charge.amountCents,
      });
      return true;
    });
    if (!voided) return Response.json({ error: "Charge not found or already voided." }, { status: 404 });
    return Response.json({ voided: true });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
