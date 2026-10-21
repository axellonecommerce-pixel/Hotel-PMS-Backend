import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { propertySettings } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";
import { initialApplicationSettings } from "@/server/provisioning/platform-motel";

const settingsSchema = z.record(z.string(), z.unknown());

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (hasProductionDatabase()) {
      const [record] = await productionSql()<Array<{ value: Record<string, unknown> }>>`
        select value from property_settings
        where property_id=${session.propertyId}::uuid and key='application_settings'
      `;
      if (record?.value) return Response.json({ settings: record.value });

      // Properties created before application_settings was introduced already
      // have their identity fields in the properties table. Turn those details
      // into the same initial settings used by new motel provisioning.
      const [property] = await productionSql()<Array<{
        name: string; addressLine1: string; city: string; region: string; postalCode: string; phone: string; timezone: string;
        ownerId: string | null; ownerName: string | null; ownerEmail: string | null;
      }>>`
        select p.name, p.address_line_1 as "addressLine1", p.city, p.region,
          p.postal_code as "postalCode", p.phone, p.timezone,
          e.id as "ownerId", e.name as "ownerName", e.email as "ownerEmail"
        from properties p
        left join lateral (
          select e.id, e.name, e.email
          from employees e
          join property_memberships m on m.id=e.membership_id
          where e.property_id=p.id and m.role='owner'
          order by e.created_at asc
          limit 1
        ) e on true
        where p.id=${session.propertyId}::uuid
      `;
      if (!property) return Response.json({ settings: null });
      const settings = initialApplicationSettings({
        name: property.name,
        addressLine1: property.addressLine1,
        city: property.city,
        region: property.region,
        postalCode: property.postalCode,
        phone: property.phone,
        timezone: property.timezone,
        ownerName: property.ownerName ?? "Property owner",
        ownerEmail: property.ownerEmail ?? "",
      }, property.ownerId ?? session.authUserId);
      await productionSql()`
        insert into property_settings (property_id,key,value)
        values (${session.propertyId}::uuid,'application_settings',${JSON.stringify(settings)}::jsonb)
        on conflict (property_id,key) do nothing
      `;
      return Response.json({ settings });
    }
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
    if (hasProductionDatabase()) {
      await productionSql().begin(async (tx) => {
        await tx`
          insert into property_settings (property_id,key,value,updated_at)
          values (${session.propertyId}::uuid,'application_settings',${JSON.stringify(parsed.data)}::jsonb,${now})
          on conflict (property_id,key) do update set value=excluded.value,updated_at=excluded.updated_at
        `;
        await tx`
          insert into change_events (property_id,actor_auth_user_id,entity_type,entity_id,action,entity_version,payload)
          values (${session.propertyId}::uuid,${session.authUserId}::uuid,'settings',${session.propertyId}::uuid,'updated',${Math.floor(Date.now() / 1000)},'{}'::jsonb)
        `;
      });
      return Response.json({ settings: parsed.data, savedAt: now });
    }
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
