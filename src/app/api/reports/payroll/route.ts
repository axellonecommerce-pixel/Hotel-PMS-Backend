import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Read-only payroll history. Payroll calculation and approval remain in Payroll. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const records = await productionSql()<Array<{ id: string; period: string; employee: string; regularMinutes: number; grossCents: number; adjustmentCents: number; paid: boolean }>>`
      select pe.id,pp.starts_on::text||' to '||pp.ends_on::text as period,e.name as employee,pe.regular_minutes as "regularMinutes",pe.gross_pay_cents as "grossCents",
        coalesce(case when pe.description like '{%' then (pe.description::jsonb->>'adjustmentCents')::int else 0 end,0)::int as "adjustmentCents",pe.paid
      from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id join employees e on e.id=pe.employee_id
      where pe.property_id=${session.propertyId}::uuid
        and pp.starts_on <= ${input.data.endDate}::date and pp.ends_on >= ${input.data.startDate}::date
      order by pp.ends_on desc,e.name
    `;
    const total = (field: "grossCents" | "adjustmentCents") => records.reduce((sum, record) => sum + record[field], 0);
    return Response.json({ report: {
      metrics: [
        { label: "Final Payroll", value: total("grossCents") + total("adjustmentCents"), format: "money" },
        { label: "Gross Pay", value: total("grossCents"), format: "money" },
        { label: "Adjustments", value: total("adjustmentCents"), format: "money" },
        { label: "Entries", value: records.length, format: "number" },
      ],
      columns: [
        { key: "period", label: "Pay Period" }, { key: "employee", label: "Employee" }, { key: "hours", label: "Hours", format: "hours", align: "right" },
        { key: "gross", label: "Gross Pay", format: "money", align: "right" }, { key: "final", label: "Final Pay", format: "money", align: "right" }, { key: "status", label: "Status", format: "status" },
      ],
      rows: records.map((record) => ({ id: record.id, period: record.period, employee: record.employee, hours: record.regularMinutes / 60, gross: record.grossCents, final: record.grossCents + record.adjustmentCents, status: record.paid ? "Paid" : "Pending" })),
      note: "This report reads persisted payroll entries for overlapping pay periods. It does not calculate, approve, or pay payroll.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
