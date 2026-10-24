import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";
import { setReservationCommission } from "@/server/finance/ota-commission";

const reinstateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(2_000).optional(),
});

type ReleasedCharge = { id: string; serviceDate: string; amountCents: number; taxCents: number };
type ReleasedNightlyRate = { reservationRoomId: string; stayDate: string; baseRateCents: number; discountCents: number; finalRateCents: number };
type LifecycleEvent = { action?: string; roomRentCharges?: ReleasedCharge[]; nightlyRates?: ReleasedNightlyRate[]; commissionCents?: number };

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

function priorRelease(notes: string | null) {
  try {
    const parsed = notes ? JSON.parse(notes) as { lifecycleEvents?: unknown } : {};
    const events = Array.isArray(parsed.lifecycleEvents) ? parsed.lifecycleEvents as LifecycleEvent[] : [];
    return [...events].reverse().find((event) => event?.action === "no-show" || event?.action === "cancel");
  } catch {
    return undefined;
  }
}

function addReinstatementMetadata(notes: string | null, note?: string) {
  try {
    const parsed = notes ? JSON.parse(notes) as Record<string, unknown> : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const events = Array.isArray(parsed.lifecycleEvents) ? parsed.lifecycleEvents : [];
    return JSON.stringify({ ...parsed, lifecycleEvents: [...events, { action: "reinstated", note, at: new Date().toISOString() }].slice(-20) });
  } catch {
    return `${notes?.trim() ?? ""}${notes?.trim() ? "\n" : ""}reinstated${note ? `: ${note}` : ""}`;
  }
}

