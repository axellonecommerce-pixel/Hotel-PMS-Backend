import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { addDays } from "@/server/rates/rate-calendar";

// HotelKey "Managing Preventative Maintenance": recurring tasks (AC filters,
// pest control, smoke detector tests) with a frequency and next due date.
// Marking one done moves its next due date forward by the frequency.
const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  roomNumber: z.string().trim().max(20).optional(),
  frequencyDays: z.number().int().min(1).max(730),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional(),
});
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), id: z.string().uuid(), doneBy: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("deactivate"), id: z.string().uuid() }),
]);

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    const sql = productionSql();
    const today = await propertyBusinessDate(sql, session.propertyId);
    const schedules = await sql<Array<Record<string, unknown>>>`
      select id, title, room_number as "roomNumber", frequency_days as "frequencyDays", next_due_date::text as "nextDueDate",
        last_done_date::text as "lastDoneDate", last_done_by as "lastDoneBy", notes,
        (next_due_date - ${today}::date)::int as "daysUntilDue"
      from maintenance_schedules where property_id=${session.propertyId}::uuid and active
      order by next_due_date, title
    `;
    return Response.json({ schedules, today });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter a task, how often it repeats, and when it is next due." }, { status: 400 });
    const input = parsed.data;
    const sql = productionSql();
    if (input.roomNumber) {
      const [room] = await sql`select 1 from rooms where property_id=${session.propertyId}::uuid and number=${input.roomNumber}`;
      if (!room) return Response.json({ error: `Room ${input.roomNumber} does not exist.` }, { status: 400 });
    }
    const [created] = await sql<Array<{ id: string }>>`
      insert into maintenance_schedules (property_id, title, room_number, frequency_days, next_due_date, notes)
      values (${session.propertyId}::uuid, ${input.title}, ${input.roomNumber || null}, ${input.frequencyDays}, ${input.nextDueDate}::date, ${input.notes ?? null})
      returning id
    `;
    return Response.json({ id: created.id }, { status: 201 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter who completed the task." }, { status: 400 });
    const sql = productionSql();
    if (parsed.data.action === "deactivate") {
      await sql`update maintenance_schedules set active=false, updated_at=now() where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid`;
      return Response.json({ id: parsed.data.id, active: false });
    }
    const today = await propertyBusinessDate(sql, session.propertyId);
    const [schedule] = await sql<Array<{ frequencyDays: number; nextDueDate: string }>>`
      select frequency_days as "frequencyDays", next_due_date::text as "nextDueDate" from maintenance_schedules
      where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid and active
    `;
    if (!schedule) return Response.json({ error: "Scheduled task not found." }, { status: 404 });
    // The next visit is counted from when the work was actually done.
    const nextDueDate = addDays(today, schedule.frequencyDays);
    await sql`
      update maintenance_schedules set last_done_date=${today}::date, last_done_by=${parsed.data.doneBy}, next_due_date=${nextDueDate}::date, updated_at=now()
      where id=${parsed.data.id}::uuid
    `;
    return Response.json({ id: parsed.data.id, lastDoneDate: today, nextDueDate });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
