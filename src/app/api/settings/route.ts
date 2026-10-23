import { and, eq } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { propertySettings } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";
import { initialApplicationSettings } from "@/server/provisioning/platform-motel";

type ConfiguredRoomType = { id?: string; name?: string; shortLabel?: string; maxOccupancy?: number; baseRateCents?: number; active?: boolean; sortOrder?: number };
type ConfiguredRoom = { number?: string; roomTypeId?: string; floor?: number; buildingId?: string; housekeepingStatus?: string; serviceStatus?: string; smokingAllowed?: boolean; mapColumn?: number; mapRow?: number; mapWidth?: number; mapHeight?: number };
type ConfiguredEmployee = { name?: string; role?: string; hourlyRateCents?: number; status?: string };

async function synchronizeConfiguredInventory(tx: TransactionSql, propertyId: string, value: Record<string, unknown>) {
  const configuredTypes = Array.isArray(value.roomTypes) ? value.roomTypes as ConfiguredRoomType[] : [];
  const configuredRooms = Array.isArray(value.rooms) ? value.rooms as ConfiguredRoom[] : [];
  const configuredEmployees = Array.isArray(value.employees) ? value.employees as ConfiguredEmployee[] : [];
  const typeIds = new Map<string, string>();
  for (const [index, configured] of configuredTypes.entries()) {
    if (!configured.id || !configured.name?.trim()) continue;
    const [roomType] = await tx<Array<{ id: string }>>`
      insert into room_types (property_id,name,short_label,max_occupancy,base_rate_cents,active,sort_order)
      values (${propertyId}::uuid,${configured.name.trim()},${configured.shortLabel?.trim() || configured.name.trim()},${Math.max(1, configured.maxOccupancy ?? 1)},${Math.max(0, configured.baseRateCents ?? 0)},${configured.active !== false},${configured.sortOrder ?? index})
      on conflict (property_id,name) do update set short_label=excluded.short_label,max_occupancy=excluded.max_occupancy,base_rate_cents=excluded.base_rate_cents,active=excluded.active,sort_order=excluded.sort_order,updated_at=now()
      returning id
    `;
    typeIds.set(configured.id, roomType.id);
  }
  for (const room of configuredRooms) {
    if (!room.number?.trim() || !room.roomTypeId || !typeIds.has(room.roomTypeId)) continue;
    await tx`
      insert into rooms (property_id,room_type_id,number,floor,section,cleanliness_status,service_status,smoking_allowed,active,map_data)
      values (${propertyId}::uuid,${typeIds.get(room.roomTypeId)!}::uuid,${room.number.trim()},${String(room.floor ?? 1)},${room.buildingId || null},${room.housekeepingStatus || "clean"},${room.serviceStatus === "non-rentable" ? "non-rentable" : "rentable"},${Boolean(room.smokingAllowed)},true,${tx.json({ mapColumn: room.mapColumn, mapRow: room.mapRow, mapWidth: room.mapWidth, mapHeight: room.mapHeight })})
      on conflict (property_id,number) do update set room_type_id=excluded.room_type_id,floor=excluded.floor,section=excluded.section,cleanliness_status=excluded.cleanliness_status,service_status=excluded.service_status,smoking_allowed=excluded.smoking_allowed,map_data=excluded.map_data,updated_at=now()
    `;
  }
  // Settings-created employees do not necessarily have login memberships, but
  // they are still operational staff and must exist as relational records for
  // housekeeping, maintenance, payroll, and time workflows.
  for (const employee of configuredEmployees) {
    if (!employee.name?.trim() || !employee.role?.trim()) continue;
    const [existing] = await tx<Array<{ id: string }>>`select id from employees where property_id=${propertyId}::uuid and lower(name)=lower(${employee.name.trim()}) limit 1`;
    if (existing) await tx`update employees set job_role=${employee.role.trim()},hourly_rate_cents=${Math.max(0, employee.hourlyRateCents ?? 0)},active=${employee.status !== "Inactive"},updated_at=now() where id=${existing.id}::uuid`;
    else await tx`insert into employees (property_id,name,job_role,pay_method,hourly_rate_cents,active) values (${propertyId}::uuid,${employee.name.trim()},${employee.role.trim()},'hourly',${Math.max(0, employee.hourlyRateCents ?? 0)},${employee.status !== "Inactive"})`;
  }
}

const settingsSchema = z.record(z.string(), z.unknown());

function parseStoredSettings(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (hasProductionDatabase()) {
      const [record] = await productionSql()<Array<{ value: unknown }>>`
        select value from property_settings
        where property_id=${session.propertyId}::uuid and key='application_settings'
      `;
      const storedSettings = parseStoredSettings(record?.value);
      if (storedSettings) {
        // Versions released before this repair wrote JSON as a quoted JSONB
        // string. Read it safely and repair it in place so a property never
        // falls back to the generic "New Property" workspace again.
        if (typeof record?.value === "string") {
          await productionSql()`
            update property_settings
            set value=${productionSql().json(JSON.parse(JSON.stringify(storedSettings)))},updated_at=now()
            where property_id=${session.propertyId}::uuid and key='application_settings'
          `;
        }
        return Response.json({ settings: storedSettings });
      }

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
        values (${session.propertyId}::uuid,'application_settings',${productionSql().json(settings)})
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
          values (${session.propertyId}::uuid,'application_settings',${tx.json(JSON.parse(JSON.stringify(parsed.data)))},${now})
          on conflict (property_id,key) do update set value=excluded.value,updated_at=excluded.updated_at
        `;
        await synchronizeConfiguredInventory(tx, session.propertyId, parsed.data);
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
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: {} });
    return Response.json({ settings: parsed.data, savedAt: now });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
