import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

export const dynamic = "force-dynamic";

/**
 * Stayovers that extended on their departure date: in-house guests whose
 * stay was extended from a departure on `date`. Housekeeping services these
 * rooms as stayovers, not checkout cleans.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse({ date: new URL(request.url).searchParams.get("date") });
    if (!parsed.success) return Response.json({ error: "A valid date is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ rooms: [] });
    const rooms = await productionSql()<Array<{ roomNumber: string; reservationId: string; newDeparture: string }>>`
      select distinct ro.number as "roomNumber", r.id as "reservationId", r.departure_date::text as "newDeparture"
      from reservation_activity a
      join reservations r on r.id=a.reservation_id
      join reservation_rooms rr on rr.reservation_id=r.id and rr.status='checked_in'
      join rooms ro on ro.id=rr.room_id
      where a.property_id=${session.propertyId}::uuid and a.category='Stay' and a.description like 'Stay extended%'
        and substring(a.description from 'departure (\\d{4}-\\d{2}-\\d{2})') = ${parsed.data.date}
        and r.status='checked_in' and r.departure_date > ${parsed.data.date}::date
      order by 1
    `;
    return Response.json({ rooms }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}
