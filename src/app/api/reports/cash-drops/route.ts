import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Read-only cash reconciliation report. Money calculation remains in cash-drop transactions. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) {
      return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    }
    if (!hasProductionDatabase()) {
      return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    }
    const records = await productionSql()<Array<{
      id: string;
      date: string;
      expectedCents: number;
      countedCents: number;
      droppedCents: number;
      status: string;
      employee: string;
      note: string | null;
    }>>`
      select cs.id,bd.business_date::text as date,cs.expected_cents as "expectedCents",
        cs.counted_cents as "countedCents",coalesce(sum(cd.amount_cents),0)::int as "droppedCents",
        cs.status,e.name as employee,max(cd.note) as note
      from cash_shifts cs
      join business_days bd on bd.id=cs.business_day_id
      join employees e on e.id=cs.employee_id
      left join cash_drops cd on cd.cash_shift_id=cs.id
      where cs.property_id=${session.propertyId}::uuid
        and bd.business_date between ${input.data.startDate}::date and ${input.data.endDate}::date
        and cs.status like 'closed:%'
      group by cs.id,bd.business_date,e.name
      order by bd.business_date desc,cs.closed_at desc nulls last
    `;
    const total = (field: "expectedCents" | "countedCents" | "droppedCents") => records.reduce((sum, record) => sum + record[field], 0);
    return Response.json({
      report: {
        metrics: [
          { label: "Expected", value: total("expectedCents"), format: "money" },
          { label: "Counted", value: total("countedCents"), format: "money" },
          { label: "Difference", value: records.reduce((sum, record) => sum + record.countedCents - record.expectedCents, 0), format: "money" },
          { label: "Dropped", value: total("droppedCents"), format: "money" },
        ],
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "shift", label: "Shift" },
          { key: "employee", label: "Clerk" },
          { key: "expected", label: "Expected", format: "money", align: "right" },
          { key: "counted", label: "Counted", format: "money", align: "right" },
          { key: "difference", label: "Difference", format: "money", align: "right" },
          { key: "dropped", label: "Dropped", format: "money", align: "right" },
          { key: "status", label: "Status", format: "status" },
          { key: "note", label: "Note" },
        ],
        rows: records.map((record) => ({
          id: record.id,
          date: record.date,
          shift: record.status.replace(/^closed:/, "") || "Closed",
          employee: record.employee,
          expected: record.expectedCents,
          counted: record.countedCents,
          difference: record.countedCents - record.expectedCents,
          dropped: record.droppedCents,
          status: "Closed",
          note: record.note ?? "—",
        })),
        note: "Cash reconciliations are read from closed, tenant-scoped cash shifts in the selected business-date range.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
