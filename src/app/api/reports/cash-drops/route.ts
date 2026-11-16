import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { cashActivityBetween } from "@/server/finance/shift-guard";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Read-only cash reconciliation report, one row per closed shift:
 * Opening + Cash In − Paid Out = Expected, then Counted and Dropped.
 * Paid outs are listed by who was paid, so payouts can be tracked.
 */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) {
      return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    }
    if (!hasProductionDatabase()) {
      return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    }
    const sql = productionSql();
    const shifts = await sql<Array<{
      id: string; date: string; openedAt: string; closedAt: string | null; openingCents: number;
      expectedCents: number; countedCents: number; droppedCents: number; status: string; employee: string; note: string | null;
    }>>`
      select cs.id,bd.business_date::text as date,
        to_char(cs.opened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt",
        to_char(cs.closed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "closedAt",
        coalesce(cs.opening_cents,0)::int as "openingCents",
        coalesce(cs.expected_cents,0)::int as "expectedCents",
        coalesce(cs.counted_cents,0)::int as "countedCents",
        coalesce(sum(cd.amount_cents),0)::int as "droppedCents",
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
    // Same cash-in / paid-out rule the drawer used at End Shift.
    const records = await Promise.all(shifts.map(async (shift) => {
      const activity = await cashActivityBetween(sql, session.propertyId, shift.openedAt, shift.closedAt);
      const paidOuts = await sql<Array<{ paidTo: string; reason: string; amountCents: number }>>`
        select paid_to as "paidTo",reason,amount_cents as "amountCents" from paid_outs
        where property_id=${session.propertyId}::uuid and created_at >= ${shift.openedAt}::timestamptz
          and (${shift.closedAt}::timestamptz is null or created_at < ${shift.closedAt}::timestamptz)
        order by created_at
      `;
      return {
        ...shift,
        cashInCents: activity.paymentCents - activity.refundCents + activity.depositCents,
        paidOutCents: activity.paidOutCents,
        paidOuts,
      };
    }));
    type Field = "cashInCents" | "paidOutCents" | "expectedCents" | "countedCents" | "droppedCents";
    const total = (field: Field) => records.reduce((sum, record) => sum + record[field], 0);
    return Response.json({
      report: {
        metrics: [
          { label: "Cash In", value: total("cashInCents"), format: "money" },
          { label: "Paid Out", value: total("paidOutCents"), format: "money" },
          { label: "Expected", value: total("expectedCents"), format: "money" },
          { label: "Counted", value: total("countedCents"), format: "money" },
          { label: "Difference", value: records.reduce((sum, record) => sum + record.countedCents - record.expectedCents, 0), format: "money" },
          { label: "Dropped", value: total("droppedCents"), format: "money" },
        ],
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "shift", label: "Shift" },
          { key: "employee", label: "Clerk" },
          { key: "opening", label: "Opening", format: "money", align: "right" },
          { key: "cashIn", label: "Cash In", format: "money", align: "right" },
          { key: "paidOut", label: "Paid Out", format: "money", align: "right" },
          { key: "paidOutTo", label: "Paid Out To" },
          { key: "expected", label: "Expected", format: "money", align: "right" },
          { key: "counted", label: "Counted", format: "money", align: "right" },
          { key: "difference", label: "Difference", format: "money", align: "right" },
          { key: "dropped", label: "Dropped", format: "money", align: "right" },
          { key: "note", label: "Note" },
        ],
        rows: records.map((record) => ({
          id: record.id,
          date: record.date,
          shift: record.status.replace(/^closed:/, "") || "Closed",
          employee: record.employee,
          opening: record.openingCents,
          cashIn: record.cashInCents,
          paidOut: record.paidOutCents,
          paidOutTo: record.paidOuts.length
            ? record.paidOuts.map((item) => `${item.paidTo} ${money(item.amountCents)} (${item.reason})`).join("; ")
            : "—",
          expected: record.expectedCents,
          counted: record.countedCents,
          difference: record.countedCents - record.expectedCents,
          dropped: record.droppedCents,
          note: record.note ?? "—",
        })),
        note: "Each closed shift: Opening + Cash In (cash payments, less cash refunds, plus cash deposits) − Paid Out = Expected. Paid Out To lists every payout from the drawer during the shift.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
