import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Tenant-scoped, read-only guest/stay report used by Front Desk reporting. */
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
      guest: string;
      arrival: string;
      departure: string;
      rooms: string | null;
      status: string;
      balanceCents: number;
      isGroup: boolean;
    }>>`
      select r.id,concat(g.first_name,' ',g.last_name) as guest,
        r.arrival_date::text as arrival,r.departure_date::text as departure,r.status,
        (select string_agg(coalesce(room.number,'Unassigned'),', ' order by reservation_room.created_at)
          from reservation_rooms reservation_room
          left join rooms room on room.id=reservation_room.room_id
          where reservation_room.reservation_id=r.id) as rooms,
        (select count(*) > 1 from reservation_rooms reservation_room where reservation_room.reservation_id=r.id) as "isGroup",
        (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0))
          from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0))::int as "balanceCents"
      from reservations r
      join guests g on g.id=r.main_guest_id
      where r.property_id=${session.propertyId}::uuid
        and r.arrival_date<=${input.data.endDate}::date
        and r.departure_date>=${input.data.startDate}::date
      order by r.arrival_date desc,r.created_at desc
    `;
    const statusLabel = (status: string) => status === "checked_in" ? "Checked In"
      : status === "checked_out" ? "Checked Out"
        : status === "no_show" ? "No Show"
          : status === "cancelled" ? "Cancelled" : "Reserved";
    return Response.json({
      report: {
        metrics: [
          { label: "Stays", value: records.length, format: "number" },
          { label: "In House", value: records.filter((record) => record.status === "checked_in").length, format: "number" },
          { label: "Checked Out", value: records.filter((record) => record.status === "checked_out").length, format: "number" },
          { label: "Groups", value: records.filter((record) => record.isGroup).length, format: "number" },
        ],
        columns: [
          { key: "guest", label: "Guest" },
          { key: "arrival", label: "Arrival", format: "date" },
          { key: "departure", label: "Departure", format: "date" },
          { key: "room", label: "Room(s)" },
          { key: "status", label: "Status", format: "status" },
          { key: "balance", label: "Balance", format: "money", align: "right" },
        ],
        rows: records.map((record) => ({
          id: record.id,
          guest: record.guest,
          arrival: record.arrival,
          departure: record.departure,
          room: record.rooms ?? "Unassigned",
          status: statusLabel(record.status),
          balance: record.balanceCents,
        })),
        note: "Includes reservations whose stay dates overlap the selected period, including same-day stays.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
