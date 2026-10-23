import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const entrySchema = z.object({
  employeeName: z.string().trim().min(1).max(200),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clockIn: timeSchema,
  clockOut: timeSchema.optional(),
  breakStart: timeSchema.optional(),
  breakEnd: timeSchema.optional(),
  breakMinutes: z.number().int().min(0).max(24 * 60),
  correctionNote: z.string().trim().max(1_000).optional(),
});

type EntryRow = { id: string; workDate: string; employeeName: string; clockIn: string; clockOut: string | null; breakStart: string | null; breakEnd: string | null; breakMinutes: number; hourlyRateCents: number | null };

async function listEntries(propertyId: string) {
  return productionSql()<EntryRow[]>`
    select te.id,te.work_date::text as "workDate",e.name as "employeeName",
      to_char(te.clock_in_at at time zone 'America/Los_Angeles','HH24:MI') as "clockIn",
      case when te.clock_out_at is null then null else to_char(te.clock_out_at at time zone 'America/Los_Angeles','HH24:MI') end as "clockOut",
      case when te.break_start_at is null then null else to_char(te.break_start_at at time zone 'America/Los_Angeles','HH24:MI') end as "breakStart",
      case when te.break_end_at is null then null else to_char(te.break_end_at at time zone 'America/Los_Angeles','HH24:MI') end as "breakEnd",
      te.break_minutes as "breakMinutes",e.hourly_rate_cents as "hourlyRateCents"
    from time_entries te join employees e on e.id=te.employee_id
    where te.property_id=${propertyId}::uuid
    order by te.work_date desc,te.clock_in_at desc
  `;
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    if (!hasProductionDatabase()) return Response.json({ entries: [] });
    return Response.json({ entries: await listEntries(session.propertyId) });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    const parsed = entrySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Time entry details are invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const input = parsed.data;
    if (input.clockOut && input.clockOut <= input.clockIn) return Response.json({ error: "Clock-out must be later than clock-in." }, { status: 400 });
    if ((input.breakStart || input.breakEnd) && (!input.breakStart || !input.breakEnd || input.breakEnd <= input.breakStart)) return Response.json({ error: "Break end must be later than break start." }, { status: 400 });
    const entry = await productionSql().begin(async (tx) => {
      const [employee] = await tx<Array<{ id: string }>>`
        select id from employees where property_id=${session.propertyId}::uuid and active=true and lower(name)=lower(${input.employeeName}) limit 1 for update
      `;
      if (!employee) return null;
      const [saved] = await tx<EntryRow[]>`
        insert into time_entries (property_id,employee_id,work_date,clock_in_at,clock_out_at,break_start_at,break_end_at,lunch_taken,break_minutes,correction_note)
        values (
          ${session.propertyId}::uuid,${employee.id}::uuid,${input.workDate},
          (${input.workDate}::date + ${input.clockIn}::time) at time zone 'America/Los_Angeles',
          case when ${input.clockOut ?? null}::text is null then null else (${input.workDate}::date + ${input.clockOut ?? null}::time) at time zone 'America/Los_Angeles' end,
          case when ${input.breakStart ?? null}::text is null then null else (${input.workDate}::date + ${input.breakStart ?? null}::time) at time zone 'America/Los_Angeles' end,
          case when ${input.breakEnd ?? null}::text is null then null else (${input.workDate}::date + ${input.breakEnd ?? null}::time) at time zone 'America/Los_Angeles' end,
          ${Boolean(input.breakStart && input.breakEnd)},${input.breakMinutes},${input.correctionNote ?? null}
        )
        on conflict (employee_id,work_date) do update set
          clock_in_at=excluded.clock_in_at,clock_out_at=excluded.clock_out_at,break_start_at=excluded.break_start_at,break_end_at=excluded.break_end_at,lunch_taken=excluded.lunch_taken,break_minutes=excluded.break_minutes,correction_note=excluded.correction_note
        returning id,work_date::text as "workDate",(select name from employees where id=employee_id) as "employeeName",
          to_char(clock_in_at at time zone 'America/Los_Angeles','HH24:MI') as "clockIn",
          case when clock_out_at is null then null else to_char(clock_out_at at time zone 'America/Los_Angeles','HH24:MI') end as "clockOut",
          case when break_start_at is null then null else to_char(break_start_at at time zone 'America/Los_Angeles','HH24:MI') end as "breakStart",
          case when break_end_at is null then null else to_char(break_end_at at time zone 'America/Los_Angeles','HH24:MI') end as "breakEnd",
          break_minutes as "breakMinutes",(select hourly_rate_cents from employees where id=employee_id) as "hourlyRateCents"
      `;
      return saved;
    });
    if (!entry) return Response.json({ error: "Select an active employee from this property." }, { status: 404 });
    return Response.json({ entry });
  } catch (error) { return propertyAccessResponse(error); }
}
