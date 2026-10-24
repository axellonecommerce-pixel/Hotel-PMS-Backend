import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { calculateAvailabilityRateCents } from "@/domain/rules/availability";

const querySchema = z.object({
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rateCode: z.string().trim().optional(),
  adults: z.coerce.number().int().positive().default(1),
  children: z.coerce.number().int().nonnegative().default(0),
});

type StoredRoomType = {
  id: string;
  name: string;
  shortLabel?: string;
  baseRateCents?: number;
  active?: boolean;
};
type StoredRateCode = {
  name: string;
  active?: boolean;
  rateAdjustmentPercent?: number;
  isAvailabilityDefault?: boolean;
  roomTypeRates?: Record<string, {
    nightlyRateCents?: number;
    additionalAdultCents?: number;
    childCents?: number;
  }>;
};
type StoredSettings = {
  roomTypes?: StoredRoomType[];
  rooms?: Array<{ number: string; roomTypeId: string }>;
  rateCodes?: StoredRateCode[];
  tax?: { percentage?: number };
};

function settingsValue(value: StoredSettings | string | undefined) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as StoredSettings; }
  catch { return undefined; }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || parsed.data.checkout <= parsed.data.checkIn) {
      return Response.json({ error: "Enter a valid check-in and check-out date." }, { status: 400 });
    }
    if (!hasProductionDatabase()) return Response.json({ error: "Production availability is unavailable." }, { status: 503 });

    const [settingsRecord] = await productionSql()<Array<{ value: StoredSettings | string }>>`
      select value from property_settings
      where property_id=${session.propertyId}::uuid and key='application_settings'
      limit 1
    `;
    const settings = settingsValue(settingsRecord?.value) ?? {};
    const roomTypes = (settings.roomTypes ?? []).filter((roomType) => roomType.active !== false);
    const activeRateCodes = (settings.rateCodes ?? []).filter((rateCode) => rateCode.active !== false);
    const selectedRateCode = parsed.data.rateCode
      ? activeRateCodes.find((rateCode) => rateCode.name === parsed.data.rateCode)
      : activeRateCodes.find((rateCode) => rateCode.isAvailabilityDefault) ?? activeRateCodes[0];
    if (parsed.data.rateCode && !selectedRateCode) return Response.json({ error: "Select an active rate code." }, { status: 409 });

    const availableRooms = await productionSql()<Array<{ number: string; roomTypeName: string }>>`
      select r.number,rt.name as "roomTypeName"
      from rooms r
      join room_types rt on rt.id=r.room_type_id
      where r.property_id=${session.propertyId}::uuid
        and r.active=true and r.service_status='rentable'
        and not exists (
          select 1 from reservation_rooms rr
          join reservations rs on rs.id=rr.reservation_id
          where rr.room_id=r.id and rr.status in ('reserved','checked_in')
            and rs.status in ('reserved','checked_in')
            and rs.arrival_date < ${parsed.data.checkout}::date
            and rs.departure_date > ${parsed.data.checkIn}::date
        )
        and not exists (
          select 1 from maintenance_orders mo
          where mo.room_id=r.id and mo.rentable=false and mo.status not in ('resolved','cancelled')
            and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockFrom')::date else null end < ${parsed.data.checkout}::date
            and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockTo')::date else null end >= ${parsed.data.checkIn}::date
        )
      order by r.number
    `;
    // Unassigned bookings hold room-type inventory without a specific room.
    const unassigned = await productionSql()<Array<{ roomTypeName: string; count: number }>>`
      select rt.name as "roomTypeName",count(*)::int as count
      from reservation_rooms rr
      join reservations rs on rs.id=rr.reservation_id
      join room_types rt on rt.id=rr.room_type_id
      where rr.property_id=${session.propertyId}::uuid and rr.room_id is null
        and rr.status in ('reserved','checked_in') and rs.status in ('reserved','checked_in')
        and rs.arrival_date < ${parsed.data.checkout}::date and rs.departure_date > ${parsed.data.checkIn}::date
      group by rt.name
    `;
    // Smoking/non-smoking variants share a database type name, so assign
    // rooms to a variant by the room's configured Settings type, and count
    // each unassigned booking against only one variant.
    const configuredTypeByRoom = new Map((settings.rooms ?? []).map((room) => [room.number, room.roomTypeId]));
    const unassignedLeft = new Map(unassigned.map((item) => [item.roomTypeName, item.count]));
    const nights = Math.round((new Date(`${parsed.data.checkout}T12:00:00Z`).getTime() - new Date(`${parsed.data.checkIn}T12:00:00Z`).getTime()) / 86_400_000);
    const taxPercentage = Math.max(0, settings.tax?.percentage ?? 0);
    return Response.json({
      checkIn: parsed.data.checkIn,
      checkout: parsed.data.checkout,
      nights,
      rateCode: selectedRateCode?.name ?? null,
      roomTypes: roomTypes.map((roomType) => {
        const rateCents = calculateAvailabilityRateCents(roomType, selectedRateCode, parsed.data.adults, parsed.data.children);
        const roomRentCents = rateCents * nights;
        const taxCents = Math.round(roomRentCents * taxPercentage / 100);
        const availableRoomNumbers = availableRooms
          .filter((room) => configuredTypeByRoom.has(room.number) ? configuredTypeByRoom.get(room.number) === roomType.id : room.roomTypeName === roomType.name)
          .map((room) => room.number);
        const unassignedHere = Math.min(availableRoomNumbers.length, unassignedLeft.get(roomType.name) ?? 0);
        unassignedLeft.set(roomType.name, (unassignedLeft.get(roomType.name) ?? 0) - unassignedHere);
        return {
          roomTypeId: roomType.id,
          name: roomType.name,
          shortLabel: roomType.shortLabel || roomType.name.slice(0, 4).toUpperCase(),
          availableRoomNumbers,
          roomCount: availableRoomNumbers.length - unassignedHere,
          nightlyRateCents: rateCents,
          roomRentCents,
          taxCents,
          totalCents: roomRentCents + taxCents,
        };
      }),
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
