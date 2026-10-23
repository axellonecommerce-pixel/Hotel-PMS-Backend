import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { allocateProductionDocumentNumber } from "@/server/finance/production-finance";
import { recordChange } from "@/server/realtime/change-events";

const checkoutSchema = z.object({
  reservationId: z.string().uuid(),
  reservationRoomIds: z.array(z.string().uuid()).min(1),
});

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = checkoutSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select at least one room to check out." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; companyId: string | null; currencyCode: string }>>`
        select id, company_id as "companyId", currency_code as "currencyCode"
        from reservations
        where id=${input.reservationId}::uuid and property_id=${session.propertyId}::uuid
        for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      const selectedRooms = await tx<Array<{ id: string; roomId: string | null; status: string }>>`
        select id, room_id as "roomId", status
        from reservation_rooms
        where reservation_id=${reservation.id}::uuid and property_id=${session.propertyId}::uuid
          and id in ${tx(input.reservationRoomIds)}
        for update
      `;
      if (selectedRooms.length !== input.reservationRoomIds.length || selectedRooms.some((room) => room.status !== "checked_in")) {
        throw new Error("Only checked-in rooms can be checked out.");
      }

      const unresolved = await tx<Array<{ reservationRoomId: string; remainingCents: number }>>`
        select d.reservation_room_id as "reservationRoomId",
          greatest(0, d.amount_cents - coalesce(sum(t.amount_cents), 0))::int as "remainingCents"
        from security_deposits d
        left join deposit_transactions t on t.deposit_id=d.id and t.type in ('release','charge')
        where d.property_id=${session.propertyId}::uuid and d.reservation_room_id in ${tx(input.reservationRoomIds)}
        group by d.id
        having greatest(0, d.amount_cents - coalesce(sum(t.amount_cents), 0)) > 0
      `;
      if (unresolved.length) throw new Error("Release or charge every room deposit before checkout.");

      const folioIds: string[] = [];
      for (const room of selectedRooms) {
        let [folio] = await tx<Array<{ id: string }>>`
          select id from folios
          where reservation_id=${reservation.id}::uuid and reservation_room_id=${room.id}::uuid
          order by created_at limit 1 for update
        `;
        if (!folio) {
          const number = await allocateProductionDocumentNumber(tx, session.propertyId);
          [folio] = await tx<Array<{ id: string }>>`
            insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
            values (${session.propertyId}::uuid,${reservation.id}::uuid,${room.id}::uuid,${number},'General Folio','open')
            returning id
          `;
        }
        folioIds.push(folio.id);
        await tx`
          update charges set folio_id=${folio.id}::uuid, updated_at=now()
          where property_id=${session.propertyId}::uuid and reservation_room_id=${room.id}::uuid
        `;
      }

      const balances = await tx<Array<{ folioId: string; balanceCents: number }>>`
        select f.id as "folioId", (
          coalesce(sum(distinct_charge.amount_cents + distinct_charge.tax_cents),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0)
        )::int as "balanceCents"
        from folios f
        left join lateral (
          select c.id, c.amount_cents, coalesce(sum(ct.amount_cents),0)::int as tax_cents
          from charges c left join charge_taxes ct on ct.charge_id=c.id
          where c.folio_id=f.id and c.status='posted'
          group by c.id
        ) distinct_charge on true
        where f.id in ${tx(folioIds)}
        group by f.id
      `;
      if (!reservation.companyId && balances.some((folio) => folio.balanceCents !== 0)) {
        throw new Error("The selected room folio balance must be zero before checkout.");
      }

      await tx`
        update reservation_rooms set status='checked_out', checked_out_at=now(), updated_at=now()
        where id in ${tx(input.reservationRoomIds)} and property_id=${session.propertyId}::uuid
      `;
      const physicalRoomIds = selectedRooms.flatMap((room) => room.roomId ? [room.roomId] : []);
      if (physicalRoomIds.length) await tx`
        update rooms set cleanliness_status='dirty', updated_at=now()
        where id in ${tx(physicalRoomIds)} and property_id=${session.propertyId}::uuid
      `;
      const [remaining] = await tx<Array<{ count: number }>>`
        select count(*)::int as count from reservation_rooms
        where reservation_id=${reservation.id}::uuid and status <> 'checked_out'
      `;
      let invoiceId: string | null = null;
      if (remaining.count === 0) {
        await tx`update reservations set status='checked_out', updated_at=now() where id=${reservation.id}::uuid`;
        if (reservation.companyId) {
          const [existing] = await tx<Array<{ id: string }>>`select id from invoices where reservation_id=${reservation.id}::uuid limit 1`;
          if (existing) invoiceId = existing.id;
          else {
            const [company] = await tx<Array<{ paymentTermsDays: number }>>`
              select payment_terms_days as "paymentTermsDays" from companies
              where id=${reservation.companyId}::uuid and property_id=${session.propertyId}::uuid
            `;
            const number = await allocateProductionDocumentNumber(tx, session.propertyId);
            const [invoice] = await tx<Array<{ id: string }>>`
              insert into invoices (property_id,company_id,reservation_id,number,status,due_date)
              values (${session.propertyId}::uuid,${reservation.companyId}::uuid,${reservation.id}::uuid,${number},'draft',(current_date + ${company?.paymentTermsDays ?? 30}))::date)
              returning id
            `;
            invoiceId = invoice.id;
            await tx`
              insert into invoice_lines (property_id,invoice_id,folio_id,charge_id,description,amount_cents)
              select ${session.propertyId}::uuid,${invoice.id}::uuid,c.folio_id,c.id,c.description,
                c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)
              from charges c join folios f on f.id=c.folio_id
              where f.reservation_id=${reservation.id}::uuid and c.status='posted'
            `;
          }
        }
      }
      return { checkedOutRoomIds: input.reservationRoomIds, reservationCheckedOut: remaining.count === 0, invoiceId };
    });
    await recordChange({
      propertyId: session.propertyId,
      actorAuthUserId: session.authUserId,
      entityType: "reservation",
      entityId: input.reservationId,
      action: "updated",
      entityVersion: Date.now(),
      payload: { change: "checkout", checkedOutRoomIds: result.checkedOutRoomIds },
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && /checkout|deposit|balance|reservation/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return propertyAccessResponse(error);
  }
}
