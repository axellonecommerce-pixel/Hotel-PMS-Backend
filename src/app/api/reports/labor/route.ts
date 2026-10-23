import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  view: z.enum(["hours", "productivity"]),
});

type LaborRecord = {
  id: string; workDate: string; employee: string; hourlyRateCents: number; paidMinutes: number; roomsCleaned: number;
};

/** Read-only labor reports built from completed time and housekeeping records. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const records = await productionSql()<LaborRecord[]>`
      select te.id,te.work_date::text as "workDate",e.name as employee,coalesce(e.hourly_rate_cents,0) as "hourlyRateCents",
        greatest(0,round(extract(epoch from (te.clock_out_at-te.clock_in_at)) / 60)::int-te.break_minutes) as "paidMinutes",
        coalesce((select count(*) from housekeeping_records h
          where h.property_id=te.property_id and h.housekeeper_employee_id=te.employee_id
            and h.service_date=te.work_date and h.assignment_status='completed'),0)::int as "roomsCleaned"
      from time_entries te join employees e on e.id=te.employee_id
      where te.property_id=${session.propertyId}::uuid
        and te.work_date between ${input.data.startDate}::date and ${input.data.endDate}::date
        and te.clock_out_at is not null
      order by te.work_date desc,e.name
    `;
    const minutesToHours = (minutes: number) => Math.round(minutes * 100 / 60) / 100;
    if (input.data.view === "hours") {
      const paidMinutes = records.reduce((sum, record) => sum + record.paidMinutes, 0);
      return Response.json({ report: {
        metrics: [
          { label: "Completed Entries", value: records.length, format: "number" },
          { label: "Paid Hours", value: minutesToHours(paidMinutes), format: "hours" },
          { label: "Employees", value: new Set(records.map((record) => record.employee)).size, format: "number" },
          { label: "Labor Cost", value: records.reduce((sum, record) => sum + Math.round(record.paidMinutes * record.hourlyRateCents / 60), 0), format: "money" },
        ],
        columns: [
          { key: "date", label: "Work Date", format: "date" }, { key: "employee", label: "Employee" },
          { key: "hours", label: "Paid Hours", format: "hours", align: "right" }, { key: "rooms", label: "Rooms Cleaned", format: "number", align: "right" },
          { key: "cost", label: "Labor Cost", format: "money", align: "right" },
        ],
        rows: records.map((record) => ({ id: record.id, date: record.workDate, employee: record.employee, hours: minutesToHours(record.paidMinutes), rooms: record.roomsCleaned, cost: Math.round(record.paidMinutes * record.hourlyRateCents / 60) })),
        note: "Only completed clock-in/clock-out records are included. Open shifts are intentionally excluded from payroll-ready hours.",
      } });
    }
    const byEmployee = new Map<string, { minutes: number; rooms: number; cost: number }>();
    records.forEach((record) => {
      const current = byEmployee.get(record.employee) ?? { minutes: 0, rooms: 0, cost: 0 };
      current.minutes += record.paidMinutes; current.rooms += record.roomsCleaned; current.cost += Math.round(record.paidMinutes * record.hourlyRateCents / 60);
      byEmployee.set(record.employee, current);
    });
    const rows = [...byEmployee.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([employee, value]) => ({
      id: employee, employee, hours: minutesToHours(value.minutes), rooms: value.rooms, cost: value.cost,
      costPerRoom: value.rooms ? Math.round(value.cost / value.rooms) : 0,
    }));
    return Response.json({ report: {
      metrics: [
        { label: "Housekeepers", value: rows.length, format: "number" },
        { label: "Rooms Cleaned", value: rows.reduce((sum, row) => sum + row.rooms, 0), format: "number" },
        { label: "Labor Hours", value: minutesToHours(records.reduce((sum, record) => sum + record.paidMinutes, 0)), format: "hours" },
        { label: "Labor Cost", value: rows.reduce((sum, row) => sum + row.cost, 0), format: "money" },
      ],
      columns: [
        { key: "employee", label: "Housekeeper" }, { key: "hours", label: "Paid Hours", format: "hours", align: "right" },
        { key: "rooms", label: "Rooms Cleaned", format: "number", align: "right" }, { key: "cost", label: "Labor Cost", format: "money", align: "right" },
        { key: "costPerRoom", label: "Cost / Room", format: "money", align: "right" },
      ],
      rows,
      note: "Productivity uses completed housekeeping assignments matched to completed employee time entries in the selected range.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
