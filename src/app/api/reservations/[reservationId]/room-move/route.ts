import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const requestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  destinationRoomNumber: z.string().trim().min(1).max(80),
  remark: z.string().trim().min(1).max(2_000),
  rateDecision: z.enum(["keep", "change"]),
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
      const [reservation] = await tx<Array<{ id: string; version: number; status: string }>>`
        select id,version,status from reservations
        where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) return { error: "Reservation not found.", status: 404 } as const;
      if (reservation.version !== input.data.expectedVersion) return { error: "Another employee changed this reservation. Review the latest version before moving the room.", status: 409, code: "EDIT_CONFLICT", currentVersion: reservation.version } as const;
      if (reservation.status !== "reserved" && reservation.status !== "checked_in") return { error: "Only an arriving or in-house guest can be moved.", status: 409 } as const;

      const [reservationRoom] = await tx<Array<{ id: string; roomId: string; roomNumber: string }>>`
        select rr.id,rr.room_id as "roomId",r.number as "roomNumber"
        from reservation_rooms rr join rooms r on r.id=rr.room_id
        where rr.reservation_id=${reservation.id}::uuid and rr.property_id=${session.propertyId}::uuid
          and rr.status in ('reserved','checked_in')
        order by rr.created_at limit 1 for update
      `;
      if (!reservationRoom?.roomId) return { error: "This reservation has no assigned room to move.", status: 409 } as const;
      if (reservationRoom.roomNumber === input.data.destinationRoomNumber) return { error: "Choose a different destination room.", status: 400 } as const;

      const [destination] = await tx<Array<{ id: string; number: string; roomTypeId: string; cleanliness: string; service: string }>>`
        select id,number,room_type_id as "roomTypeId",cleanliness_status as cleanliness,service_status as service
        from rooms where property_id=${session.propertyId}::uuid and number=${input.data.destinationRoomNumber} for update
      `;
      if (!destination || destination.service !== "rentable") return { error: "This destination room is non-rentable.", status: 409 } as const;
      const [occupied] = await tx<Array<{ id: string }>>`
        select rr.id from reservation_rooms rr join reservations r on r.id=rr.reservation_id
        where rr.property_id=${session.propertyId}::uuid and rr.room_id=${destination.id}::uuid
          and rr.status in ('reserved','checked_in') and r.status in ('reserved','checked_in')
        limit 1 for update
      `;
      if (occupied) return { error: "The destination room is already assigned to another active reservation.", status: 409 } as const;

      const [employee] = await tx<Array<{ id: string }>>`
        select id from employees where property_id=${session.propertyId}::uuid
          and membership_id in (select id from property_memberships where auth_user_id=${session.authUserId}::uuid and property_id=${session.propertyId}::uuid)
        limit 1
      `;
      await tx`
        update reservation_rooms set room_id=${destination.id}::uuid,room_type_id=${destination.roomTypeId}::uuid,updated_at=now()
        where id=${reservationRoom.id}::uuid
      `;
      await tx`
        insert into room_moves (property_id,reservation_room_id,from_room_id,to_room_id,rate_decision,remark,moved_by_employee_id)
        values (${session.propertyId}::uuid,${reservationRoom.id}::uuid,${reservationRoom.roomId}::uuid,${destination.id}::uuid,${input.data.rateDecision},${input.data.remark},${employee?.id ?? null}::uuid)
      `;
      await tx`
        update rooms set cleanliness_status='dirty',updated_at=now()
        where id=${reservationRoom.roomId}::uuid and property_id=${session.propertyId}::uuid
      `;
      await tx`update reservations set version=version+1,updated_at=now() where id=${reservation.id}::uuid`;
      return { room: destination.number, roomTypeId: destination.roomTypeId, destinationDirty: destination.cleanliness !== "clean", version: reservation.version + 1 } as const;
    });
    if ("error" in result) return Response.json(result, { status: result.status });
    return Response.json(result);
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
