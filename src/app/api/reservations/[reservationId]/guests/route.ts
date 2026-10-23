import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";

const bodySchema = z.object({
  guestId: z.string().uuid(),
});

async function reservationIdFrom(context: { params: Promise<{ reservationId: string }> }) {
  return (await context.params).reservationId;
}

/**
 * Adds an existing tenant guest to a reservation. Guest profiles are created
 * through /api/guests first so identity/contact data stays reusable and the
 * reservation join table only expresses the stay relationship.
 */
export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select a valid guest." }, { status: 400 });
    const reservationId = await reservationIdFrom(context);
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ mainGuestId: string }>>`
        select main_guest_id as "mainGuestId" from reservations
        where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      if (reservation.mainGuestId === parsed.data.guestId) throw new Error("The primary guest is already attached to this reservation.");
      const [guest] = await tx<Array<{ id: string; name: string; driverLicenseNumber: string | null }>>`
        select g.id,concat(g.first_name,' ',g.last_name) as name,identity.id_number as "driverLicenseNumber"
        from guests g
        left join guest_identities identity on identity.guest_id=g.id and identity.deleted_at is null
        where g.id=${parsed.data.guestId}::uuid and g.property_id=${session.propertyId}::uuid
        for update
      `;
      if (!guest) throw new Error("Guest not found.");
      const [attached] = await tx<Array<{ id: string }>>`
        insert into reservation_guests (property_id,reservation_id,guest_id,"primary")
        values (${session.propertyId}::uuid,${reservationId}::uuid,${guest.id}::uuid,false)
        on conflict (reservation_id,guest_id) do nothing
        returning id
      `;
      if (!attached) throw new Error("This guest is already attached to the reservation.");
      return guest;
    });
    try {
      await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: reservationId, action: "updated", entityVersion: 1, payload: { guestId: result.id, change: "extra_guest_added" } });
    } catch {
      // A committed relationship must not be reported as failed because a
      // best-effort realtime notification is unavailable.
    }
    return Response.json({ guest: result }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /Reservation|Guest|primary guest|already attached/.test(error.message)) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return propertyAccessResponse(error);
  }
}
