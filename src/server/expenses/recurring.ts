import type { TransactionSql } from "postgres";

import { postProductionLedger } from "@/server/finance/production-finance";

type Tx = TransactionSql<Record<string, never>>;
type Recurrence = "Weekly" | "Monthly" | "Quarterly" | "Annually";

export function nextRecurringExpenseDate(value: string, recurrence: Recurrence) {
  const [year, month, day] = value.split("-").map(Number);
  const atUtc = (nextYear: number, nextMonth: number, requestedDay: number) => {
    const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(nextYear, nextMonth, Math.min(requestedDay, lastDay))).toISOString().slice(0, 10);
  };
  if (recurrence === "Weekly") return new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
  if (recurrence === "Monthly") return atUtc(year, month, day);
  if (recurrence === "Quarterly") return atUtc(year, month + 2, day);
  return atUtc(year + 1, month - 1, day);
}

type DueRecurringExpense = {
  id: string;
  propertyId: string;
  vendorId: string | null;
  category: string;
  description: string;
  paymentMethod: string;
  amountCents: number;
  recurrence: Recurrence;
  nextDueDate: string;
  businessDate: string;
};

/**
 * Post every due recurring expense exactly once. The schedule rows are locked
 * inside the caller's transaction; advancing `next_run_on` and posting the
 * expense ledger lines therefore succeed or roll back together.
 */
export async function postDueRecurringExpenses(tx: Tx) {
  const schedules = await tx<DueRecurringExpense[]>`
    select re.id,re.property_id as "propertyId",re.vendor_id as "vendorId",re.category,
      re.description,re.payment_method as "paymentMethod",re.amount_cents as "amountCents",
      re.frequency as recurrence,re.next_run_on::text as "nextDueDate",
      (now() at time zone p.timezone)::date::text as "businessDate"
    from recurring_expenses re join properties p on p.id=re.property_id
    where re.active=true and re.next_run_on <= (now() at time zone p.timezone)::date
    for update of re
  `;
  let posted = 0;
  for (const schedule of schedules) {
    let dueDate = schedule.nextDueDate;
    let generated = 0;
    while (dueDate <= schedule.businessDate) {
      if (generated >= 366) throw new Error(`Recurring expense ${schedule.id} has too many overdue occurrences.`);
      const [expense] = await tx<Array<{ id: string }>>`
        insert into expenses (property_id,vendor_id,expense_date,category,description,payment_method,amount_cents)
        values (${schedule.propertyId}::uuid,${schedule.vendorId}::uuid,${dueDate}::date,${schedule.category},${schedule.description},${schedule.paymentMethod},${schedule.amountCents})
        returning id
      `;
      await postProductionLedger(tx, {
        propertyId: schedule.propertyId,
        businessDate: dueDate,
        resourceType: "expense",
        resourceId: expense.id,
        description: `Recurring expense: ${schedule.description}`,
        debitAccount: `Expense:${schedule.category}`,
        creditAccount: ["Cash", "Check", "Debit Card"].includes(schedule.paymentMethod) ? "Cash" : "Accounts Payable",
        amountCents: schedule.amountCents,
      });
      dueDate = nextRecurringExpenseDate(dueDate, schedule.recurrence);
      generated += 1;
      posted += 1;
    }
    await tx`update recurring_expenses set next_run_on=${dueDate}::date,updated_at=now() where id=${schedule.id}::uuid`;
  }
  return posted;
}