/** Restore a released reserved stay with its original rent/tax audit trail. */
export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Reservation reinstatement requires the PMS database." }, { status: 503 });
    const parsed = reinstateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Reinstatement details are invalid." }, { status: 400 });
    const reservationId = await routeParams(context);
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; version: number; status: string; notes: string | null; arrivalDate: string; departureDate: string }>>`
        select id,version,status,notes,arrival_date::text as "arrivalDate",departure_date::text as "departureDate"
        from reservations where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) return { error: "Reservation not found.", httpStatus: 404 } as const;
      if (reservation.version !== parsed.data.expectedVersion) return { error: "Another employee changed this reservation. Review the latest version before saving.", httpStatus: 409 } as const;
      if (reservation.status !== "no_show" && reservation.status !== "cancelled") return { error: "Only cancelled or no-show stays can be reinstated.", httpStatus: 409 } as const;
      const release = priorRelease(reservation.notes);
      // A zero-rate or same-day reservation can legitimately have no posted
      // room-rent charge. Its durable nightly-rate history is still enough to
      // restore inventory safely; non-zero charges are restored when present.
      if (!release?.nightlyRates?.length) return { error: "This older released reservation does not have enough pricing history to reinstate safely.", httpStatus: 409 } as const;

      // Rooms may be unassigned (FR-RES-001), so inventory is checked per room
      // type and assigned rooms are additionally checked individually.
      const rooms = await tx<Array<{ id: string; roomTypeId: string; roomId: string | null; number: string | null; serviceStatus: string | null }>>`
        select rr.id,rr.room_type_id as "roomTypeId",r.id as "roomId",r.number,r.service_status as "serviceStatus"
        from reservation_rooms rr left join rooms r on r.id=rr.room_id
        where rr.reservation_id=${reservation.id}::uuid and rr.property_id=${session.propertyId}::uuid
        for update of rr
      `;
      if (!rooms.length) return { error: "The reservation has no rooms to reinstate.", httpStatus: 409 } as const;
      const assignedRooms = rooms.filter((room) => room.roomId);
      if (assignedRooms.some((room) => room.serviceStatus !== "rentable")) return { error: "A previously assigned room is no longer rentable.", httpStatus: 409 } as const;
      if (assignedRooms.length) {
        const conflicts = await tx<Array<{ roomId: string }>>`
          select distinct rr.room_id as "roomId"
          from reservation_rooms rr join reservations other on other.id=rr.reservation_id
          where rr.property_id=${session.propertyId}::uuid and rr.room_id in ${tx(assignedRooms.map((room) => room.roomId!))}
            and rr.status in ('reserved','checked_in') and other.status in ('reserved','checked_in')
            and other.id<>${reservation.id}::uuid
            and other.arrival_date<${reservation.departureDate}::date and other.departure_date>${reservation.arrivalDate}::date
        `;
        if (conflicts.length) return { error: "A previously assigned room is no longer available for these dates.", httpStatus: 409 } as const;
      }
      const neededByType = new Map<string, number>();
      rooms.forEach((room) => neededByType.set(room.roomTypeId, (neededByType.get(room.roomTypeId) ?? 0) + 1));
      for (const [roomTypeId, needed] of neededByType) {
        const [inventory] = await tx<Array<{ rentable: number; booked: number }>>`
          select
            (select count(*) from rooms where property_id=${session.propertyId}::uuid and room_type_id=${roomTypeId}::uuid and service_status='rentable')::int as rentable,
            (select count(*) from reservation_rooms rr join reservations other on other.id=rr.reservation_id
              where rr.property_id=${session.propertyId}::uuid and rr.room_type_id=${roomTypeId}::uuid
                and rr.status in ('reserved','checked_in') and other.status in ('reserved','checked_in') and other.id<>${reservation.id}::uuid
                and other.arrival_date<${reservation.departureDate}::date and other.departure_date>${reservation.arrivalDate}::date)::int as booked
        `;
        if (inventory.rentable - inventory.booked < needed) return { error: "That room type no longer has enough inventory for these dates.", httpStatus: 409 } as const;
      }

      const chargeIds = release.roomRentCharges ?? [];
      const chargeIdValues = chargeIds.map((charge) => charge.id);
      const existingCharges = chargeIdValues.length
        ? await tx<Array<{ id: string }>>`
          select id from charges where property_id=${session.propertyId}::uuid
            and id in ${tx(chargeIdValues)} and status='voided' for update
        `
        : [];
      if (existingCharges.length !== chargeIdValues.length) return { error: "The original room-rent audit trail has changed and cannot be reinstated automatically.", httpStatus: 409 } as const;
      if (chargeIdValues.length) await tx`update charges set status='posted',updated_at=now() where property_id=${session.propertyId}::uuid and id in ${tx(chargeIdValues)}`;
      for (const charge of chargeIds) {
        if (charge.amountCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: new Date().toISOString().slice(0, 10), resourceType: "reservation-reinstatement", resourceId: reservation.id, description: `Reinstated room rent · ${charge.serviceDate}`, debitAccount: "Guest Receivable", creditAccount: "Room Revenue", amountCents: charge.amountCents });
        if (charge.taxCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: new Date().toISOString().slice(0, 10), resourceType: "reservation-reinstatement-tax", resourceId: reservation.id, description: `Reinstated room tax · ${charge.serviceDate}`, debitAccount: "Guest Receivable", creditAccount: "Tax Payable", amountCents: charge.taxCents });
      }
      for (const rate of release.nightlyRates) {
        await tx`
          insert into nightly_rates (property_id,reservation_room_id,stay_date,base_rate_cents,discount_cents,final_rate_cents)
          values (${session.propertyId}::uuid,${rate.reservationRoomId}::uuid,${rate.stayDate}::date,${rate.baseRateCents},${rate.discountCents},${rate.finalRateCents})
          on conflict (reservation_room_id,stay_date) do update set base_rate_cents=excluded.base_rate_cents,discount_cents=excluded.discount_cents,final_rate_cents=excluded.final_rate_cents
        `;
      }
      await tx`update reservation_rooms set status='reserved',updated_at=now() where reservation_id=${reservation.id}::uuid and property_id=${session.propertyId}::uuid`;
      if (release.commissionCents && release.commissionCents > 0) {
        await setReservationCommission(tx, { propertyId: session.propertyId, reservationId: reservation.id, targetCents: release.commissionCents, businessDate: new Date().toISOString().slice(0, 10), reason: "Reinstated commission" });
      }
      await tx`update reservations set status='reserved',notes=${addReinstatementMetadata(reservation.notes, parsed.data.note)} ,version=version+1,updated_at=now() where id=${reservation.id}::uuid`;
      await tx`insert into change_events (property_id,actor_auth_user_id,entity_type,entity_id,action,entity_version,payload) values (${session.propertyId}::uuid,${session.authUserId}::uuid,'reservation',${reservation.id}::uuid,'updated',${reservation.version + 1},${tx.json({ changes: { status: "Reserved" } })})`;
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)-coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=${reservation.id}::uuid),0))::int as "balanceCents"
      `;
      return { status: "Reserved", balanceCents: balance?.balanceCents ?? 0, version: reservation.version + 1 } as const;
    });
    if ("error" in result) return Response.json(result, { status: result.httpStatus });
    return Response.json(result);
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
