import type { Sql, TransactionSql } from "postgres";

import { addDays } from "@/server/rates/rate-calendar";

type Db = Sql | TransactionSql<Record<string, never>>;
type StoredSettings = { roomTypes?: Array<{ id: string; name: string; active?: boolean }>; rooms?: Array<{ number: string; roomTypeId: string }> };

export type DayInventory = {
  /** Active rooms of the type. */
  rooms: number;
  /** Non-rentable or blocked by maintenance on this date. */
  outOfOrder: number;
  /** Rooms booked for this night (assigned and unassigned). */
  sold: number;
  /** Optional cap from the rate calendar. */
  sellLimit: number | null;
  /** Rooms that can still be sold: free rentable rooms, within the cap. */
  available: number;
};

/**
 * Room inventory per Settings room type and night over [start, endInclusive].
 * Mirrors what booking allows: a non-rentable room, or one blocked by an open
 * maintenance issue on that night, never counts as available, and a day-use
 * stay holds its arrival night.
 */
export async function roomInventory(db: Db, propertyId: string, start: string, endInclusive: string) {
  const [settingsRow] = await db<Array<{ value: StoredSettings | string | null }>>`
    select value from property_settings where property_id=${propertyId}::uuid and key='application_settings'
  `;
  const settings: StoredSettings = typeof settingsRow?.value === "string" ? JSON.parse(settingsRow.value) : settingsRow?.value ?? {};
  const roomTypes = (settings.roomTypes ?? []).filter((type) => type.active !== false);
  const typeByRoom = new Map((settings.rooms ?? []).map((room) => [room.number, room.roomTypeId]));
  const endExclusive = addDays(endInclusive, 1);

  const rooms = await db<Array<{ number: string; typeName: string; rentable: boolean }>>`
    select r.number, rt.name as "typeName", r.service_status='rentable' as rentable
    from rooms r join room_types rt on rt.id=r.room_type_id
    where r.property_id=${propertyId}::uuid and r.active
  `;
  const blocks = await db<Array<{ number: string; blockFrom: string | null; blockTo: string | null }>>`
    select r.number, case when mo.notes like '{%' then mo.notes::jsonb->>'blockFrom' end as "blockFrom",
      case when mo.notes like '{%' then mo.notes::jsonb->>'blockTo' end as "blockTo"
    from maintenance_orders mo join rooms r on r.id=mo.room_id
    where mo.property_id=${propertyId}::uuid and mo.rentable=false and mo.status not in ('resolved','cancelled')
  `;
  const stays = await db<Array<{ number: string | null; typeName: string; arrival: string; occupiedUntil: string }>>`
    select room.number, rt.name as "typeName", rs.arrival_date::text as arrival, greatest(rs.departure_date, rs.arrival_date + 1)::text as "occupiedUntil"
    from reservation_rooms rr join reservations rs on rs.id=rr.reservation_id join room_types rt on rt.id=rr.room_type_id
    left join rooms room on room.id=rr.room_id
    where rr.property_id=${propertyId}::uuid and rr.status in ('reserved','checked_in') and rs.status in ('reserved','checked_in')
      and rs.arrival_date < ${endExclusive}::date and greatest(rs.departure_date, rs.arrival_date + 1) > ${start}::date
  `;
  const limits = await db<Array<{ roomTypeId: string; stayDate: string; sellLimit: number | null }>>`
    select room_type_id as "roomTypeId", stay_date::text as "stayDate", sell_limit as "sellLimit"
    from rate_calendar where property_id=${propertyId}::uuid and stay_date >= ${start}::date and stay_date <= ${endInclusive}::date and sell_limit is not null
  `;

  // A room belongs to its configured Settings type; otherwise the first type
  // with the same name (smoking variants share a database type name).
  const settingsTypeFor = (number: string | null, typeName: string) =>
    (number ? typeByRoom.get(number) : undefined) ?? roomTypes.find((type) => type.name === typeName)?.id;

  const result = new Map<string, Map<string, DayInventory>>();
  for (let date = start; date <= endInclusive; date = addDays(date, 1)) {
    for (const type of roomTypes) {
      const typeRooms = rooms.filter((room) => settingsTypeFor(room.number, room.typeName) === type.id);
      const outOfOrder = typeRooms.filter((room) => !room.rentable
        || blocks.some((block) => block.number === room.number && block.blockFrom && block.blockTo && block.blockFrom <= date && block.blockTo >= date));
      const nightStays = stays.filter((stay) => stay.arrival <= date && stay.occupiedUntil > date && settingsTypeFor(stay.number, stay.typeName) === type.id);
      const occupiedNumbers = new Set(nightStays.map((stay) => stay.number).filter((number): number is string => Boolean(number)));
      const unassigned = nightStays.filter((stay) => !stay.number).length;
      const free = typeRooms.filter((room) => !outOfOrder.includes(room) && !occupiedNumbers.has(room.number)).length - unassigned;
      const sellLimit = limits.find((limit) => limit.roomTypeId === type.id && limit.stayDate === date)?.sellLimit ?? null;
      const sold = nightStays.length;
      const available = Math.max(0, sellLimit === null ? free : Math.min(free, sellLimit - sold));
      if (!result.has(type.id)) result.set(type.id, new Map());
      result.get(type.id)!.set(date, { rooms: typeRooms.length, outOfOrder: outOfOrder.length, sold, sellLimit, available });
    }
  }
  return result;
}
