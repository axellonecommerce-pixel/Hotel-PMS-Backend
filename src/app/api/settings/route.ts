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
type ConfiguredPromotion = { id?: string; name?: string; discountType?: "Percentage" | "Fixed Amount"; discountValue?: number; roomTypeIds?: string[]; startDate?: string; endDate?: string; active?: boolean };
type ConfiguredBookingChannel = { name?: string; type?: "Direct" | "OTA" | "Company"; commissionPercent?: number; active?: boolean };

type LiveRoomState = { number: string; cleanlinessStatus: string; serviceStatus: string };

/** Room readiness is operational state, not a Settings draft. Merge the
 * relational inventory into the settings payload so refreshes never turn a
 * room repaired by Maintenance back into a stale clean/non-rentable value. */
function mergeLiveRoomState(value: unknown, liveRooms: LiveRoomState[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const settings = value as Record<string, unknown>;
  if (!Array.isArray(settings.rooms)) return value;
  const byNumber = new Map(liveRooms.map((room) => [room.number, room]));
  return {
    ...settings,
    rooms: settings.rooms.map((room) => {
      if (!room || typeof room !== "object" || Array.isArray(room)) return room;
      const configured = room as Record<string, unknown>;
      const live = typeof configured.number === "string" ? byNumber.get(configured.number) : undefined;
      if (!live) return room;
      return {
        ...configured,
        housekeepingStatus: live.cleanlinessStatus === "clean" ? "clean" : "dirty",
        serviceStatus: live.serviceStatus === "non-rentable" ? "non-rentable" : "rentable",
      };
    }),
  };
}

/**
 * The parts of Settings that are mirrored into relational tables. Room
 * cleanliness/service status are excluded: they are operational state and
 * the sync never overwrites them for existing rooms.
 */
function inventoryFingerprint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const settings = value as Record<string, unknown>;
  const rooms = Array.isArray(settings.rooms)
    ? (settings.rooms as Array<Record<string, unknown>>).map(({ housekeepingStatus: _h, serviceStatus: _s, ...room }) => room)
    : [];
  return JSON.stringify([settings.roomTypes, rooms, settings.employees, settings.promotions, settings.bookingChannels]);
}

