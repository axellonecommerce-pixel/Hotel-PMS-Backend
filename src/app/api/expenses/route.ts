import { eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { expenses } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";
import { recordChange } from "@/server/realtime/change-events";

const expenseSchema = z.object({
  date: z.string().min(1), category: z.string().min(1), vendor: z.string().min(1),
  description: z.string().min(1), paymentMethod: z.string().min(1), amountCents: z.number().int().nonnegative(),
  notes: z.string().optional(), receiptName: z.string().optional(), recurring: z.boolean().optional(),
  recurrence: z.enum(["Weekly", "Monthly", "Quarterly", "Annually"]).optional(), nextDueDate: z.string().optional(),
});

function toClient(record: typeof expenses.$inferSelect) {
  return { id: record.id, date: record.expenseDate, category: record.category, vendor: record.vendor, description: record.description, paymentMethod: record.paymentMethod, amountCents: record.amountCents, notes: record.notes ?? undefined, receiptName: record.receiptReference ?? undefined, recurring: record.recurring, recurrence: record.recurrence ?? undefined, nextDueDate: record.nextDueDate ?? undefined, enteredBy: "Hotel Staff" };
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (hasProductionDatabase()) {
      const records = await productionSql()<Array<{
        id: string; date: string; category: string; vendor: string; description: string;
        paymentMethod: string; amountCents: number; receiptName: string | null;
      }>>`
        select e.id,e.expense_date::text as date,e.category,coalesce(v.name,'Other') as vendor,
          e.description,e.payment_method as "paymentMethod",e.amount_cents as "amountCents",
          e.receipt_storage_key as "receiptName"
        from expenses e left join vendors v on v.id=e.vendor_id
        where e.property_id=${session.propertyId}::uuid order by e.expense_date desc,e.created_at desc
      `;
      const recurringExpenses = await productionSql()<Array<{
        id: string; category: string; vendor: string; description: string;
        paymentMethod: string; amountCents: number; recurrence: string; nextDueDate: string;
      }>>`
        select re.id,re.category,coalesce(v.name,'Other') as vendor,re.description,
          re.payment_method as "paymentMethod",re.amount_cents as "amountCents",
          re.frequency as recurrence,re.next_run_on::text as "nextDueDate"
        from recurring_expenses re left join vendors v on v.id=re.vendor_id
        where re.property_id=${session.propertyId}::uuid and re.active=true
        order by re.next_run_on,re.created_at
      `;
      return Response.json({
        expenses: records.map((record) => ({ ...record, receiptName: record.receiptName ?? undefined, recurring: false, enteredBy: "Hotel Staff" })),
        recurringExpenses,
      });
    }
    const records = await db.query.expenses.findMany({ where: eq(expenses.propertyId, session.propertyId) });
    return Response.json({ expenses: records.map(toClient) });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    const parsed = expenseSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Expense details are invalid." }, { status: 400 });
    const now = new Date().toISOString();
    if (hasProductionDatabase()) {
      const created = await productionSql().begin(async (tx) => {
        let [vendor] = await tx<Array<{ id: string }>>`
          select id from vendors where property_id=${session.propertyId}::uuid and lower(name)=lower(${parsed.data.vendor}) limit 1
        `;
        if (!vendor) [vendor] = await tx<Array<{ id: string }>>`
          insert into vendors (property_id,name) values (${session.propertyId}::uuid,${parsed.data.vendor}) returning id
        `;
        const [expense] = await tx<Array<{ id: string }>>`
          insert into expenses (property_id,vendor_id,expense_date,category,description,payment_method,amount_cents)
          values (${session.propertyId}::uuid,${vendor.id}::uuid,${parsed.data.date}::date,${parsed.data.category},${parsed.data.description},${parsed.data.paymentMethod},${parsed.data.amountCents})
          returning id
        `;
        let recurringExpense: { id: string; category: string; vendor: string; description: string; paymentMethod: string; amountCents: number; recurrence: string; nextDueDate: string } | undefined;
        if (parsed.data.recurring && parsed.data.recurrence && parsed.data.nextDueDate) {
          const [createdRecurringExpense] = await tx<Array<{ id: string; category: string; description: string; paymentMethod: string; amountCents: number; recurrence: string; nextDueDate: string }>>`
          insert into recurring_expenses (property_id,vendor_id,category,description,payment_method,amount_cents,frequency,next_run_on)
          values (${session.propertyId}::uuid,${vendor.id}::uuid,${parsed.data.category},${parsed.data.description},${parsed.data.paymentMethod},${parsed.data.amountCents},${parsed.data.recurrence},${parsed.data.nextDueDate}::date)
          returning id,category,description,payment_method as "paymentMethod",amount_cents as "amountCents",frequency as recurrence,next_run_on::text as "nextDueDate"
        `;
          recurringExpense = { ...createdRecurringExpense, vendor: parsed.data.vendor };
        }
        await postProductionLedger(tx, {
          propertyId: session.propertyId,
          businessDate: parsed.data.date,
          resourceType: "expense",
          resourceId: expense.id,
          description: parsed.data.description,
          debitAccount: `Expense:${parsed.data.category}`,
          creditAccount: ["Cash", "Check", "Debit Card"].includes(parsed.data.paymentMethod) ? "Cash" : "Accounts Payable",
          amountCents: parsed.data.amountCents,
        });
        return {
          expense: { id: expense.id, ...parsed.data, recurring: parsed.data.recurring ?? false, enteredBy: "Hotel Staff" },
          recurringExpense,
        };
      });
      return Response.json(created, { status: 201 });
    }
    const record: typeof expenses.$inferInsert = {
      id: `expense-${crypto.randomUUID()}`, propertyId: session.propertyId, expenseDate: parsed.data.date,
      category: parsed.data.category, vendor: parsed.data.vendor, description: parsed.data.description,
      paymentMethod: parsed.data.paymentMethod, amountCents: parsed.data.amountCents, notes: parsed.data.notes,
      receiptReference: parsed.data.receiptName, recurring: parsed.data.recurring ?? false,
      recurrence: parsed.data.recurrence, nextDueDate: parsed.data.nextDueDate, status: "Posted", createdAt: now, updatedAt: now,
    };
    db.insert(expenses).values(record).run();
    const client = { id: record.id, ...parsed.data, recurring: parsed.data.recurring ?? false, enteredBy: "Hotel Staff" };
    recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "expense", entityId: record.id, action: "created", entityVersion: 1, payload: { expense: client } });
    return Response.json({ expense: client }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
