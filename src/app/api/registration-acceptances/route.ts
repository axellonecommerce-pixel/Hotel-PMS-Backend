import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { logReservationActivity } from "@/server/activity/reservation-activity";

// The guest's check-in acceptance: the exact Rules and Regulations and terms
// they agreed to, with their name and hand signature. The registration card
// and the folio both print this signature.
const acceptanceSchema = z.object({
  reservationId: z.string().uuid(),
  signedName: z.string().trim().min(1).max(200),
  signatureDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).max(1_500_000),
  rulesContent: z.string().max(50_000).default(""),
  termsContent: z.string().max(5_000).default(""),
});

type StoredSignature = { signedName: string; image: string };

function readSignature(value: string | null): StoredSignature | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredSignature>;
    return typeof parsed.image === "string" && typeof parsed.signedName === "string" ? { signedName: parsed.signedName, image: parsed.image } : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = new URL(request.url).searchParams.get("reservationId") ?? "";
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "Choose a reservation." }, { status: 400 });
    const [row] = await productionSql()<Array<{ id: string; acceptedAt: string; content: string; signature: string | null }>>`
      select id, accepted_at::text as "acceptedAt", accepted_rule_content as content, signature_storage_key as signature
      from registration_acceptances where property_id=${session.propertyId}::uuid and reservation_id=${reservationId}::uuid
      order by accepted_at desc limit 1
    `;
    const signature = readSignature(row?.signature ?? null);
    return Response.json({ acceptance: row ? { id: row.id, acceptedAt: row.acceptedAt, acceptedRuleContent: row.content, signedName: signature?.signedName ?? "", signatureDataUrl: signature?.image ?? "" } : null });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = acceptanceSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "The guest's name and signature are required." }, { status: 400 });
    const input = parsed.data;
    const acceptance = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; mainGuestId: string | null }>>`
        select id, main_guest_id as "mainGuestId" from reservations where id=${input.reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      // Keep a version of the property's rules; a new one when they changed.
      await tx`select pg_advisory_xact_lock(hashtext(${`registration-rules:${session.propertyId}`}))`;
      const content = input.rulesContent.trim() || "No property rules entered.";
      let [rule] = await tx<Array<{ id: string; versionNumber: number; content: string }>>`
        select id, version_number as "versionNumber", content from registration_rule_versions
        where property_id=${session.propertyId}::uuid and active=true order by version_number desc limit 1
      `;
      if (!rule || rule.content !== content) {
        const [latest] = await tx<Array<{ versionNumber: number }>>`select version_number as "versionNumber" from registration_rule_versions where property_id=${session.propertyId}::uuid order by version_number desc limit 1`;
        await tx`update registration_rule_versions set active=false where property_id=${session.propertyId}::uuid and active=true`;
        [rule] = await tx<Array<{ id: string; versionNumber: number; content: string }>>`
          insert into registration_rule_versions (property_id,version_number,content,active)
          values (${session.propertyId}::uuid,${(latest?.versionNumber ?? 0) + 1},${content},true)
          returning id, version_number as "versionNumber", content
        `;
      }
      const accepted = [content, input.termsContent.trim()].filter(Boolean).join("\n\n");
      const [created] = await tx<Array<{ id: string; acceptedAt: string }>>`
        insert into registration_acceptances (property_id,reservation_id,rule_version_id,accepted_rule_content,signature_storage_key,signed_by_guest_id)
        values (${session.propertyId}::uuid,${reservation.id}::uuid,${rule.id}::uuid,${accepted},${JSON.stringify({ signedName: input.signedName, image: input.signatureDataUrl })},${reservation.mainGuestId}::uuid)
        returning id, accepted_at::text as "acceptedAt"
      `;
      await logReservationActivity(tx, session, reservation.id, "Guest", `Registration signed by ${input.signedName} · rules version ${rule.versionNumber} accepted`);
      return { id: created.id, acceptedAt: created.acceptedAt, ruleVersionNumber: rule.versionNumber, signedName: input.signedName };
    });
    return Response.json({ acceptance }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /Reservation not found/.test(error.message)) return Response.json({ error: error.message }, { status: 404 });
    return propertyAccessResponse(error);
  }
}
