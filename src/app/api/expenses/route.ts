import { eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { expenses } from "@/server/db/schema";
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
