import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Occupancy is calculated from durable room assignments.  Cleanliness and
 * service status are current inventory values; they are intentionally not
 * presented as reconstructed historical housekeeping data.
 */
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

    const [inventory] = await productionSql()<Array<{ totalRooms: number; rentableRooms: number; dirtyRooms: number }>>`
      select count(*)::int as "totalRooms",
        count(*) filter (where service_status='rentable')::int as "rentableRooms",
        count(*) filter (where cleanliness_status <> 'clean')::int as "dirtyRooms"
      from rooms where property_id=${session.propertyId}::uuid and active=true
    `;
    const daily = await productionSql()<Array<{ date: string; occupied: number; dayUse: number; arrivals: number }>>`
      select day::date::text as date,
        coalesce((select count(distinct rr.room_id)
          from reservation_rooms rr
          join reservations r on r.id=rr.reservation_id
          where r.property_id=${session.propertyId}::uuid
            and rr.room_id is not null
            and rr.status in ('reserved','checked_in','checked_out')
            and r.status not in ('cancelled','no_show')
            and r.arrival_date <= day::date
            and r.departure_date > day::date),0)::int as occupied,
        coalesce((select count(distinct rr.room_id)
          from reservation_rooms rr
          join reservations r on r.id=rr.reservation_id
          where r.property_id=${session.propertyId}::uuid
            and rr.room_id is not null
            and rr.status in ('reserved','checked_in','checked_out')
            and r.status not in ('cancelled','no_show')
            and r.arrival_date=day::date and r.departure_date=day::date),0)::int as "dayUse",
        coalesce((select count(*) from reservations r
          where r.property_id=${session.propertyId}::uuid
            and r.arrival_date=day::date
            and r.status in ('reserved','checked_in','checked_out')),0)::int as arrivals
      from generate_series(${input.data.startDate}::date,${input.data.endDate}::date,'1 day'::interval) as days(day)
      order by day
    `;
    const totalRooms = inventory?.totalRooms ?? 0;
    const rentableRooms = inventory?.rentableRooms ?? 0;
    const dirtyRooms = inventory?.dirtyRooms ?? 0;
    const rows = daily.map((record) => ({
      id: record.date,
      date: record.date,
      occupied: record.occupied,
      arrival: record.arrivals,
      availableClean: Math.max(0, rentableRooms - dirtyRooms - record.occupied),
      dirty: dirtyRooms,
      dayUse: record.dayUse,
      occupancyRate: rentableRooms ? ((record.occupied + record.dayUse) / rentableRooms) * 100 : 0,
    })).reverse();
    const occupancyRates = rows.map((row) => Number(row.occupancyRate));
    return Response.json({
      report: {
        metrics: [
          { label: "Current Available / Clean", value: Math.max(0, rentableRooms - dirtyRooms - (daily.at(-1)?.occupied ?? 0)), format: "number" },
          { label: "Average Occupancy", value: occupancyRates.length ? occupancyRates.reduce((sum, value) => sum + value, 0) / occupancyRates.length : 0, format: "percent" },
          { label: "Peak Occupied", value: daily.length ? Math.max(...daily.map((record) => record.occupied)) : 0, format: "number" },
          { label: "Total Inventory", value: totalRooms, format: "number" },
        ],
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "occupied", label: "Occupied", format: "number", align: "right" },
          { key: "dayUse", label: "Day Use Sold", format: "number", align: "right" },
          { key: "arrival", label: "Scheduled Arrivals", format: "number", align: "right" },
          { key: "availableClean", label: "Available / Clean", format: "number", align: "right" },
          { key: "dirty", label: "Dirty Now", format: "number", align: "right" },
          { key: "occupancyRate", label: "Occupancy (Rentable)", format: "percent", align: "right" },
        ],
        rows,
        note: "Occupied room-nights come from saved room assignments. Same-day day-use stays count as rooms sold but do not reduce overnight availability. Cleanliness and service readiness reflect current inventory, not reconstructed historical housekeeping state.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
