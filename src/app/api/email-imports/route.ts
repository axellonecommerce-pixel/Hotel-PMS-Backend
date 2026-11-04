import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { readImportLog, writeImportLog } from "@/server/email-import/import-booking";

/** Settings › Online Bookings: imported booking emails and those that need review. */
export async function GET(request: Request) {
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
export async function PATCH(request: Request) {
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
