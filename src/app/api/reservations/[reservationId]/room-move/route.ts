import type { TransactionSql } from "postgres";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { readReservationCommission, setReservationCommission } from "@/server/finance/ota-commission";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";

type Tx = TransactionSql<Record<string, never>>;

/** A room that cannot be used; undoes every move in the request. */
class MoveError extends Error {}

async function reservationRentCents(tx: Tx, reservationId: string) {
  const [row] = await tx<Array<{ cents: number }>>`
    select coalesce(sum(c.amount_cents),0)::int as cents from charges c join reservation_rooms rr on rr.id=c.reservation_room_id
    where rr.reservation_id=${reservationId}::uuid and c.type='Room Rent' and c.status='posted'
  `;
  return row.cents;
}

// One room of the stay: a new room number and/or the guest staying in it
// (null clears the guest). Several are applied together, so a group's rooms
// can be assigned, moved or swapped in one go.
const moveSchema = z.object({
  reservationRoomId: z.string().uuid(),
  destinationRoomNumber: z.string().trim().min(1).max(80).optional(),
  guestId: z.string().uuid().nullable().optional(),
});

const requestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  destinationRoomNumber: z.string().trim().min(1).max(80).optional(),
  moves: z.array(moveSchema).min(1).max(50).optional(),
  // Required for an in-house move; optional when changing an arrival's room.
  remark: z.string().trim().max(2_000).default(""),
  // keep: current rate; change: destination room type's rate; custom: a
  // nightly rate the front desk enters for the remaining nights.
  rateDecision: z.enum(["keep", "change", "custom"]),
  newRateCents: z.number().int().nonnegative().max(10_000_000).optional(),
  // A group can move any one of its rooms; defaults to the first active room.
  reservationRoomId: z.string().uuid().optional(),
}).refine((value) => value.rateDecision !== "custom" || value.newRateCents !== undefined, { message: "Enter the new nightly rate." })
  .refine((value) => value.moves?.length || value.destinationRoomNumber, { message: "Choose a room." });

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Room moves require the PMS database." }, { status: 503 });
    const input = requestSchema.safeParse(await request.json());
    if (!input.success) return Response.json({ error: "Room move details are invalid." }, { status: 400 });
    const reservationId = await routeParams(context);
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; version: number; status: string; taxExempt: boolean; taxRateBasisPoints: number; arrivalDate: string; departureDate: string }>>`
        select id,version,status,tax_exempt as "taxExempt",tax_rate_basis_points as "taxRateBasisPoints",
          arrival_date::text as "arrivalDate",departure_date::text as "departureDate" from reservations
        where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) return { error: "Reservation not found.", status: 404 } as const;
      if (reservation.version !== input.data.expectedVersion) return { error: "Another employee changed this reservation. Review the latest version before moving the room.", status: 409, code: "EDIT_CONFLICT", currentVersion: reservation.version } as const;
      if (reservation.status !== "reserved" && reservation.status !== "checked_in") return { error: "Only an arriving or in-house guest can be moved.", status: 409 } as const;

      const activeRooms = await tx<Array<{ id: string; roomId: string | null; roomNumber: string | null; status: string }>>`
        select rr.id,rr.room_id as "roomId",r.number as "roomNumber",rr.status
        from reservation_rooms rr left join rooms r on r.id=rr.room_id
        where rr.reservation_id=${reservation.id}::uuid and rr.property_id=${session.propertyId}::uuid
          and rr.status in ('reserved','checked_in')
        order by rr.created_at for update of rr
      `;
      if (!activeRooms.length) return { error: "This reservation has no active room to move.", status: 409 } as const;
      const requested = input.data.moves ?? [{
        reservationRoomId: input.data.reservationRoomId ?? activeRooms[0].id,
        destinationRoomNumber: input.data.destinationRoomNumber,
        guestId: undefined,
      }];
      if (new Set(requested.map((move) => move.reservationRoomId)).size !== requested.length) return { error: "Each room can be changed only once at a time.", status: 400 } as const;
      const destinations = requested.map((move) => move.destinationRoomNumber).filter(Boolean);
      if (new Set(destinations).size !== destinations.length) return { error: "Two rooms of this stay cannot go to the same room.", status: 400 } as const;
      for (const move of requested) if (!activeRooms.some((room) => room.id === move.reservationRoomId)) return { error: "A room of this reservation was not found or is already checked out.", status: 409 } as const;
      const roomMoves = requested.flatMap((move) => {
        const current = activeRooms.find((room) => room.id === move.reservationRoomId)!;
        return move.destinationRoomNumber && move.destinationRoomNumber !== current.roomNumber ? [{ reservationRoom: current, destinationRoomNumber: move.destinationRoomNumber }] : [];
      });
      if (!roomMoves.length && requested.every((move) => move.guestId === undefined)) return { error: "Choose a different destination room.", status: 400 } as const;
      if (roomMoves.some((move) => move.reservationRoom.status === "checked_in") && !input.data.remark) return { error: "Enter a room move remark.", status: 400 } as const;
      // Free every room that is moving first, so rooms of this stay can swap.
      if (roomMoves.length) await tx`update reservation_rooms set room_id=null where id in ${tx(roomMoves.map((move) => move.reservationRoom.id))}`;
      const moved: Array<{ reservationRoomId: string; room: string; roomTypeId: string; fromRoomDirty: boolean; destinationDirty: boolean }> = [];
      for (const { reservationRoom, destinationRoomNumber } of roomMoves) {
        const inHouse = reservationRoom.status === "checked_in";

        const [destination] = await tx<Array<{ id: string; number: string; roomTypeId: string; baseRateCents: number; cleanliness: string; service: string }>>`
          select r.id,r.number,r.room_type_id as "roomTypeId",rt.base_rate_cents as "baseRateCents",r.cleanliness_status as cleanliness,r.service_status as service
          from rooms r join room_types rt on rt.id=r.room_type_id
          where r.property_id=${session.propertyId}::uuid and r.number=${destinationRoomNumber} for update
        `;
        if (!destination || destination.service !== "rentable") throw new MoveError(`Room ${destinationRoomNumber} is non-rentable.`);
        // Only stays that overlap this one make the destination unavailable.
        const [occupied] = await tx<Array<{ id: string }>>`
          select rr.id from reservation_rooms rr join reservations r on r.id=rr.reservation_id
          where rr.property_id=${session.propertyId}::uuid and rr.room_id=${destination.id}::uuid and rr.id<>${reservationRoom.id}::uuid
            and rr.status in ('reserved','checked_in') and r.status in ('reserved','checked_in')
            and r.arrival_date<greatest(${reservation.departureDate}::date, ${reservation.arrivalDate}::date + 1) and greatest(r.departure_date, r.arrival_date + 1)>${reservation.arrivalDate}::date
          limit 1 for update of rr
        `;
        if (occupied) throw new MoveError(`Room ${destination.number} is already booked for these dates.`);
        const [blocked] = await tx<Array<{ id: string }>>`
          select id from maintenance_orders
          where room_id=${destination.id}::uuid and rentable=false and status not in ('resolved','cancelled')
            and case when notes like '{%' then (notes::jsonb->>'blockFrom')::date end < ${reservation.departureDate}::date
            and case when notes like '{%' then (notes::jsonb->>'blockTo')::date end >= ${reservation.arrivalDate}::date
          limit 1
        `;
        if (blocked) throw new MoveError(`Room ${destination.number} is blocked for maintenance during this stay.`);

        const [employee] = await tx<Array<{ id: string }>>`
          select id from employees where property_id=${session.propertyId}::uuid
            and membership_id in (select id from property_memberships where auth_user_id=${session.authUserId}::uuid and property_id=${session.propertyId}::uuid)
          limit 1
        `;
        await tx`
          update reservation_rooms set room_id=${destination.id}::uuid,room_type_id=${destination.roomTypeId}::uuid,updated_at=now()
          where id=${reservationRoom.id}::uuid
        `;

        // A move never rewrites a consumed night. Choosing the destination
        // room's rate changes only the open business day and future nights,
        // updating the matching Room Rent and tax postings in the same
        // transaction as the physical room change.
        if (input.data.rateDecision !== "keep") {
          const effectiveDate = await propertyBusinessDate(tx, session.propertyId);
          const newRateCents = input.data.rateDecision === "custom" ? input.data.newRateCents! : destination.baseRateCents;
          const rentBeforeCents = await reservationRentCents(tx, reservation.id);
          // Capture the existing folio amounts before changing them. A room move
          // must adjust the accounting ledger by the same difference as the
          // visible charge, otherwise Revenue and the guest folio diverge.
          const affectedCharges = await tx<Array<{ id: string; serviceDate: string; amountCents: number; taxCents: number }>>`
            select c.id,c.service_date::text as "serviceDate",c.amount_cents as "amountCents",
              coalesce(ct.amount_cents,0)::int as "taxCents"
            from charges c
            left join charge_taxes ct on ct.charge_id=c.id
            where c.property_id=${session.propertyId}::uuid
              and c.reservation_room_id=${reservationRoom.id}::uuid
              and c.type='Room Rent' and c.service_date>=${effectiveDate}::date and c.status='posted'
            for update of c
          `;
          await tx`
            update nightly_rates set base_rate_cents=${newRateCents},discount_cents=0,final_rate_cents=${newRateCents}
            where reservation_room_id=${reservationRoom.id}::uuid and stay_date>=${effectiveDate}::date
          `;
          await tx`
            update charges set amount_cents=${newRateCents}
            where reservation_room_id=${reservationRoom.id}::uuid and type='Room Rent' and service_date>=${effectiveDate}::date and status='posted'
          `;
          if (!reservation.taxExempt) {
            await tx`
              update charge_taxes ct set amount_cents=round(${newRateCents} * ct.rate_basis_points / 10000.0)::int
              from charges c
              where ct.charge_id=c.id and c.reservation_room_id=${reservationRoom.id}::uuid
                and c.type='Room Rent' and c.service_date>=${effectiveDate}::date and c.status='posted'
            `;
          }
          for (const charge of affectedCharges) {
            const roomRentDifference = newRateCents - charge.amountCents;
            if (roomRentDifference !== 0) await postProductionLedger(tx, {
              propertyId: session.propertyId,
              businessDate: charge.serviceDate,
              resourceType: "room-move-rate-adjustment",
              resourceId: charge.id,
              description: `Room move rate adjustment · ${charge.serviceDate}`,
              debitAccount: roomRentDifference > 0 ? "Guest Receivable" : "Room Revenue",
              creditAccount: roomRentDifference > 0 ? "Room Revenue" : "Guest Receivable",
              amountCents: Math.abs(roomRentDifference),
            });
            if (!reservation.taxExempt) {
              const nextTaxCents = Math.round(newRateCents * reservation.taxRateBasisPoints / 10_000);
              const taxDifference = nextTaxCents - charge.taxCents;
              if (taxDifference !== 0) await postProductionLedger(tx, {
                propertyId: session.propertyId,
                businessDate: charge.serviceDate,
                resourceType: "room-move-tax-adjustment",
                resourceId: charge.id,
                description: `Room move tax adjustment · ${charge.serviceDate}`,
                debitAccount: taxDifference > 0 ? "Guest Receivable" : "Tax Payable",
                creditAccount: taxDifference > 0 ? "Tax Payable" : "Guest Receivable",
                amountCents: Math.abs(taxDifference),
              });
            }
          }
          // An OTA commission on unpaid rent follows the new room rent.
          const commission = await readReservationCommission(tx, session.propertyId, reservation.id);
          if (rentBeforeCents > 0 && commission.commissionCents > 0 && (commission.deducted || commission.paidCents === 0)) {
            await setReservationCommission(tx, {
              propertyId: session.propertyId, reservationId: reservation.id,
              targetCents: Math.round(commission.commissionCents * await reservationRentCents(tx, reservation.id) / rentBeforeCents),
              businessDate: effectiveDate, reason: "Room move rate change",
            });
          }
        }
        // Only an in-house guest physically moves. Assigning or changing the
        // room of an arrival is a booking change: no room-move record (Room
        // Move report) and the old room is not made dirty.
        if (reservationRoom.roomId && inHouse) {
          await tx`
            insert into room_moves (property_id,reservation_room_id,from_room_id,to_room_id,rate_decision,remark,moved_by_employee_id)
            values (${session.propertyId}::uuid,${reservationRoom.id}::uuid,${reservationRoom.roomId}::uuid,${destination.id}::uuid,${input.data.rateDecision},${input.data.remark},${employee?.id ?? null}::uuid)
          `;
          await tx`
            update rooms set cleanliness_status='dirty',updated_at=now()
            where id=${reservationRoom.roomId}::uuid and property_id=${session.propertyId}::uuid
          `;
        }
        const rateNote = input.data.rateDecision === "keep" ? "kept the existing rate" : input.data.rateDecision === "custom" ? `new rate ${money(input.data.newRateCents!)} per night` : `room type rate ${money(destination.baseRateCents)} per night`;
        const remarkNote = input.data.remark ? ` · ${input.data.remark}` : "";
        await logReservationActivity(tx, session, reservation.id, "Room", !reservationRoom.roomNumber
          ? `Room ${destination.number} assigned${remarkNote}`
          : inHouse
            ? `Room moved ${reservationRoom.roomNumber} → ${destination.number} · ${rateNote}${remarkNote}`
            : `Room changed ${reservationRoom.roomNumber} → ${destination.number} before arrival · ${rateNote}${remarkNote}`);
        moved.push({ reservationRoomId: reservationRoom.id, room: destination.number, roomTypeId: destination.roomTypeId, fromRoomDirty: inHouse && Boolean(reservationRoom.roomId), destinationDirty: destination.cleanliness !== "clean" });
      }
      // Guests staying in each room (the primary guest or an extra guest of this stay).
      for (const move of requested) {
        if (move.guestId === undefined) continue;
        const room = moved.find((item) => item.reservationRoomId === move.reservationRoomId)?.room ?? activeRooms.find((item) => item.id === move.reservationRoomId)?.roomNumber ?? "unassigned";
        await tx`update reservation_guests set reservation_room_id=null where reservation_id=${reservation.id}::uuid and reservation_room_id=${move.reservationRoomId}::uuid`;
        if (!move.guestId) continue;
        const [guest] = await tx<Array<{ name: string }>>`
          update reservation_guests rg set reservation_room_id=${move.reservationRoomId}::uuid
          from guests g where g.id=rg.guest_id and rg.reservation_id=${reservation.id}::uuid and rg.guest_id=${move.guestId}::uuid
          returning concat(g.first_name,' ',g.last_name) as name
        `;
        if (!guest) throw new MoveError("Add the guest to this reservation (Extra Guests) before assigning a room.");
        await logReservationActivity(tx, session, reservation.id, "Room", `Guest ${guest.name} assigned to Room ${room}`);
      }
      await tx`update reservations set version=version+1,updated_at=now() where id=${reservation.id}::uuid`;
      const [totals] = await tx<Array<{ roomRentCents: number; taxCents: number; totalCents: number; paidCents: number }>>`
        select
          coalesce((select sum(nr.final_rate_cents) from nightly_rates nr join reservation_rooms rr on rr.id=nr.reservation_room_id where rr.reservation_id=${reservation.id}::uuid),0)::int as "roomRentCents",
          coalesce((select sum(ct.amount_cents) from charge_taxes ct join charges c on c.id=ct.charge_id join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)::int as "taxCents",
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)::int as "totalCents",
          coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=${reservation.id}::uuid),0)::int as "paidCents"
      `;
      const first = moved[0];
      return { room: first?.room ?? activeRooms.find((room) => room.id === requested[0].reservationRoomId)?.roomNumber ?? "", roomTypeId: first?.roomTypeId, destinationDirty: first?.destinationDirty ?? false, fromRoomDirty: first?.fromRoomDirty ?? false, moved, roomRentCents: totals.roomRentCents, taxCents: totals.taxCents, totalCents: totals.totalCents, balanceCents: totals.totalCents - totals.paidCents, version: reservation.version + 1 } as const;
    });
    if ("error" in result) return Response.json(result, { status: result.status });
    return Response.json(result);
  } catch (error) {
    if (error instanceof MoveError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
