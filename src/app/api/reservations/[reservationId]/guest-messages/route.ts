import { randomBytes } from "node:crypto";

import { z } from "zod";

import { logReservationActivity } from "@/server/activity/reservation-activity";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";
import { withIdempotency } from "@/server/http/idempotency";
import { hashFolioToken } from "@/server/guest-messages/folio-links";

/**
 * Send to Guest: the front desk sends the guest their folio and/or a Google
 * review request by text or email from its own device (Messages / Mail app).
 *
 * POST makes a private folio link (a copy of the folio exactly as printed,
 * kept for life) and records the send on the reservation's activity.
 * DELETE turns off every folio link of the reservation.
 */
const MAX_DOCUMENT_BYTES = 3_000_000;
const sendSchema = z.object({
  folioId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  documentHtml: z.string().max(MAX_DOCUMENT_BYTES).optional(),
  channels: z.array(z.enum(["sms", "email"])).min(1).max(2),
  reviewRequest: z.boolean(),
}).refine((value) => value.reviewRequest || (value.folioId && value.documentHtml), { message: "Choose the folio, the review request, or both." })
  .refine((value) => !value.folioId || value.documentHtml, { message: "The folio copy is missing." });

const reservationIdOf = (context: { params: Promise<{ reservationId: string }> }) => context.params.then(({ reservationId }) => reservationId);

/** Where guests open folio links: this API's own address, unless set. */
function publicBaseUrl(request: Request) {
  return (process.env.PMS_PUBLIC_BASE_URL?.trim() || new URL(request.url).origin).replace(/\/$/, "");
}

async function routePOST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = await reservationIdOf(context);
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    const parsed = sendSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Choose what to send." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The PMS database is unavailable." }, { status: 503 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string }>>`
        select id from reservations where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid
      `;
      if (!reservation) return { error: "The reservation was not found.", status: 404 } as const;
      let folioUrl: string | undefined;
      if (input.folioId && input.documentHtml) {
        const [folio] = await tx<Array<{ id: string; number: string }>>`
          select id,number from folios where id=${input.folioId}::uuid and reservation_id=${reservationId}::uuid and property_id=${session.propertyId}::uuid
        `;
        if (!folio) return { error: "The folio was not found.", status: 404 } as const;
        const token = randomBytes(24).toString("base64url");
        await tx`
          insert into folio_share_links (property_id,reservation_id,folio_id,token_hash,title,document_html,channels,created_by)
          values (${session.propertyId}::uuid,${reservationId}::uuid,${folio.id}::uuid,${hashFolioToken(token)},${input.title ?? `Folio ${folio.number}`},${input.documentHtml},${input.channels},${session.authUserId}::uuid)
        `;
        await tx`update folios set sent_at=now(),updated_at=now() where id=${folio.id}::uuid and property_id=${session.propertyId}::uuid`;
        folioUrl = `${publicBaseUrl(request)}/f/${token}`;
      }
      const what = [folioUrl ? "Folio link" : "", input.reviewRequest ? "Google review request" : ""].filter(Boolean).join(" and ");
      const how = input.channels.map((channel) => channel === "sms" ? "text" : "email").join(" and ");
      await logReservationActivity(tx, session, reservationId, "Folio", `${what} prepared for the guest by ${how} (opened in this device's ${input.channels.length > 1 ? "Messages and Mail apps" : input.channels[0] === "sms" ? "Messages app" : "Mail app"})`);
      return { folioUrl } as const;
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result);
  } catch (error) { return propertyAccessResponse(error); }
}

async function routeDELETE(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = await reservationIdOf(context);
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The PMS database is unavailable." }, { status: 503 });
    const turnedOff = await productionSql().begin(async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        update folio_share_links set revoked_at=now()
        where reservation_id=${reservationId}::uuid and property_id=${session.propertyId}::uuid and revoked_at is null
        returning id
      `;
      if (rows.length) await logReservationActivity(tx, session, reservationId, "Folio", `${rows.length} folio link${rows.length === 1 ? "" : "s"} turned off`);
      return rows.length;
    });
    return Response.json({ turnedOff });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const POST = withRequestContext(withIdempotency(routePOST));
export const DELETE = withRequestContext(routeDELETE);
