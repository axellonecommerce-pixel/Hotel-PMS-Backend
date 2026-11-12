import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Read-only payroll history. Payroll calculation and approval remain in Payroll. */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    // Custom date ranges are only for checking hours (Payroll says so); they
    // overlap real pay periods, so counting them would pay the same hours
    // twice. They count only once approved or paid. Deleted pay never counts.
    const records = await productionSql()<Array<{ id: string; period: string; employee: string; minutes: number; grossCents: number; adjustmentCents: number; paid: boolean; approved: boolean; paidOn: string | null; method: string | null }>>`
      select pe.id,pp.starts_on::text||' to '||pp.ends_on::text as period,e.name as employee,
        (pe.regular_minutes+coalesce(pe.overtime_minutes,0)+coalesce(case when pe.description like '{%' then (pe.description::jsonb->>'doubleTimeMinutes')::int end,0))::int as minutes,
        pe.gross_pay_cents as "grossCents",
        coalesce(case when pe.description like '{%' then (pe.description::jsonb->>'adjustmentCents')::int else 0 end,0)::int as "adjustmentCents",pe.paid,
        coalesce(pe.description like '{%' and pe.description::jsonb->>'status'='Approved',false) as approved,
        pe.paid_on::text as "paidOn",
        case when pe.paid then pe.payment_method end as method
      from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id join employees e on e.id=pe.employee_id
      where pe.property_id=${session.propertyId}::uuid
        and pp.starts_on <= ${input.data.endDate}::date and pp.ends_on >= ${input.data.startDate}::date
        and not coalesce(pe.description like '{%' and (pe.description::jsonb->>'removed')::boolean, false)
        and (pp.status <> 'custom' or pe.paid or (pe.description like '{%' and pe.description::jsonb->>'status'='Approved'))
        and (pe.gross_pay_cents <> 0 or pe.paid)
      order by pp.ends_on desc,e.name
    `;
    const finalCents = (record: (typeof records)[number]) => record.grossCents + record.adjustmentCents;
    const sumOf = (list: ReadonlyArray<(typeof records)[number]>, value: (record: (typeof records)[number]) => number) => list.reduce((sum, record) => sum + value(record), 0);
    const paid = records.filter((record) => record.paid);
    return Response.json({ report: {
      metrics: [
        { label: "Final Payroll", value: sumOf(records, finalCents), format: "money" },
        { label: "Paid", value: sumOf(paid, finalCents), format: "money" },
        { label: "Not Yet Paid", value: sumOf(records.filter((record) => !record.paid), finalCents), format: "money" },
        { label: "Entries", value: records.length, format: "number" },
      ],
      columns: [
        { key: "period", label: "Pay Period" }, { key: "employee", label: "Employee" }, { key: "hours", label: "Hours", format: "hours", align: "right" },
        { key: "gross", label: "Gross Pay", format: "money", align: "right" }, { key: "adjustment", label: "Adjustment", format: "money", align: "right" },
        { key: "final", label: "Final Pay", format: "money", align: "right" }, { key: "status", label: "Status", format: "status" },
        { key: "paidOn", label: "Paid On", format: "date" }, { key: "method", label: "Paid By" },
      ],
      rows: records.map((record) => ({
        id: record.id, period: record.period, employee: record.employee, hours: record.minutes / 60, gross: record.grossCents, adjustment: record.adjustmentCents,
        final: finalCents(record), status: record.paid ? "Paid" : record.approved ? "Approved" : "Pending", paidOn: record.paidOn ?? "", method: record.method ?? "",
      })),
      note: "Pay periods that overlap the dates chosen. Custom date ranges count only once approved or paid, so hours are never counted twice. Final Pay is gross pay plus adjustments, before tax.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
