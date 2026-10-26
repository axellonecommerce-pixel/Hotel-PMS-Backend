import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

type Row = { source: "room" | "folio" | "misc" | "tax" | "ota" | "expense" | "paidOut" | "payroll"; category: string; month: string; cents: number };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Raw figures for the Profit & Loss / Schedule C worksheet, by month: room
 * revenue, folio charges and Other Revenue by category, tax collected, OTA
 * commission, expenses by category ("Main › Sub"), cash paid outs and gross
 * wages from the time clock. The screen groups and maps them to lines.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const params = new URL(request.url).searchParams;
    const range = z.object({ start: isoDate, end: isoDate }).safeParse({ start: params.get("start"), end: params.get("end") });
    if (!range.success || range.data.end < range.data.start) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ rows: [] });
    const { start, end } = range.data;
    const sql = productionSql();
    const [ledger, expenses, paidOuts, payroll] = await Promise.all([
      sql<Row[]>`
        select case
            when account='Room Revenue' then 'room'
            when account='Tax Payable' then 'tax'
            when account='OTA Commission Expense' then 'ota'
            when resource_type like 'misc-revenue%' then 'misc'
            else 'folio' end as source,
          case when account like 'Revenue:%' then substring(account from 9) else account end as category,
          to_char(business_date,'YYYY-MM') as month,
          sum(case when account='OTA Commission Expense' then debit_cents-credit_cents else credit_cents-debit_cents end)::int as cents
        from ledger_entries
        where property_id=${session.propertyId}::uuid and business_date between ${start}::date and ${end}::date
          and (account in ('Room Revenue','Tax Payable','OTA Commission Expense') or account like 'Revenue:%')
        group by 1,2,3
      `,
      sql<Row[]>`
        select 'expense' as source, category, to_char(expense_date,'YYYY-MM') as month, sum(amount_cents)::int as cents
        from expenses where property_id=${session.propertyId}::uuid and expense_date between ${start}::date and ${end}::date
        group by 2,3
      `,
      sql<Row[]>`
        select 'paidOut' as source, coalesce(nullif(trim(reason),''),'Paid out') as category, to_char(business_date,'YYYY-MM') as month, sum(amount_cents)::int as cents
        from paid_outs where property_id=${session.propertyId}::uuid and business_date between ${start}::date and ${end}::date
        group by 2,3
      `,
      sql<Row[]>`
        select 'payroll' as source, 'Wages (time clock)' as category, to_char(te.work_date,'YYYY-MM') as month,
          round(sum(greatest(0, extract(epoch from (te.clock_out_at-te.clock_in_at))/60 - te.break_minutes) * coalesce(e.hourly_rate_cents,0) / 60.0))::int as cents
        from time_entries te join employees e on e.id=te.employee_id
        where te.property_id=${session.propertyId}::uuid and te.clock_out_at is not null and te.work_date between ${start}::date and ${end}::date
        group by 3
      `,
    ]);
    const rows = [...ledger, ...expenses, ...paidOuts, ...payroll].filter((row) => row.cents !== 0);
    return Response.json({ start, end, rows });
  } catch (error) { return propertyAccessResponse(error); }
}
