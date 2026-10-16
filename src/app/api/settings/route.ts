import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { propertySettings } from "@/server/db/schema";
import { recordChange } from "@/server/realtime/change-events";

const settingsSchema = z.record(z.string(), z.unknown());

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const record = await db.query.propertySettings.findFirst({
      where: and(eq(propertySettings.propertyId, session.propertyId), eq(propertySettings.key, "application_settings")),
    });
    return Response.json({ settings: record ? JSON.parse(record.value) : null });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const parsed = settingsSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Settings are invalid." }, { status: 400 });
    const now = new Date().toISOString();
    db.insert(propertySettings).values({
      id: `setting-${crypto.randomUUID()}`,
      propertyId: session.propertyId,
      key: "application_settings",
      value: JSON.stringify(parsed.data),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [propertySettings.propertyId, propertySettings.key],
      set: { value: JSON.stringify(parsed.data), updatedAt: now },
    }).run();
    recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: {} });
    return Response.json({ settings: parsed.data, savedAt: now });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
