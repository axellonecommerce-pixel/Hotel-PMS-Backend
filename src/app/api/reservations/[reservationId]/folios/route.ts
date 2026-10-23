import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { allocateProductionDocumentNumber } from "@/server/finance/production-finance";

const createSchema = z.object({ name: z.string().trim().min(1).max(120).optional() });
const deleteSchema = z.object({ folioId: z.string().uuid() });

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = await routeParams(context);
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    const folios = await productionSql()<Array<{ id: string; number: string; name: string; reservationRoomId: string | null }>>`
      select id,number,name,reservation_room_id as "reservationRoomId"
      from folios
      where property_id=${session.propertyId}::uuid and reservation_id=${reservationId}::uuid and status <> 'closed'
      order by reservation_room_id nulls last,created_at
    `;
    return Response.json({ folios });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = await routeParams(context);
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Folio details are invalid." }, { status: 400 });
    const folio = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; status: string }>>`
        select id,status from reservations
        where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid
        for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      if (!["reserved", "checked_in"].includes(reservation.status)) throw new Error("A folio cannot be added to this reservation.");
      const [{ count }] = await tx<Array<{ count: number }>>`
        select count(*)::int as count from folios
        where property_id=${session.propertyId}::uuid and reservation_id=${reservation.id}::uuid and reservation_room_id is null
      `;
      const number = await allocateProductionDocumentNumber(tx, session.propertyId);
      const name = parsed.data.name ?? `Extra Charges Folio ${count + 1}`;
      const [created] = await tx<Array<{ id: string; number: string; name: string }>>`
        insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
        values (${session.propertyId}::uuid,${reservation.id}::uuid,null,${number},${name},'open')
        returning id,number,name
      `;
      return created;
    });
    return Response.json({ folio }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /Reservation|folio/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = await routeParams(context);
    const parsed = deleteSchema.safeParse(await request.json());
    if (!z.string().uuid().safeParse(reservationId).success || !parsed.success) return Response.json({ error: "A valid folio is required." }, { status: 400 });
    const deleted = await productionSql().begin(async (tx) => {
      const [folio] = await tx<Array<{ id: string; reservationRoomId: string | null }>>`
        select id,reservation_room_id as "reservationRoomId" from folios
        where id=${parsed.data.folioId}::uuid and reservation_id=${reservationId}::uuid and property_id=${session.propertyId}::uuid and status='open'
        for update
      `;
      if (!folio) throw new Error("Folio not found.");
      if (folio.reservationRoomId) throw new Error("The room and tax folio cannot be deleted.");
      const [activity] = await tx<Array<{ chargeCount: number; paymentCount: number }>>`
        select
          (select count(*)::int from charges where folio_id=${folio.id}::uuid) as "chargeCount",
          (select count(*)::int from payment_allocations where folio_id=${folio.id}::uuid) as "paymentCount"
      `;
      if (activity.chargeCount || activity.paymentCount) throw new Error("This folio has financial activity and cannot be deleted.");
      await tx`delete from folios where id=${folio.id}::uuid and property_id=${session.propertyId}::uuid`;
      return true;
    });
    return Response.json({ deleted });
  } catch (error) {
    if (error instanceof Error && /Folio|folio/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
