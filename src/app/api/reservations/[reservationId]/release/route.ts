import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { allocateProductionDocumentNumber, postProductionLedger } from "@/server/finance/production-finance";

const releaseSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["no-show", "cancel"]),
  feeCents: z.number().int().min(0).max(10_000_000).default(0),
  note: z.string().trim().max(2_000).optional(),
});

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

function addReleaseMetadata(notes: string | null, event: Record<string, unknown>) {
  try {
    const parsed = notes ? JSON.parse(notes) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const current = parsed as Record<string, unknown>;
    const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
    return JSON.stringify({ ...current, lifecycleEvents: [...events, event].slice(-20) });
  } catch {
    const note = typeof event.note === "string" && event.note ? ` ${event.note}` : "";
    return `${notes?.trim() ?? ""}${notes?.trim() ? "\n" : ""}${event.action} on ${event.at}.${note}`;
  }
}

/**
 * Release a reserved stay as a cancellation or no-show. This is deliberately
 * separate from a general reservation status PATCH: voiding booked room rent,
 * reversing revenue, posting an optional fee, and freeing inventory must all
 * succeed or fail together.
 */
export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Reservation release requires the PMS database." }, { status: 503 });
    const parsed = releaseSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Cancellation or no-show details are invalid." }, { status: 400 });
    const reservationId = await routeParams(context);
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; version: number; status: string; notes: string | null }>>`
        select id,version,status,notes from reservations
        where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid
        for update
      `;
      if (!reservation) return { error: "Reservation not found.", httpStatus: 404 } as const;
      if (reservation.version !== input.expectedVersion) {
        return { error: "Another employee changed this reservation. Review the latest version before saving.", httpStatus: 409, code: "EDIT_CONFLICT", currentVersion: reservation.version } as const;
      }
      if (reservation.status !== "reserved") return { error: "Only a reserved stay can be cancelled or marked No Show.", httpStatus: 409 } as const;

      const rooms = await tx<Array<{ id: string }>>`
        select id from reservation_rooms
        where reservation_id=${reservation.id}::uuid and property_id=${session.propertyId}::uuid
        for update
      `;
      if (!rooms.length) return { error: "The reservation has no rooms to release.", httpStatus: 409 } as const;
      const roomRentCharges = await tx<Array<{ id: string; serviceDate: string; amountCents: number; taxCents: number }>>`
        select c.id,c.service_date::text as "serviceDate",c.amount_cents as "amountCents",
          coalesce(ct.amount_cents,0)::int as "taxCents"
        from charges c
        join folios f on f.id=c.folio_id
        left join charge_taxes ct on ct.charge_id=c.id
        where f.reservation_id=${reservation.id}::uuid and c.property_id=${session.propertyId}::uuid
          and c.type='Room Rent' and c.status='posted'
        for update of c
      `;
      const nightlyRates = await tx<Array<{ reservationRoomId: string; stayDate: string; baseRateCents: number; discountCents: number; finalRateCents: number }>>`
        select reservation_room_id as "reservationRoomId",stay_date::text as "stayDate",
          base_rate_cents as "baseRateCents",discount_cents as "discountCents",final_rate_cents as "finalRateCents"
        from nightly_rates
        where property_id=${session.propertyId}::uuid
          and reservation_room_id in ${tx(rooms.map((room) => room.id))}
        for update
      `;
      const [businessDay] = await tx<Array<{ date: string }>>`
        select business_date::text as date from business_days
        where property_id=${session.propertyId}::uuid order by business_date desc limit 1
      `;
      const businessDate = businessDay?.date ?? new Date().toISOString().slice(0, 10);
      const status = input.action === "no-show" ? "no_show" : "cancelled";
      const label = input.action === "no-show" ? "No-show" : "Cancellation";

      // The original charges stay in the audit trail but stop affecting the
      // folio. Matching ledger reversals preserve the financial history.
      if (roomRentCharges.length) {
        await tx`
          update charges set status='voided',updated_at=now()
          where id in ${tx(roomRentCharges.map((charge) => charge.id))} and property_id=${session.propertyId}::uuid
        `;
      }
      for (const charge of roomRentCharges) {
        if (charge.amountCents > 0) await postProductionLedger(tx, {
          propertyId: session.propertyId,
          businessDate,
          resourceType: "reservation-release",
          resourceId: reservation.id,
          description: `${label} room-rent reversal · ${charge.serviceDate}`,
          debitAccount: "Room Revenue",
          creditAccount: "Guest Receivable",
          amountCents: charge.amountCents,
        });
        if (charge.taxCents > 0) await postProductionLedger(tx, {
          propertyId: session.propertyId,
          businessDate,
          resourceType: "reservation-release-tax",
          resourceId: reservation.id,
          description: `${label} room-tax reversal · ${charge.serviceDate}`,
          debitAccount: "Tax Payable",
          creditAccount: "Guest Receivable",
          amountCents: charge.taxCents,
        });
      }
      await tx`
        delete from nightly_rates
        where property_id=${session.propertyId}::uuid and reservation_room_id in ${tx(rooms.map((room) => room.id))}
      `;

      let feeChargeId: string | undefined;
      if (input.feeCents > 0) {
        let [folio] = await tx<Array<{ id: string }>>`
          select id from folios where reservation_id=${reservation.id}::uuid
          and property_id=${session.propertyId}::uuid order by created_at limit 1 for update
        `;
        if (!folio && rooms[0]) {
          const number = await allocateProductionDocumentNumber(tx, session.propertyId);
          [folio] = await tx<Array<{ id: string }>>`
            insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
            values (${session.propertyId}::uuid,${reservation.id}::uuid,${rooms[0].id}::uuid,${number},'Room & Tax Folio','open')
            returning id
          `;
        }
        if (!folio) return { error: "The reservation has no folio for the requested fee.", httpStatus: 409 } as const;
        const [fee] = await tx<Array<{ id: string }>>`
          insert into charges (property_id,folio_id,reservation_room_id,type,description,service_date,amount_cents,taxable,status)
          values (${session.propertyId}::uuid,${folio.id}::uuid,${rooms[0]?.id ?? null}::uuid,${label + ' Fee'},${label + ' fee'},${businessDate}::date,${input.feeCents},false,'posted')
          returning id
        `;
        feeChargeId = fee.id;
        await postProductionLedger(tx, {
          propertyId: session.propertyId,
          businessDate,
          resourceType: "reservation-release-fee",
          resourceId: fee.id,
          description: `${label} fee`,
          debitAccount: "Guest Receivable",
          creditAccount: "Revenue:Cancellation Fees",
          amountCents: input.feeCents,
        });
      }

      await tx`
        update reservation_rooms set status=${status},updated_at=now()
        where reservation_id=${reservation.id}::uuid and property_id=${session.propertyId}::uuid
      `;
      const releasedAt = new Date().toISOString();
      await tx`
        update reservations set status=${status},notes=${addReleaseMetadata(reservation.notes, { action: input.action, feeCents: input.feeCents, note: input.note, roomRentCharges, nightlyRates, at: releasedAt })},version=version+1,updated_at=now()
        where id=${reservation.id}::uuid and property_id=${session.propertyId}::uuid
      `;
      await tx`
        insert into change_events (property_id,actor_auth_user_id,entity_type,entity_id,action,entity_version,payload)
        values (${session.propertyId}::uuid,${session.authUserId}::uuid,'reservation',${reservation.id}::uuid,${status},${reservation.version + 1},${tx.json({ action: input.action, feeCents: input.feeCents })})
      `;
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=${reservation.id}::uuid),0)
        )::int as "balanceCents"
      `;
      return { status: input.action === "no-show" ? "No Show" : "Cancelled", balanceCents: balance?.balanceCents ?? input.feeCents, feeChargeId, version: reservation.version + 1 } as const;
    });
    if ("error" in result) return Response.json(result, { status: result.httpStatus });
    return Response.json(result);
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
