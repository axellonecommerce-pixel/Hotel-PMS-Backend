import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { OtaCommissionError } from "@/server/finance/ota-commission";
import { recordChange } from "@/server/realtime/change-events";
import { changeBookingSource } from "@/server/reservations/booking-source";
import { withRequestContext } from "@/server/db/request-context";

const changeSchema = z.object({
  /** A reservation source configured in Settings (Booking.com, Expedia, Agoda, Website, Walk-In…). */
  source: z.string().trim().min(1).max(120).optional(),
  /** How an OTA stay is paid: the OTA collected it, a virtual card, or the guest pays the motel. */
  otaPaymentStatus: z.enum(["Guest Pays Hotel", "Paid Online", "Virtual Card Pending"]).optional(),
  /** Staff kept the room type of an online booking whose room category did not match one. */
  roomTypeConfirmed: z.literal(true).optional(),
});

/** Change a reservation's source or OTA payment type, or confirm an online booking's room type. */
async function routePATCH(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Changing the source requires the PMS database." }, { status: 503 });
    const parsed = changeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (!parsed.data.source && !parsed.data.otaPaymentStatus && !parsed.data.roomTypeConfirmed)) return Response.json({ error: "Choose a source or payment type." }, { status: 400 });
    const { reservationId } = await context.params;
    const result = await productionSql().begin((tx) => changeBookingSource(tx, session, reservationId, parsed.data));
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: reservationId, action: "updated", entityVersion: result.version, payload: {} }).catch(() => undefined);
    return Response.json(result);
  } catch (error) {
    if (error instanceof OtaCommissionError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const PATCH = withRequestContext(routePATCH);
