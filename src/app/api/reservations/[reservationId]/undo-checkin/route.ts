import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { logReservationActivity } from "@/server/activity/reservation-activity";
import { withRequestContext } from "@/server/db/request-context";

// Undo Check-In: the wrong guest or reservation was checked in. The stay goes
// back to Arrivals (Reserved) on the same business day; its charges,
// payments, deposits and signatures stay on the folio for the right guest or
// for a refund. Rooms are not marked dirty: nobody stayed in them.

const schema = z.object({ reason: z.string().trim().min(3, "Enter why the check-in is being undone.").max(500) });

class UndoCheckInError extends Error {}

async function routePOST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Undo check-in needs the PMS database." }, { status: 503 });
    const { reservationId } = await context.params;
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "Reservation not found." }, { status: 404 });
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Enter a reason." }, { status: 400 });
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; status: string; version: number }>>`
        select id, status, version from reservations where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) throw new UndoCheckInError("Reservation not found.");
      if (reservation.status !== "checked_in") throw new UndoCheckInError("Only an in-house reservation can have its check-in undone.");
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      const rooms = await tx<Array<{ id: string; number: string | null; checkedInDate: string | null }>>`
        select rr.id, ro.number, (rr.checked_in_at at time zone p.timezone)::date::text as "checkedInDate"
        from reservation_rooms rr left join rooms ro on ro.id=rr.room_id join properties p on p.id=rr.property_id
        where rr.reservation_id=${reservation.id}::uuid and rr.property_id=${session.propertyId}::uuid and rr.status='checked_in'
        for update of rr
      `;
      if (!rooms.length) throw new UndoCheckInError("No room of this reservation is checked in.");
      // A night that has been audited happened; only today's check-in can be undone.
      if (rooms.some((room) => room.checkedInDate && room.checkedInDate < businessDate)) {
        throw new UndoCheckInError(`This guest checked in before business day ${businessDate}, and that night is already audited. Use Check Out (and Room Move or Rates to correct) instead.`);
      }
      await tx`update reservation_rooms set status='reserved', checked_in_at=null, updated_at=now() where id in ${tx(rooms.map((room) => room.id))}`;
      await tx`update reservations set status='reserved', version=version+1, updated_at=now() where id=${reservation.id}::uuid`;
      await logReservationActivity(tx, session, reservation.id, "Status", `Check-in undone · Room ${rooms.map((room) => room.number ?? "unassigned").join(", ")} · ${parsed.data.reason}`);
      return { status: "Reserved", version: reservation.version + 1 };
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof UndoCheckInError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const POST = withRequestContext(routePOST);
