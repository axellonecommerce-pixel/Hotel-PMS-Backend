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
    // One row per day per housekeeper (several clock-ins on a day are added
    // together; rooms cleaned are counted once per day). The report's total
    // row adds up every day.
    const byDay = new Map<string, { date: string; employee: string; minutes: number; rooms: number; cost: number }>();
    records.forEach((record) => {
      const key = `${record.workDate}|${record.employee}`;
      const current = byDay.get(key) ?? { date: record.workDate, employee: record.employee, minutes: 0, rooms: record.roomsCleaned, cost: 0 };
      current.minutes += record.paidMinutes; current.cost += Math.round(record.paidMinutes * record.hourlyRateCents / 60);
      byDay.set(key, current);
    });
    const rows = [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date) || left.employee.localeCompare(right.employee)).map((value) => ({
      id: `${value.date}|${value.employee}`, date: value.date, employee: value.employee, hours: minutesToHours(value.minutes), rooms: value.rooms, cost: value.cost,
      roomsPerHour: value.minutes ? Math.round(value.rooms / (value.minutes / 60) * 10) / 10 : 0,
      costPerRoom: value.rooms ? Math.round(value.cost / value.rooms) : 0,
    }));
    const totalRooms = rows.reduce((sum, row) => sum + row.rooms, 0);
    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const totalMinutes = records.reduce((sum, record) => sum + record.paidMinutes, 0);
    return Response.json({ report: {
      metrics: [
        { label: "Housekeepers", value: new Set(rows.map((row) => row.employee)).size, format: "number" },
        { label: "Rooms Cleaned", value: totalRooms, format: "number" },
        { label: "Labor Hours", value: minutesToHours(totalMinutes), format: "hours" },
        { label: "Labor Cost", value: totalCost, format: "money" },
        { label: "Cost / Room", value: totalRooms ? Math.round(totalCost / totalRooms) : 0, format: "money" },
      ],
      columns: [
        { key: "date", label: "Date", format: "date" }, { key: "employee", label: "Housekeeper" }, { key: "hours", label: "Paid Hours", format: "hours", align: "right" },
        { key: "rooms", label: "Rooms Cleaned", format: "number", align: "right" }, { key: "roomsPerHour", label: "Rooms / Hour", align: "right" },
        { key: "cost", label: "Labor Cost", format: "money", align: "right" },
        { key: "costPerRoom", label: "Cost / Room", format: "money", align: "right" },
      ],
      rows,
      note: "One row per day for each housekeeper, with the total at the bottom. Productivity uses completed housekeeping assignments matched to completed time entries on the same day.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
