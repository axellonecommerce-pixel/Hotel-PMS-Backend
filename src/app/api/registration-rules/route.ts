import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { registrationRuleVersions } from "@/server/db/schema";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const rule = await db.query.registrationRuleVersions.findFirst({ where: and(eq(registrationRuleVersions.propertyId, session.propertyId), eq(registrationRuleVersions.active, true)), orderBy: desc(registrationRuleVersions.versionNumber) });
    return Response.json({ rule });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const parsed = z.object({ content: z.string().trim().min(1) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Rules content is required." }, { status: 400 });
    const previous = await db.query.registrationRuleVersions.findFirst({ where: eq(registrationRuleVersions.propertyId, session.propertyId), orderBy: desc(registrationRuleVersions.versionNumber) });
    const rule = { id: `rule-${crypto.randomUUID()}`, propertyId: session.propertyId, versionNumber: (previous?.versionNumber ?? 0) + 1, content: parsed.data.content, active: true, createdAt: new Date().toISOString() };
    db.transaction((tx) => { tx.update(registrationRuleVersions).set({ active: false }).where(eq(registrationRuleVersions.propertyId, session.propertyId)).run(); tx.insert(registrationRuleVersions).values(rule).run(); });
    return Response.json({ rule }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
