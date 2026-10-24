import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { requireOpenShift, ShiftRequiredError } from "@/server/finance/shift-guard";

// HotelKey "Paid Outs": cash handed out of the front-desk drawer (supplies,
// a cash refund to a walk-up, petty expenses). Each one lowers the expected
// cash for the Cash Drop and posts Paid Outs (debit) against Cash (credit).
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ startDate: date, endDate: date });
const createSchema = z.object({
  amountCents: z.number().int().positive().max(1_000_000),
  paidTo: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});
const deleteSchema = z.object({ id: z.string().uuid() });

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const parsed = rangeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || parsed.data.startDate > parsed.data.endDate) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    const paidOuts = await productionSql()<Array<{ id: string; businessDate: string; amountCents: number; paidTo: string; reason: string; note: string | null; createdAt: string }>>`
      select id, business_date::text as "businessDate", amount_cents as "amountCents", paid_to as "paidTo", reason, note, created_at::text as "createdAt"
      from paid_outs where property_id=${session.propertyId}::uuid and business_date between ${parsed.data.startDate}::date and ${parsed.data.endDate}::date
      order by created_at desc
    `;
    return Response.json({ paidOuts });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter an amount, who was paid, and the reason." }, { status: 400 });
    const paidOut = await productionSql().begin(async (tx) => {
      await requireOpenShift(tx, session.propertyId, "pay cash out of the drawer");
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      const [created] = await tx<Array<{ id: string; businessDate: string; createdAt: string }>>`
        insert into paid_outs (property_id, business_date, amount_cents, paid_to, reason, note, created_by_auth_user_id)
        values (${session.propertyId}::uuid, ${businessDate}::date, ${parsed.data.amountCents}, ${parsed.data.paidTo}, ${parsed.data.reason}, ${parsed.data.note ?? null}, ${/^[0-9a-f-]{36}$/i.test(session.authUserId) ? session.authUserId : null})
        returning id, business_date::text as "businessDate", created_at::text as "createdAt"
      `;
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate, resourceType: "paid-out", resourceId: created.id,
        description: `Paid out to ${parsed.data.paidTo} · ${parsed.data.reason}`, debitAccount: "Paid Outs", creditAccount: "Cash", amountCents: parsed.data.amountCents,
      });
      return { ...created, ...parsed.data, note: parsed.data.note ?? null };
    });
    return Response.json({ paidOut }, { status: 201 });
  } catch (error) {
    if (error instanceof ShiftRequiredError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** A paid out recorded by mistake can be removed on the same business day. */
export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const parsed = deleteSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select a paid out." }, { status: 400 });
    const outcome = await productionSql().begin(async (tx) => {
      const [paidOut] = await tx<Array<{ id: string; businessDate: string; amountCents: number; paidTo: string }>>`
        select id, business_date::text as "businessDate", amount_cents as "amountCents", paid_to as "paidTo"
        from paid_outs where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!paidOut) return "missing" as const;
      if (paidOut.businessDate !== await propertyBusinessDate(tx, session.propertyId)) return "closed" as const;
      await tx`delete from paid_outs where id=${paidOut.id}::uuid`;
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: paidOut.businessDate, resourceType: "paid-out", resourceId: paidOut.id,
        description: `Paid out to ${paidOut.paidTo} removed`, debitAccount: "Cash", creditAccount: "Paid Outs", amountCents: paidOut.amountCents,
      });
      return "deleted" as const;
    });
    if (outcome === "missing") return Response.json({ error: "Paid out not found." }, { status: 404 });
    if (outcome === "closed") return Response.json({ error: "Only today's paid outs can be removed; earlier days are closed." }, { status: 409 });
    return Response.json({ deleted: true });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
