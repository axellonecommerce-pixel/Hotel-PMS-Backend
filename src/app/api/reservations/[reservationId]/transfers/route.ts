import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { recordChange } from "@/server/realtime/change-events";

// HotelKey "Transfer Charges / Transfer a Payment": move a posted charge, or
// part of a payment, to another folio on this stay or on another open stay.
// Revenue does not change, so no ledger entry is posted; every move is kept
// in folio_transfers as the audit trail.
const transferSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("charge"), chargeId: z.string().uuid(), toFolioId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }),
  z.object({ kind: z.literal("payment"), paymentId: z.string().uuid(), fromFolioId: z.string().uuid(), toFolioId: z.string().uuid(), amountCents: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }),
]);

class TransferError extends Error {}

type FolioRow = { id: string; reservationId: string; reservationRoomId: string | null; status: string; companyId: string | null; balanceCents: number };

const SYSTEM_METHODS = ["OTA COMMISSION", "DIRECT BILL", "BAD DEBT"];

export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const { reservationId } = await context.params;
    const transfers = await productionSql()<Array<{ id: string; kind: string; description: string; fromFolio: string; toFolio: string; amountCents: number; reason: string; businessDate: string }>>`
      select t.id, t.kind,
        coalesce(c.description, p.method || ' payment') as description,
        ff.number || ' · ' || fr.confirmation_number as "fromFolio", tf.number || ' · ' || tr.confirmation_number as "toFolio",
        t.amount_cents as "amountCents", t.reason, t.business_date::text as "businessDate"
      from folio_transfers t
      join folios ff on ff.id=t.from_folio_id join reservations fr on fr.id=ff.reservation_id
      join folios tf on tf.id=t.to_folio_id join reservations tr on tr.id=tf.reservation_id
      left join charges c on c.id=t.charge_id left join payments p on p.id=t.payment_id
      where t.property_id=${session.propertyId}::uuid and (ff.reservation_id=${reservationId}::uuid or tf.reservation_id=${reservationId}::uuid)
      order by t.created_at desc
    `;
    return Response.json({ transfers });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const { reservationId } = await context.params;
    const parsed = transferSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Choose what to transfer, the destination folio, and a reason." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      const folio = async (folioId: string) => {
        const [row] = await tx<FolioRow[]>`
          select f.id, f.reservation_id as "reservationId", f.reservation_room_id as "reservationRoomId", r.status, r.company_id as "companyId",
            (coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
              - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0))::int as "balanceCents"
          from folios f join reservations r on r.id=f.reservation_id
          where f.id=${folioId}::uuid and f.property_id=${session.propertyId}::uuid
          for update of f
        `;
        return row;
      };
      const open = (row: FolioRow | undefined, side: string) => {
        if (!row) throw new TransferError(`The ${side} folio was not found.`);
        if (row.status !== "reserved" && row.status !== "checked_in") throw new TransferError(`The ${side} reservation is not open, so its folio cannot change.`);
        return row;
      };
      const businessDate = await propertyBusinessDate(tx, session.propertyId);

      if (input.kind === "charge") {
        const [charge] = await tx<Array<{ id: string; folioId: string; type: string; amountCents: number; taxCents: number }>>`
          select c.id, c.folio_id as "folioId", c.type, c.amount_cents as "amountCents",
            coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)::int as "taxCents"
          from charges c where c.id=${input.chargeId}::uuid and c.property_id=${session.propertyId}::uuid and c.status='posted' for update
        `;
        if (!charge) throw new TransferError("Only a posted charge can be transferred.");
        const from = open(await folio(charge.folioId), "source");
        if (from.reservationId !== reservationId) throw new TransferError("That charge is not on this reservation.");
        const to = open(await folio(input.toFolioId), "destination");
        if (to.id === from.id) throw new TransferError("Choose a different folio.");
        // Room rent belongs to a room night of this stay; it can move between
        // this stay's folios but not to another guest.
        if (charge.type === "Room Rent" && to.reservationId !== from.reservationId) throw new TransferError("Room rent can only move between folios of the same reservation.");
        // Charges follow their folio: checkout gathers charges by room, so a
        // charge moved to another stay takes the destination folio's room.
        await tx`
          update charges set folio_id=${to.id}::uuid,
            reservation_room_id=case when ${to.reservationId === from.reservationId} then reservation_room_id
              else coalesce(${to.reservationRoomId}::uuid, (select rr.id from reservation_rooms rr where rr.reservation_id=${to.reservationId}::uuid order by rr.created_at limit 1)) end,
            updated_at=now()
          where id=${charge.id}::uuid
        `;
        await tx`insert into folio_transfers (property_id,kind,charge_id,from_folio_id,to_folio_id,amount_cents,reason,business_date)
          values (${session.propertyId}::uuid,'charge',${charge.id}::uuid,${from.id}::uuid,${to.id}::uuid,${charge.amountCents + charge.taxCents},${input.reason},${businessDate}::date)`;
        return { reservationIds: [...new Set([from.reservationId, to.reservationId])], amountCents: charge.amountCents + charge.taxCents };
      }

      const from = open(await folio(input.fromFolioId), "source");
      if (from.reservationId !== reservationId) throw new TransferError("That payment is not on this reservation.");
      const to = open(await folio(input.toFolioId), "destination");
      if (to.id === from.id) throw new TransferError("Choose a different folio.");
      const [allocation] = await tx<Array<{ id: string; amountCents: number; method: string }>>`
        select pa.id, pa.amount_cents as "amountCents", p.method from payment_allocations pa join payments p on p.id=pa.payment_id
        where pa.payment_id=${input.paymentId}::uuid and pa.folio_id=${from.id}::uuid for update of pa
      `;
      if (!allocation) throw new TransferError("That payment is not applied to the source folio.");
      if (SYSTEM_METHODS.includes(allocation.method.toUpperCase())) throw new TransferError("System settlement entries cannot be transferred.");
      if (input.amountCents > allocation.amountCents) throw new TransferError("Transfer cannot exceed the payment applied to this folio.");
      if (input.amountCents > Math.max(0, to.balanceCents)) throw new TransferError("Transfer cannot exceed the destination folio's balance.");
      if (to.companyId) throw new TransferError("A company stay is billed to the company; guest payments cannot be moved onto it.");
      if (input.amountCents === allocation.amountCents) await tx`delete from payment_allocations where id=${allocation.id}::uuid`;
      else await tx`update payment_allocations set amount_cents=amount_cents-${input.amountCents} where id=${allocation.id}::uuid`;
      await tx`insert into payment_allocations (property_id,payment_id,folio_id,amount_cents) values (${session.propertyId}::uuid,${input.paymentId}::uuid,${to.id}::uuid,${input.amountCents})`;
      await tx`insert into folio_transfers (property_id,kind,payment_id,from_folio_id,to_folio_id,amount_cents,reason,business_date)
        values (${session.propertyId}::uuid,'payment',${input.paymentId}::uuid,${from.id}::uuid,${to.id}::uuid,${input.amountCents},${input.reason},${businessDate}::date)`;
      return { reservationIds: [...new Set([from.reservationId, to.reservationId])], amountCents: input.amountCents };
    });
    for (const id of result.reservationIds) {
      await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: id, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: { change: "folio-transfer" } });
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof TransferError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
