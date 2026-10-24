import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { DIRECT_BILL_METHOD } from "@/server/finance/direct-bill";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { logReservationActivity } from "@/server/activity/reservation-activity";
import { recordChange } from "@/server/realtime/change-events";

const undoSchema = z.object({ reason: z.string().trim().min(3).max(500) });

class UndoCheckoutError extends Error {}

/**
 * HotelKey "Undo a Check-Out": a stay checked out by mistake returns to In
 * House on the same business day, provided its rooms are still free. A company
 * stay's direct bill transfer and draft invoice are removed; an invoice that
 * was already sent or paid must be handled in Companies instead.
 */
export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const { reservationId } = await context.params;
    const parsed = undoSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Enter a reason for undoing the checkout." }, { status: 400 });
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; status: string; notes: string | null; checkedOutDate: string | null }>>`
        select r.id, r.status, r.notes,
          (select to_char(max(rr.checked_out_at at time zone p.timezone),'YYYY-MM-DD') from reservation_rooms rr join properties p on p.id=r.property_id where rr.reservation_id=r.id) as "checkedOutDate"
        from reservations r where r.id=${reservationId}::uuid and r.property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) throw new UndoCheckoutError("Reservation not found.");
      if (reservation.status !== "checked_out") throw new UndoCheckoutError("Only a checked-out reservation can be returned to In House.");
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      if (reservation.checkedOutDate !== businessDate) throw new UndoCheckoutError("A checkout can only be undone on the business day it happened.");

      const rooms = await tx<Array<{ id: string; roomId: string | null; number: string | null }>>`
        select rr.id, rr.room_id as "roomId", room.number from reservation_rooms rr left join rooms room on room.id=rr.room_id
        where rr.reservation_id=${reservation.id}::uuid and rr.status='checked_out' for update of rr
      `;
      for (const room of rooms) {
        if (!room.roomId) continue;
        const [taken] = await tx<Array<{ id: string }>>`
          select other.id from reservation_rooms other_rr join reservations other on other.id=other_rr.reservation_id
          where other_rr.room_id=${room.roomId}::uuid and other.id<>${reservation.id}::uuid and other_rr.status='checked_in' limit 1
        `;
        if (taken) throw new UndoCheckoutError(`Room ${room.number} already has another guest checked in.`);
      }

      const [invoice] = await tx<Array<{ id: string; status: string; paidCents: number }>>`
        select i.id, i.status, coalesce((select sum(ipa.amount_cents) from invoice_payment_allocations ipa where ipa.invoice_id=i.id),0)::int as "paidCents"
        from invoices i where i.reservation_id=${reservation.id}::uuid for update
      `;
      if (invoice && (invoice.status !== "draft" || invoice.paidCents > 0)) {
        throw new UndoCheckoutError("The company invoice for this stay was already sent or paid. Void or adjust it in Companies first.");
      }
      if (invoice) {
        await tx`delete from invoice_lines where invoice_id=${invoice.id}::uuid`;
        await tx`delete from invoices where id=${invoice.id}::uuid`;
      }
      // The balance returns to the folio until the stay checks out again.
      await tx`delete from payment_allocations where payment_id in (select id from payments where reservation_id=${reservation.id}::uuid and method=${DIRECT_BILL_METHOD})`;
      await tx`delete from payments where reservation_id=${reservation.id}::uuid and method=${DIRECT_BILL_METHOD}`;

      await tx`update reservation_rooms set status='checked_in', checked_out_at=null, updated_at=now() where id in ${tx(rooms.map((room) => room.id))}`;
      const event = { action: "checkout-undone", reason: parsed.data.reason, at: new Date().toISOString() };
      let notes: string;
      try {
        const current = reservation.notes ? JSON.parse(reservation.notes) as Record<string, unknown> : {};
        const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
        notes = JSON.stringify({ ...current, lifecycleEvents: [...events, event].slice(-20) });
      } catch {
        notes = `${reservation.notes ?? ""}\ncheckout undone: ${parsed.data.reason}`.trim();
      }
      await tx`update reservations set status='checked_in', notes=${notes}, version=version+1, updated_at=now() where id=${reservation.id}::uuid`;
      await logReservationActivity(tx, session, reservation.id, "Status", `Checkout undone · back In House${invoice ? " · company invoice draft removed" : ""} · Reason: ${parsed.data.reason}`);
      return { reservationId: reservation.id, rooms: rooms.map((room) => room.number).filter(Boolean) };
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: result.reservationId, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: { change: "checkout-undone" } });
    return Response.json(result);
  } catch (error) {
    if (error instanceof UndoCheckoutError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
