import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { registrationRuleVersions } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (hasProductionDatabase()) {
      const [rule] = await productionSql()<Array<{ id: string; propertyId: string; versionNumber: number; content: string; active: boolean; createdAt: string }>>`
        select id, property_id as "propertyId", version_number as "versionNumber", content, active, created_at::text as "createdAt"
        from registration_rule_versions where property_id=${session.propertyId}::uuid and active=true
        order by version_number desc limit 1
      `;
      return Response.json({ rule: rule ?? null });
    }
    const rule = await db.query.registrationRuleVersions.findFirst({ where: and(eq(registrationRuleVersions.propertyId, session.propertyId), eq(registrationRuleVersions.active, true)), orderBy: desc(registrationRuleVersions.versionNumber) });
    return Response.json({ rule });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const parsed = z.object({ content: z.string().trim().min(1) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Rules content is required." }, { status: 400 });
    if (hasProductionDatabase()) {
      const rule = await productionSql().begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`registration-rules:${session.propertyId}`}))`;
        const [previous] = await tx<Array<{ versionNumber: number }>>`
          select version_number as "versionNumber" from registration_rule_versions
          where property_id=${session.propertyId}::uuid order by version_number desc limit 1
        `;
        await tx`update registration_rule_versions set active=false where property_id=${session.propertyId}::uuid and active=true`;
        const [created] = await tx<Array<{ id: string; propertyId: string; versionNumber: number; content: string; active: boolean; createdAt: string }>>`
          insert into registration_rule_versions (property_id,version_number,content,active)
          values (${session.propertyId}::uuid,${(previous?.versionNumber ?? 0) + 1},${parsed.data.content},true)
          returning id, property_id as "propertyId", version_number as "versionNumber", content, active, created_at::text as "createdAt"
        `;
        return created;
      });
      return Response.json({ rule }, { status: 201 });
    }
    const previous = await db.query.registrationRuleVersions.findFirst({ where: eq(registrationRuleVersions.propertyId, session.propertyId), orderBy: desc(registrationRuleVersions.versionNumber) });
    const rule = { id: `rule-${crypto.randomUUID()}`, propertyId: session.propertyId, versionNumber: (previous?.versionNumber ?? 0) + 1, content: parsed.data.content, active: true, createdAt: new Date().toISOString() };
    db.transaction((tx) => { tx.update(registrationRuleVersions).set({ active: false }).where(eq(registrationRuleVersions.propertyId, session.propertyId)).run(); tx.insert(registrationRuleVersions).values(rule).run(); });
    return Response.json({ rule }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
