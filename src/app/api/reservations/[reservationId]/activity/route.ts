import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

/** HotelKey "Reservation Activity Log": every change to this reservation, newest first. */
export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const { reservationId } = await context.params;
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    const entries = await productionSql()<Array<{ id: string; at: string; actor: string; category: string; description: string }>>`
      select a.id, to_char(a.created_at at time zone p.timezone, 'YYYY-MM-DD"T"HH24:MI:SS') as at, a.actor_name as actor, a.category, a.description
      from reservation_activity a join properties p on p.id=a.property_id
      where a.property_id=${session.propertyId}::uuid and a.reservation_id=${reservationId}::uuid
      order by a.created_at desc, a.id desc
      limit 1000
    `;
    return Response.json({ entries });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
