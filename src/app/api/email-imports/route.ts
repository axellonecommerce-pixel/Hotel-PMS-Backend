import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { addReviewedBooking, announceImport, readImportLog, writeImportLog } from "@/server/email-import/import-booking";
import { withRequestContext } from "@/server/db/request-context";

/** Settings › Online Bookings: imported booking emails and those that need review. */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (!hasProductionDatabase()) return Response.json({ entries: [] });
    return Response.json({ entries: await readImportLog(productionSql(), session.propertyId) });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

const resolveSchema = z.object({ messageId: z.string().min(1) });

/** Staff dealt with an email in Needs review. */
async function routePATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !hasProductionDatabase()) return Response.json({ error: "Choose an email to mark as done." }, { status: 400 });
    const entries = await productionSql().begin(async (tx) => {
      const log = await readImportLog(tx, session.propertyId, true);
      const next = log.map((entry) => entry.messageId === parsed.data.messageId && entry.status === "review" ? { ...entry, status: "resolved" as const } : entry);
      await writeImportLog(tx, session.propertyId, next);
      return next;
    });
    return Response.json({ entries });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/** Add a booking from review to Arrivals with every detail from its email. */
async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !hasProductionDatabase()) return Response.json({ error: "Choose a booking to add." }, { status: 400 });
    const result = await addReviewedBooking(productionSql(), session.propertyId, parsed.data.messageId);
    if (result.error) return Response.json(result, { status: 409 });
    await announceImport(productionSql(), session.propertyId, { status: "imported", message: "", reservationId: result.reservationId });
    return Response.json(result);
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
export const PATCH = withRequestContext(routePATCH);