async function synchronizeConfiguredInventory(tx: TransactionSql, propertyId: string, value: Record<string, unknown>) {
  const configuredTypes = Array.isArray(value.roomTypes) ? value.roomTypes as ConfiguredRoomType[] : [];
  const configuredRooms = Array.isArray(value.rooms) ? value.rooms as ConfiguredRoom[] : [];
  const configuredEmployees = Array.isArray(value.employees) ? value.employees as ConfiguredEmployee[] : [];
  const configuredPromotions = Array.isArray(value.promotions) ? value.promotions as ConfiguredPromotion[] : [];
  const configuredBookingChannels = Array.isArray(value.bookingChannels) ? value.bookingChannels as ConfiguredBookingChannel[] : [];
  const typeIds = new Map<string, string>();
  const synchronizedPromotionIds = new Set<string>();
  const synchronizedBookingSourceIds = new Set<string>();
  for (const configured of configuredBookingChannels) {
    if (!configured.name?.trim()) continue;
    const commissionBasisPoints = Math.round(Math.max(0, Math.min(100, configured.commissionPercent ?? 0)) * 100);
    const [bookingSource] = await tx<Array<{ id: string }>>`
      insert into booking_sources (property_id,name,type,commission_basis_points,active)
      values (${propertyId}::uuid,${configured.name.trim()},${configured.type?.toLowerCase() || "other"},${commissionBasisPoints},${configured.active !== false})
      on conflict (property_id,name) do update set type=excluded.type,commission_basis_points=excluded.commission_basis_points,active=excluded.active
      returning id
    `;
    synchronizedBookingSourceIds.add(bookingSource.id);
  }
  // Historical reservations refer to their source, so removed sources are
  // deactivated instead of deleted. A source cannot be selected for a new
  // reservation once it is no longer configured in Settings.
  if (configuredBookingChannels.length) {
    const storedSources = await tx<Array<{ id: string }>>`select id from booking_sources where property_id=${propertyId}::uuid and active=true for update`;
    for (const source of storedSources) {
      if (!synchronizedBookingSourceIds.has(source.id)) {
        await tx`update booking_sources set active=false where id=${source.id}::uuid and property_id=${propertyId}::uuid`;
      }
    }
  }
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
  // One statement for every room: per-row round trips made a Settings save
  // take 10-20 seconds against a remote database.
  const roomRows = configuredRooms
    .filter((room) => room.number?.trim() && room.roomTypeId && typeIds.has(room.roomTypeId))
    .map((room) => ({
      room_type_id: typeIds.get(room.roomTypeId!)!,
      number: room.number!.trim(),
      floor: String(room.floor ?? 1),
      section: room.buildingId || null,
      cleanliness_status: room.housekeepingStatus || "clean",
      service_status: room.serviceStatus === "non-rentable" ? "non-rentable" : "rentable",
      smoking_allowed: Boolean(room.smokingAllowed),
      map_data: { mapColumn: room.mapColumn, mapRow: room.mapRow, mapWidth: room.mapWidth, mapHeight: room.mapHeight },
    }));
  if (roomRows.length) {
    await tx`
      insert into rooms (property_id,room_type_id,number,floor,section,cleanliness_status,service_status,smoking_allowed,active,map_data)
      select ${propertyId}::uuid,x.room_type_id,x.number,x.floor,x.section,x.cleanliness_status,x.service_status,x.smoking_allowed,true,x.map_data
      from jsonb_to_recordset(${tx.json(roomRows)}) as x(room_type_id uuid,number text,floor text,section text,cleanliness_status text,service_status text,smoking_allowed boolean,map_data jsonb)
      on conflict (property_id,number) do update set room_type_id=excluded.room_type_id,floor=excluded.floor,section=excluded.section,smoking_allowed=excluded.smoking_allowed,map_data=excluded.map_data,updated_at=now()
    `;
  }
  // Promotion IDs become database UUIDs on the first successful Settings
  // save. This gives reservation_promotions a durable, tenant-scoped target
  // while keeping the Settings JSON as the editing source of truth.
  for (const configured of configuredPromotions) {
    if (!configured.name?.trim() || !configured.startDate || !configured.endDate || configured.endDate < configured.startDate) continue;
    const discountType = configured.discountType === "Fixed Amount" ? "fixed" : "percentage";
    const discountValue = discountType === "fixed"
      ? Math.max(0, Math.round((configured.discountValue ?? 0) * 100))
      : Math.max(0, Math.round((configured.discountValue ?? 0) * 100));
    let promotionId: string | undefined;
    if (configured.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configured.id)) {
      const [existing] = await tx<Array<{ id: string }>>`select id from promotions where id=${configured.id}::uuid and property_id=${propertyId}::uuid for update`;
      promotionId = existing?.id;
    }
    // One-time compatibility path for Settings records created before IDs
    // were synchronized. New browser records use UUIDs, so this name lookup
    // is never used to create a second promotion.
    if (!promotionId) {
      const [existing] = await tx<Array<{ id: string }>>`select id from promotions where property_id=${propertyId}::uuid and name=${configured.name.trim()} order by id limit 1 for update`;
      promotionId = existing?.id;
    }
    if (promotionId) {
      await tx`update promotions set name=${configured.name.trim()},discount_type=${discountType},discount_value=${discountValue},starts_on=${configured.startDate}::date,ends_on=${configured.endDate}::date,active=${configured.active !== false} where id=${promotionId}::uuid and property_id=${propertyId}::uuid`;
    } else {
      const [created] = await tx<Array<{ id: string }>>`insert into promotions (property_id,name,discount_type,discount_value,starts_on,ends_on,active) values (${propertyId}::uuid,${configured.name.trim()},${discountType},${discountValue},${configured.startDate}::date,${configured.endDate}::date,${configured.active !== false}) returning id`;
      promotionId = created.id;
    }
    configured.id = promotionId;
    synchronizedPromotionIds.add(promotionId);
    await tx`delete from promotion_room_types where property_id=${propertyId}::uuid and promotion_id=${promotionId}::uuid`;
    for (const configuredRoomTypeId of configured.roomTypeIds ?? []) {
      const roomTypeId = typeIds.get(configuredRoomTypeId);
      if (!roomTypeId) continue;
      await tx`insert into promotion_room_types (property_id,promotion_id,room_type_id) values (${propertyId}::uuid,${promotionId}::uuid,${roomTypeId}::uuid) on conflict (promotion_id,room_type_id) do nothing`;
    }
  }
  // Settings is the source of truth. Do not delete historical promotion rows
  // that may be referenced by past reservations; deactivate records removed
  // from Settings so they cannot be applied to another stay.
  const storedPromotions = await tx<Array<{ id: string }>>`select id from promotions where property_id=${propertyId}::uuid and active=true for update`;
  for (const promotion of storedPromotions) {
    if (!synchronizedPromotionIds.has(promotion.id)) {
      await tx`update promotions set active=false where id=${promotion.id}::uuid and property_id=${propertyId}::uuid`;
    }
  }
  // Settings-created employees do not necessarily have login memberships, but
  // they are still operational staff and must exist as relational records for
  // housekeeping, maintenance, payroll, and time workflows.
  const employeeRows = configuredEmployees
    .filter((employee) => employee.name?.trim() && employee.role?.trim())
    .map((employee) => ({ name: employee.name!.trim(), role: employee.role!.trim(), rate: Math.max(0, employee.hourlyRateCents ?? 0), active: employee.status !== "Inactive" }));
  if (employeeRows.length) {
    await tx`
      with input as (
        select * from jsonb_to_recordset(${tx.json(employeeRows)}) as x(name text,role text,rate int,active boolean)
      ), updated as (
        update employees e set job_role=i.role,hourly_rate_cents=i.rate,active=i.active,updated_at=now()
        from input i where e.property_id=${propertyId}::uuid and lower(e.name)=lower(i.name)
        returning lower(e.name) as name
      )
      insert into employees (property_id,name,job_role,pay_method,hourly_rate_cents,active)
      select ${propertyId}::uuid,i.name,i.role,'hourly',i.rate,i.active from input i
      where lower(i.name) not in (select name from updated)
    `;
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
        const liveRooms = await productionSql()<LiveRoomState[]>`
          select number,cleanliness_status as "cleanlinessStatus",service_status as "serviceStatus"
          from rooms where property_id=${session.propertyId}::uuid
        `;
        return Response.json({ settings: mergeLiveRoomState(storedSettings, liveRooms) });
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
        const [stored] = await tx<Array<{ value: unknown }>>`
          select value from property_settings where property_id=${session.propertyId}::uuid and key='application_settings' for update
        `;
        // Most saves (payment types, toggles, tax text) do not touch the
        // inventory, so skip the relational sync when it is unchanged.
        if (inventoryFingerprint(parseStoredSettings(stored?.value)) !== inventoryFingerprint(parsed.data)) {
          await synchronizeConfiguredInventory(tx, session.propertyId, parsed.data);
        }
        await tx`
          insert into property_settings (property_id,key,value,updated_at)
          values (${session.propertyId}::uuid,'application_settings',${tx.json(JSON.parse(JSON.stringify(parsed.data)))},${now})
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
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Date.now(), payload: {} });
    return Response.json({ settings: parsed.data, savedAt: now });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
