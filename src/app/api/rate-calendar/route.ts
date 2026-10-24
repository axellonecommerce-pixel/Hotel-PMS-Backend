import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { addDays } from "@/server/rates/rate-calendar";
import { recordChange } from "@/server/realtime/change-events";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ startDate: date, endDate: date });
const updateSchema = z.object({
  roomTypeIds: z.array(z.string().trim().min(1)).min(1).max(50),
  startDate: date,
  endDate: date,
  // 0 = Sunday … 6 = Saturday. Empty means every day.
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  // undefined leaves a field unchanged; null clears it.
  rateCents: z.number().int().nonnegative().nullable().optional(),
  minStay: z.number().int().min(1).max(60).nullable().optional(),
  closed: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = rangeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || parsed.data.startDate > parsed.data.endDate) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    const days = await productionSql()<Array<{ roomTypeId: string; stayDate: string; rateCents: number | null; minStay: number | null; closed: boolean }>>`
      select room_type_id as "roomTypeId", stay_date::text as "stayDate", rate_cents as "rateCents", min_stay as "minStay", closed
      from rate_calendar
      where property_id=${session.propertyId}::uuid and stay_date between ${parsed.data.startDate}::date and ${parsed.data.endDate}::date
      order by stay_date, room_type_id
    `;
    return Response.json({ days });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Choose room types, dates, and a rate or restriction to set." }, { status: 400 });
    const input = parsed.data;
    if (input.startDate > input.endDate) return Response.json({ error: "The end date must be on or after the start date." }, { status: 400 });
    if (input.rateCents === undefined && input.minStay === undefined && input.closed === undefined) {
      return Response.json({ error: "Set a rate, a minimum stay, or open/close the dates." }, { status: 400 });
    }
    const dates: string[] = [];
    for (let day = input.startDate; day <= input.endDate; day = addDays(day, 1)) {
      if (!input.weekdays.length || input.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) dates.push(day);
      if (dates.length > 400) return Response.json({ error: "Update at most 400 days at a time." }, { status: 400 });
    }
    if (!dates.length) return Response.json({ error: "No dates in that range match the selected weekdays." }, { status: 400 });
    const rows = input.roomTypeIds.flatMap((roomTypeId) => dates.map((stayDate) => ({ room_type_id: roomTypeId, stay_date: stayDate })));
    const setRate = input.rateCents !== undefined;
    const setMinStay = input.minStay !== undefined;
    const setClosed = input.closed !== undefined;
    await productionSql().begin(async (tx) => {
      await tx`
        insert into rate_calendar (property_id, room_type_id, stay_date, rate_cents, min_stay, closed)
        select ${session.propertyId}::uuid, x.room_type_id, x.stay_date::date,
          ${setRate ? input.rateCents ?? null : null}::int, ${setMinStay ? input.minStay ?? null : null}::int, ${input.closed ?? false}
        from jsonb_to_recordset(${tx.json(rows)}) as x(room_type_id text, stay_date text)
        on conflict (property_id, room_type_id, stay_date) do update set
          rate_cents = case when ${setRate} then excluded.rate_cents else rate_calendar.rate_cents end,
          min_stay = case when ${setMinStay} then excluded.min_stay else rate_calendar.min_stay end,
          closed = case when ${setClosed} then excluded.closed else rate_calendar.closed end,
          updated_at = now()
      `;
      // A day with no override, restriction, or closure is the same as no row.
      await tx`delete from rate_calendar where property_id=${session.propertyId}::uuid and rate_cents is null and min_stay is null and closed=false`;
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "settings", entityId: session.propertyId, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: { source: "rate-calendar" } });
    return Response.json({ updatedDays: rows.length });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
