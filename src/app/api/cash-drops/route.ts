import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

// Closed shift history. Shifts are opened and closed through /api/shifts.

type CashRecord = {
  id: string;
  date: string;
  shift: string;
  expectedCents: number;
  countedCents: number;
  differenceCents: number;
  droppedCents: number;
  employee: string;
  status: "Balanced" | "Over" | "Short";
  notes?: string;
};

function toRecord(row: {
  id: string; date: string; status: string; expectedCents: number | null; countedCents: number | null;
  openingCents: number; drawerFloatCents: number; droppedCents: number; employee: string; note: string | null;
}): CashRecord {
  // Shift cash only: the opening balance the drawer started with is left out of both figures.
  const expectedCents = (row.expectedCents ?? row.openingCents) - row.openingCents;
  const countedCents = (row.countedCents ?? 0) - row.openingCents;
  const differenceCents = countedCents - expectedCents;
  const shift = row.status.split(":")[1] || "Shift";
  return {
    id: row.id,
    date: row.date,
    shift,
    expectedCents,
    countedCents,
    differenceCents,
    droppedCents: row.droppedCents,
    employee: row.employee,
    status: differenceCents === 0 ? "Balanced" : differenceCents > 0 ? "Over" : "Short",
    notes: row.note ?? undefined,
  };
}

async function listRecords(propertyId: string) {
  const rows = await productionSql()<Array<{
    id: string; date: string; status: string; expectedCents: number | null; countedCents: number | null;
    openingCents: number; drawerFloatCents: number; droppedCents: number; employee: string; note: string | null;
  }>>`
    select cs.id, bd.business_date::text as date, cs.status,
      cs.expected_cents as "expectedCents", cs.counted_cents as "countedCents",
      cs.opening_cents as "openingCents", cs.drawer_float_cents as "drawerFloatCents",
      coalesce(sum(cd.amount_cents),0)::int as "droppedCents", e.name as employee,
      max(cd.note) as note
    from cash_shifts cs
    join business_days bd on bd.id=cs.business_day_id
    join employees e on e.id=cs.employee_id
    left join cash_drops cd on cd.cash_shift_id=cs.id
    where cs.property_id=${propertyId}::uuid and cs.status like 'closed:%'
    group by cs.id,bd.business_date,e.name
    order by bd.business_date desc,cs.closed_at desc nulls last
    limit 100
  `;
  return rows.map(toRecord);
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    if (!hasProductionDatabase()) return Response.json({ records: [] });
    return Response.json({ records: await listRecords(session.propertyId) });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
