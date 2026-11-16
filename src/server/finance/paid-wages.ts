import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql<Record<string, never>>;

export const WAGES_CATEGORY = "Wages";

export type PaidWageExpense = {
  id: string;
  date: string;
  category: string;
  vendor: string;
  description: string;
  paymentMethod: string;
  amountCents: number;
  cashSource: string | null;
  bankAccountId: string | null;
  bankAccountName: string | null;
};

/**
 * Paid payroll entries shaped like expenses, so the Expenses screen, its
 * report, the dashboard and the Revenue net all count wages paid. Same
 * amount and date as the P&L "Wages (paid payroll)" line: gross pay plus any
 * adjustment, on the day it was paid. Read-only: the payroll entry is the
 * record; ids start with "payroll-".
 */
export async function paidWagesAsExpenses(db: Db, propertyId: string, range?: { start: string; end: string }) {
  return db<PaidWageExpense[]>`
    select 'payroll-' || pe.id::text as id, pe.paid_on::text as date, ${WAGES_CATEGORY} as category,
      coalesce(e.name,'Employee') as vendor,
      'Payroll ' || to_char(pp.starts_on,'Mon FMDD') || ' – ' || to_char(pp.ends_on,'Mon FMDD, YYYY') as description,
      coalesce(pe.payment_method,'Payroll') as "paymentMethod",
      (pe.gross_pay_cents + coalesce(case when left(ltrim(pe.description),1)='{' then (pe.description::jsonb->>'adjustmentCents')::int end,0))::int as "amountCents",
      pe.cash_source as "cashSource", pe.bank_account_id as "bankAccountId", ba.name as "bankAccountName"
    from payroll_entries pe
    join pay_periods pp on pp.id=pe.pay_period_id
    left join employees e on e.id=pe.employee_id
    left join bank_accounts ba on ba.id=pe.bank_account_id
    where pe.property_id=${propertyId}::uuid and pe.paid and pe.paid_on is not null
      ${range ? db`and pe.paid_on between ${range.start}::date and ${range.end}::date` : db``}
    order by pe.paid_on desc
  `;
}
