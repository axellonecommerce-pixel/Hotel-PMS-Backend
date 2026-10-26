import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postProductionLedger, propertyBusinessDate, reversalBusinessDate } from "@/server/finance/production-finance";
import { recordChange } from "@/server/realtime/change-events";

// Other Revenue (laundry, vending machine, ice machine, ...) is income that
// never touches a guest folio. Each entry is a balanced ledger posting:
// money received on the debit side, `Revenue:<category>` on the credit side,
// so Revenue and the Profit & Loss include it. Deleting posts a reversal.
const RECEIPTS = "Other Revenue Receipts:";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entrySchema = z.object({
  date: isoDate,
  category: z.string().trim().min(1).max(80).transform((value) => value.replace(/:/g, " ")),
  description: z.string().trim().max(300).default(""),
  paymentMethod: z.string().trim().min(1).max(40).transform((value) => value.replace(/:/g, " ")),
  amountCents: z.number().int().positive().max(100_000_000),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    const params = new URL(request.url).searchParams;
    const range = z.object({ start: isoDate, end: isoDate }).safeParse({ start: params.get("start"), end: params.get("end") });
    if (!range.success || range.data.end < range.data.start) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ entries: [] });
    const entries = await productionSql()<Array<{ id: string; date: string; category: string; description: string; paymentMethod: string; amountCents: number; createdAt: string }>>`
      select le.resource_id as id, le.business_date::text as date, substring(le.account from 9) as category, le.description,
        coalesce((select substring(d.account from ${RECEIPTS.length + 1}::int) from ledger_entries d
          where d.resource_id=le.resource_id and d.resource_type='misc-revenue' and d.debit_cents>0 limit 1), 'Other') as "paymentMethod",
        le.credit_cents as "amountCents", le.created_at::text as "createdAt"
      from ledger_entries le
      where le.property_id=${session.propertyId}::uuid and le.resource_type='misc-revenue'
        and le.account like 'Revenue:%' and le.credit_cents>0
        and le.business_date between ${range.data.start}::date and ${range.data.end}::date
        and not exists (select 1 from ledger_entries v where v.property_id=le.property_id and v.resource_type='misc-revenue-void' and v.resource_id=le.resource_id)
      order by le.business_date desc, le.created_at desc
    `;
    return Response.json({ entries });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    const parsed = entrySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter the date, category, payment method and an amount above zero." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The PMS server is not connected." }, { status: 503 });
    const input = parsed.data;
    const id = crypto.randomUUID();
    await productionSql().begin(async (tx) => {
      const today = await propertyBusinessDate(tx, session.propertyId);
      if (input.date > today) throw new RangeError(`Other revenue cannot be dated after the business date (${today}).`);
      await postProductionLedger(tx, {
        propertyId: session.propertyId,
        businessDate: input.date,
        resourceType: "misc-revenue",
        resourceId: id,
        description: input.description || input.category,
        debitAccount: `${RECEIPTS}${input.paymentMethod}`,
        creditAccount: `Revenue:${input.category}`,
        amountCents: input.amountCents,
      });
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "misc-revenue", entityId: id, action: "created", entityVersion: 1, payload: {} });
    return Response.json({ entry: { id, ...input, description: input.description || input.category } }, { status: 201 });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 });
    return propertyAccessResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Choose an entry to delete." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The PMS server is not connected." }, { status: 503 });
    const removed = await productionSql().begin(async (tx) => {
      const lines = await tx<Array<{ account: string; debitCents: number; creditCents: number; date: string; description: string }>>`
        select account, debit_cents as "debitCents", credit_cents as "creditCents", business_date::text as date, description
        from ledger_entries where property_id=${session.propertyId}::uuid and resource_type='misc-revenue' and resource_id=${id}::uuid
        for update
      `;
      const [voided] = await tx`select 1 from ledger_entries where property_id=${session.propertyId}::uuid and resource_type='misc-revenue-void' and resource_id=${id}::uuid limit 1`;
      const revenue = lines.find((line) => line.account.startsWith("Revenue:") && line.creditCents > 0);
      const receipt = lines.find((line) => line.debitCents > 0);
      if (!revenue || !receipt || voided) return false;
      await postProductionLedger(tx, {
        propertyId: session.propertyId,
        businessDate: reversalBusinessDate(await propertyBusinessDate(tx, session.propertyId), revenue.date),
        resourceType: "misc-revenue-void",
        resourceId: id,
        description: `Deleted: ${revenue.description}`,
        debitAccount: revenue.account,
        creditAccount: receipt.account,
        amountCents: revenue.creditCents,
      });
      return true;
    });
    if (!removed) return Response.json({ error: "That entry was not found or is already deleted." }, { status: 404 });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "misc-revenue", entityId: id, action: "deleted", entityVersion: 2, payload: {} });
    return Response.json({ deleted: true });
  } catch (error) { return propertyAccessResponse(error); }
}
