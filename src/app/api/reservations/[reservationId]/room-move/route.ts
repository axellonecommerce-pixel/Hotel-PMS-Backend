import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";

const requestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  destinationRoomNumber: z.string().trim().min(1).max(80),
  remark: z.string().trim().min(1).max(2_000),
  rateDecision: z.enum(["keep", "change"]),
  // A group can move any one of its rooms; defaults to the first active room.
  reservationRoomId: z.string().uuid().optional(),
});

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

      const [reservationRoom] = await tx<Array<{ id: string; roomId: string | null; roomNumber: string | null; status: string }>>`
        select rr.id,rr.room_id as "roomId",r.number as "roomNumber",rr.status
        from reservation_rooms rr left join rooms r on r.id=rr.room_id
        where rr.reservation_id=${reservation.id}::uuid and rr.property_id=${session.propertyId}::uuid
          and rr.status in ('reserved','checked_in')
          and (${input.data.reservationRoomId ?? null}::uuid is null or rr.id=${input.data.reservationRoomId ?? null}::uuid)
        order by rr.created_at limit 1 for update of rr
      `;
      if (!reservationRoom) return { error: "This reservation has no active room to move.", status: 409 } as const;
      if (reservationRoom.roomNumber === input.data.destinationRoomNumber) return { error: "Choose a different destination room.", status: 400 } as const;

      const [destination] = await tx<Array<{ id: string; number: string; roomTypeId: string; baseRateCents: number; cleanliness: string; service: string }>>`
        select r.id,r.number,r.room_type_id as "roomTypeId",rt.base_rate_cents as "baseRateCents",r.cleanliness_status as cleanliness,r.service_status as service
        from rooms r join room_types rt on rt.id=r.room_type_id
        where r.property_id=${session.propertyId}::uuid and r.number=${input.data.destinationRoomNumber} for update
      `;
      if (!destination || destination.service !== "rentable") return { error: "This destination room is non-rentable.", status: 409 } as const;
      // Only stays that overlap this one make the destination unavailable.
      const [occupied] = await tx<Array<{ id: string }>>`
        select rr.id from reservation_rooms rr join reservations r on r.id=rr.reservation_id
        where rr.property_id=${session.propertyId}::uuid and rr.room_id=${destination.id}::uuid and rr.id<>${reservationRoom.id}::uuid
          and rr.status in ('reserved','checked_in') and r.status in ('reserved','checked_in')
          and r.arrival_date<${reservation.departureDate}::date and r.departure_date>${reservation.arrivalDate}::date
        limit 1 for update of rr
      `;
      if (occupied) return { error: "The destination room is already booked for these dates.", status: 409 } as const;
      const [blocked] = await tx<Array<{ id: string }>>`
        select id from maintenance_orders
        where room_id=${destination.id}::uuid and rentable=false and status not in ('resolved','cancelled')
          and case when notes like '{%' then (notes::jsonb->>'blockFrom')::date end < ${reservation.departureDate}::date
          and case when notes like '{%' then (notes::jsonb->>'blockTo')::date end >= ${reservation.arrivalDate}::date
        limit 1
      `;
      if (blocked) return { error: "The destination room is blocked for maintenance during this stay.", status: 409 } as const;

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
      if (input.data.rateDecision === "change") {
        const [businessDay] = await tx<Array<{ date: string }>>`
          select business_date::text as date from business_days
          where property_id=${session.propertyId}::uuid order by business_date desc limit 1
        `;
        const effectiveDate = businessDay?.date ?? new Date().toISOString().slice(0, 10);
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
          update nightly_rates set base_rate_cents=${destination.baseRateCents},discount_cents=0,final_rate_cents=${destination.baseRateCents}
          where reservation_room_id=${reservationRoom.id}::uuid and stay_date>=${effectiveDate}::date
        `;
        await tx`
          update charges set amount_cents=${destination.baseRateCents}
          where reservation_room_id=${reservationRoom.id}::uuid and type='Room Rent' and service_date>=${effectiveDate}::date and status='posted'
        `;
        if (!reservation.taxExempt) {
          await tx`
            update charge_taxes ct set amount_cents=round(${destination.baseRateCents} * ct.rate_basis_points / 10000.0)::int
            from charges c
            where ct.charge_id=c.id and c.reservation_room_id=${reservationRoom.id}::uuid
              and c.type='Room Rent' and c.service_date>=${effectiveDate}::date and c.status='posted'
          `;
        }
        for (const charge of affectedCharges) {
          const roomRentDifference = destination.baseRateCents - charge.amountCents;
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
            const nextTaxCents = Math.round(destination.baseRateCents * reservation.taxRateBasisPoints / 10_000);
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
      }
      // Assigning a room to an unassigned booking is not a move; a move from
      // a room the guest never occupied must not make that room dirty.
      if (reservationRoom.roomId) {
        await tx`
          insert into room_moves (property_id,reservation_room_id,from_room_id,to_room_id,rate_decision,remark,moved_by_employee_id)
          values (${session.propertyId}::uuid,${reservationRoom.id}::uuid,${reservationRoom.roomId}::uuid,${destination.id}::uuid,${input.data.rateDecision},${input.data.remark},${employee?.id ?? null}::uuid)
        `;
        if (reservationRoom.status === "checked_in") await tx`
          update rooms set cleanliness_status='dirty',updated_at=now()
          where id=${reservationRoom.roomId}::uuid and property_id=${session.propertyId}::uuid
        `;
      }
      await tx`update reservations set version=version+1,updated_at=now() where id=${reservation.id}::uuid`;
      const [totals] = await tx<Array<{ roomRentCents: number; taxCents: number; totalCents: number; paidCents: number }>>`
        select
          coalesce((select sum(nr.final_rate_cents) from nightly_rates nr join reservation_rooms rr on rr.id=nr.reservation_room_id where rr.reservation_id=${reservation.id}::uuid),0)::int as "roomRentCents",
          coalesce((select sum(ct.amount_cents) from charge_taxes ct join charges c on c.id=ct.charge_id join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)::int as "taxCents",
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)::int as "totalCents",
          coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=${reservation.id}::uuid),0)::int as "paidCents"
      `;
      return { room: destination.number, roomTypeId: destination.roomTypeId, destinationDirty: destination.cleanliness !== "clean", roomRentCents: totals.roomRentCents, taxCents: totals.taxCents, totalCents: totals.totalCents, balanceCents: totals.totalCents - totals.paidCents, fromRoomDirty: reservationRoom.status === "checked_in" && Boolean(reservationRoom.roomId), version: reservation.version + 1 } as const;
    });
    if ("error" in result) return Response.json(result, { status: result.status });
    return Response.json(result);
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
