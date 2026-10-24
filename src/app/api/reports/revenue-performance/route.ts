import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const [inventory] = await productionSql()<Array<{ rooms: number }>>`
      select count(*) filter (where active=true and service_status='rentable')::int as rooms from rooms where property_id=${session.propertyId}::uuid
    `;
    const rows = await productionSql()<Array<{ date: string; roomRevenue: number; otherRevenue: number; taxes: number; expenses: number; roomsSold: number }>>`
      select day::date::text as date,
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account='Room Revenue'),0)::int as "roomRevenue",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account like 'Revenue:%'),0)::int as "otherRevenue",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account='Tax Payable'),0)::int as taxes,
        coalesce((select sum(e.amount_cents) from expenses e where e.property_id=${session.propertyId}::uuid and e.expense_date=day::date),0)::int as expenses,
        coalesce((select count(distinct rr.room_id) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${session.propertyId}::uuid and rr.room_id is not null and rr.status in ('reserved','checked_in','checked_out') and r.status not in ('cancelled','no_show') and ((r.arrival_date <= day::date and r.departure_date > day::date) or (r.arrival_date=day::date and r.departure_date=day::date))),0)::int as "roomsSold"
      from generate_series(${input.data.startDate}::date,${input.data.endDate}::date,'1 day'::interval) as days(day)
      order by day desc
    `;
    const totalRoomRevenue = rows.reduce((sum, row) => sum + row.roomRevenue, 0);
    const totalOtherRevenue = rows.reduce((sum, row) => sum + row.otherRevenue, 0);
    const totalExpenses = rows.reduce((sum, row) => sum + row.expenses, 0);
    const roomsSold = rows.reduce((sum, row) => sum + row.roomsSold, 0);
    const availableRoomNights = (inventory?.rooms ?? 0) * rows.length;
    return Response.json({ report: {
      metrics: [
        { label: "Gross Revenue", value: totalRoomRevenue + totalOtherRevenue, format: "money" },
        { label: "Operating Expenses", value: totalExpenses, format: "money" },
        { label: "Net Revenue", value: totalRoomRevenue + totalOtherRevenue - totalExpenses, format: "money" },
        { label: "Occupancy", value: availableRoomNights ? roomsSold / availableRoomNights * 100 : 0, format: "percent" },
      ],
      columns: [
        { key: "date", label: "Date", format: "date" }, { key: "roomRevenue", label: "Room Revenue", format: "money", align: "right" },
        { key: "otherRevenue", label: "Other Revenue", format: "money", align: "right" }, { key: "taxes", label: "Taxes", format: "money", align: "right" },
        { key: "expenses", label: "Expenses", format: "money", align: "right" }, { key: "net", label: "Net Revenue", format: "money", align: "right" },
        { key: "roomsSold", label: "Rooms Sold", format: "number", align: "right" }, { key: "occupancy", label: "Occupancy", format: "percent", align: "right" },
        { key: "adr", label: "ADR", format: "money", align: "right" }, { key: "revpar", label: "RevPAR", format: "money", align: "right" },
      ],
      rows: rows.map((row) => ({
        id: row.date, date: row.date, roomRevenue: row.roomRevenue, otherRevenue: row.otherRevenue, taxes: row.taxes, expenses: row.expenses,
        net: row.roomRevenue + row.otherRevenue - row.expenses, roomsSold: row.roomsSold,
        occupancy: inventory?.rooms ? row.roomsSold / inventory.rooms * 100 : 0,
        adr: row.roomsSold ? row.roomRevenue / row.roomsSold : 0, revpar: inventory?.rooms ? row.roomRevenue / inventory.rooms : 0,
      })),
      note: "Revenue comes from posted ledger credits and operating expenses from posted expense records. Day-use stays are included in rooms sold without reducing overnight inventory.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
