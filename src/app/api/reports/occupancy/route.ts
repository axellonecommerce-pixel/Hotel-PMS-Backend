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
    const daily = await productionSql()<Array<{ date: string; occupied: number; dayUse: number; arrivals: number; departures: number; cleaned: number }>>`
      select day::date::text as date,
        coalesce((select count(distinct rr.room_id)
          from reservation_rooms rr
          join reservations r on r.id=rr.reservation_id
          where r.property_id=${session.propertyId}::uuid
            and rr.room_id is not null
            and rr.status in ('reserved','checked_in','checked_out')
            and r.status not in ('cancelled','no_show')
            and r.arrival_date <= day::date
            and r.departure_date > day::date
            and (rr.checked_out_at is null or (rr.checked_out_at at time zone coalesce((select timezone from properties where id=${session.propertyId}::uuid),'UTC'))::date > day::date)),0)::int as occupied,
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
            and r.status in ('reserved','checked_in','checked_out')),0)::int as arrivals,
        -- Rooms that checked out (or are due out) that day, and rooms housekeeping finished that day.
        coalesce((select count(distinct rr.room_id) from reservation_rooms rr join reservations r on r.id=rr.reservation_id
          where r.property_id=${session.propertyId}::uuid and rr.room_id is not null and rr.status in ('checked_in','checked_out','reserved')
            and r.status not in ('cancelled','no_show') and r.departure_date=day::date and r.arrival_date < day::date),0)::int as departures,
        coalesce((select count(*) from housekeeping_records h where h.property_id=${session.propertyId}::uuid and h.service_date=day::date and h.assignment_status='completed'),0)::int as cleaned
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
      departures: record.departures,
      cleaned: record.cleaned,
      available: Math.max(0, rentableRooms - record.occupied),
      dayUse: record.dayUse,
      occupancyRate: rentableRooms ? ((record.occupied + record.dayUse) / rentableRooms) * 100 : 0,
    })).reverse();
    const occupancyRates = rows.map((row) => Number(row.occupancyRate));
    return Response.json({
      report: {
        metrics: [
          { label: "Dirty Now", value: dirtyRooms, format: "number" },
          { label: "Rooms Cleaned", value: daily.reduce((total, record) => total + record.cleaned, 0), format: "number" },
          { label: "Average Occupancy", value: occupancyRates.length ? occupancyRates.reduce((sum, value) => sum + value, 0) / occupancyRates.length : 0, format: "percent" },
          { label: "Peak Occupied", value: daily.length ? Math.max(...daily.map((record) => record.occupied)) : 0, format: "number" },
          { label: "Total Inventory", value: totalRooms, format: "number" },
        ],
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "occupied", label: "Occupied", format: "number", align: "right" },
          { key: "dayUse", label: "Day Use Sold", format: "number", align: "right" },
          { key: "arrival", label: "Scheduled Arrivals", format: "number", align: "right" },
          { key: "departures", label: "Departures", format: "number", align: "right" },
          { key: "cleaned", label: "Rooms Cleaned", format: "number", align: "right" },
          { key: "available", label: "Available to Sell", format: "number", align: "right" },
          { key: "occupancyRate", label: "Occupancy (Rentable)", format: "percent", align: "right" },
        ],
        rows,
        note: "Occupied room-nights come from saved room assignments. Same-day day-use stays count as rooms sold but do not reduce overnight availability. Each day shows its own departures, rooms housekeeping finished, and rooms left to sell (rentable minus occupied). Dirty Now is today's live count. A guest who checked out early is not counted on the nights after.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
