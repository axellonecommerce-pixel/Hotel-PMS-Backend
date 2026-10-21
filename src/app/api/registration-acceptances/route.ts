import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

const acceptanceSchema = z.object({
  reservationId: z.string().uuid(),
  signedByGuestId: z.string().uuid().nullable().optional(),
  signatureStorageKey: z.string().trim().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = acceptanceSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Registration acceptance is invalid." }, { status: 400 });
    const acceptance = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string }>>`
        select id from reservations where id=${parsed.data.reservationId}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      const [rule] = await tx<Array<{ id: string; versionNumber: number; content: string }>>`
        select id, version_number as "versionNumber", content
        from registration_rule_versions
        where property_id=${session.propertyId}::uuid and active=true
        order by version_number desc limit 1
      `;
      if (!rule) throw new Error("Create registration rules before check-in.");
      const [created] = await tx<Array<{ id: string; acceptedAt: string }>>`
        insert into registration_acceptances (
          property_id,reservation_id,rule_version_id,accepted_rule_content,signature_storage_key,signed_by_guest_id
        ) values (
          ${session.propertyId}::uuid,${reservation.id}::uuid,${rule.id}::uuid,${rule.content},
          ${parsed.data.signatureStorageKey ?? null},${parsed.data.signedByGuestId ?? null}::uuid
        ) returning id, accepted_at::text as "acceptedAt"
      `;
      return { ...created, ruleVersionId: rule.id, ruleVersionNumber: rule.versionNumber, acceptedRuleContent: rule.content };
    });
    return Response.json({ acceptance }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /reservation|registration rules/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
