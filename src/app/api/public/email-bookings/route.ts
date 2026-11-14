import { z } from "zod";

import { setRequestActor } from "@/server/db/request-context";

import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { announceImport, importBookingEmail, motelForImportKey } from "@/server/email-import/import-booking";
import { withRequestContext } from "@/server/db/request-context";
import { overRateLimit, rateLimitReached, tooManyRequests } from "@/server/http/rate-limit";

/**
 * Booking emails from the motel's Gmail (the InnSeva script in Settings ›
 * Online Bookings). The script removes card lines before sending; the server
 * removes them again before reading. Answers imported, duplicate, review or
 * ignored, so the script can label the email in Gmail.
 */
const emailSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  subject: z.string().max(1000).default(""),
  from: z.string().max(320).default(""),
  receivedAt: z.string().max(40).optional(),
  text: z.string().max(200_000),
});

async function routePOST(request: Request) {
  try {
    if (!hasProductionDatabase()) return Response.json({ error: "Booking import is unavailable." }, { status: 503 });
    // Guessing keys: 20 wrong keys in 10 minutes blocks that address for the
    // rest of the window. (Google's servers run every motel's script, so
    // correct keys are never limited by address.)
    if (await rateLimitReached(request, "import-bad-key", 20, 600)) return tooManyRequests(600);
    const motel = await motelForImportKey(productionSql(), request.headers.get("x-import-key"));
    if (!motel) await overRateLimit(request, "import-bad-key", 20, 600);
    if (!motel) return Response.json({ error: "Booking email import is off, or the key is wrong. Copy the script again from Settings › Online Bookings." }, { status: 401 });
    const parsed = emailSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "The email could not be read." }, { status: 400 });
    setRequestActor({ label: "Booking email import" });
    const result = await importBookingEmail(productionSql(), motel, parsed.data);
    await announceImport(productionSql(), motel.propertyId, result);
    return Response.json({ status: result.status, message: result.message });
  } catch (error) {
    // Never log the email itself: it holds guest details.
    console.error("Booking email import failed", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "The booking could not be imported. It will be tried again." }, { status: 500 });
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const POST = withRequestContext(routePOST);
