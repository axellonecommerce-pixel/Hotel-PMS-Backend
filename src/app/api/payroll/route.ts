import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";

const updateSchema = z.object({ id: z.string().uuid(), status: z.enum(["Pending", "Approved", "Paid"]).optional(), adjustmentCents: z.number().int().min(-10_000_000).max(10_000_000).optional() });
type StoredPayroll = { payroll?: { frequency?: string } };

function datesForPeriod(today: string, frequency: string) {
  const date = new Date(`${today}T12:00:00Z`);
  const ymd = (value: Date) => value.toISOString().slice(0, 10);
  if (frequency.toLowerCase().includes("monthly")) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { start: ymd(start), end: ymd(end) };
  }
  if (frequency.toLowerCase().includes("semi")) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() <= 15 ? 1 : 16));
    const end = date.getUTCDate() <= 15 ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 15)) : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { start: ymd(start), end: ymd(end) };
  }
  const days = frequency.toLowerCase().includes("biweekly") ? 14 : 7;
  const epoch = Date.UTC(2000, 0, 3);
  const day = Math.floor(date.getTime() / 86_400_000);
  const offset = ((day - Math.floor(epoch / 86_400_000)) % days + days) % days;
  const start = new Date(date.getTime() - offset * 86_400_000);
  const end = new Date(start.getTime() + (days - 1) * 86_400_000);
  return { start: ymd(start), end: ymd(end) };
}

function parseDescription(value: string | null) {
  try { const parsed = value ? JSON.parse(value) as unknown : {}; return parsed && typeof parsed === "object" ? parsed as { adjustmentCents?: number; status?: string } : {}; }
  catch { return {}; }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    if (!hasProductionDatabase()) return Response.json({ employees: [], entries: [], history: [] });
    const result = await productionSql().begin(async (tx) => {
      const [configured] = await tx<Array<{ value: StoredPayroll }>>`select value from property_settings where property_id=${session.propertyId}::uuid and key='application_settings'`;
      const frequency = configured?.value?.payroll?.frequency ?? "Biweekly";
      const [businessDay] = await tx<Array<{ date: string }>>`select business_date::text as date from business_days where property_id=${session.propertyId}::uuid order by business_date desc limit 1`;
      const periodDates = datesForPeriod(businessDay?.date ?? new Date().toISOString().slice(0, 10), frequency);
      const payDate = new Date(`${periodDates.end}T12:00:00Z`); payDate.setUTCDate(payDate.getUTCDate() + 3);
      const [period] = await tx<Array<{ id: string; start: string; end: string; payDate: string; status: string }>>`
        insert into pay_periods (property_id,starts_on,ends_on,scheduled_pay_date,status)
        values (${session.propertyId}::uuid,${periodDates.start},${periodDates.end},${payDate.toISOString().slice(0,10)},'open')
        on conflict (property_id,starts_on,ends_on) do update set scheduled_pay_date=excluded.scheduled_pay_date
        returning id,starts_on::text as start,ends_on::text as end,scheduled_pay_date::text as "payDate",status
      `;
      // Keep inactive employees in this response too. Their historical pay
      // entries remain part of payroll and omitting them leaves the frontend
      // with an entry whose employee cannot be resolved.
      const employees = await tx<Array<{ id: string; name: string | null; role: string | null; hourlyRateCents: number | null; active: boolean }>>`
        select id,name,job_role as role,hourly_rate_cents as "hourlyRateCents",active from employees where property_id=${session.propertyId}::uuid order by active desc,name
      `;
      // One statement for every employee (was two round trips each, which
      // made Payroll take several seconds to open).
      await tx`
        insert into payroll_entries (property_id,pay_period_id,employee_id,calculation_type,regular_minutes,overtime_minutes,rate_cents,description,gross_pay_cents,paid)
        select ${session.propertyId}::uuid,${period.id}::uuid,e.id,'hourly',coalesce(t.minutes,0),0,coalesce(e.hourly_rate_cents,0),
          '{"adjustmentCents":0,"status":"Pending"}',round(coalesce(t.minutes,0)*coalesce(e.hourly_rate_cents,0)/60.0)::int,false
        from employees e
        left join lateral (
          select sum(greatest(0,extract(epoch from (te.clock_out_at-te.clock_in_at))/60-te.break_minutes))::int as minutes
          from time_entries te
          where te.property_id=e.property_id and te.employee_id=e.id and te.clock_out_at is not null
            and te.work_date between ${period.start}::date and ${period.end}::date
        ) t on true
        where e.property_id=${session.propertyId}::uuid
        on conflict (pay_period_id,employee_id) do update set regular_minutes=excluded.regular_minutes,rate_cents=excluded.rate_cents,gross_pay_cents=excluded.gross_pay_cents,updated_at=now()
        where payroll_entries.paid=false
      `;
      const entries = await tx<Array<{ id: string; employeeId: string; regularMinutes: number; hourlyRateCents: number | null; description: string | null; paid: boolean; periodId: string; roomsCleaned?: number }>>`
        select pe.id,pe.employee_id as "employeeId",pe.regular_minutes as "regularMinutes",pe.rate_cents as "hourlyRateCents",pe.description,pe.paid,pe.pay_period_id as "periodId",
          (select count(*) from housekeeping_records h where h.property_id=pe.property_id and h.housekeeper_employee_id=pe.employee_id
            and h.assignment_status='completed' and h.service_date between ${period.start}::date and ${period.end}::date)::int as "roomsCleaned"
        from payroll_entries pe where pe.property_id=${session.propertyId}::uuid and pe.pay_period_id=${period.id}::uuid order by pe.created_at
      `;
      const history = await tx<Array<{ id: string; employeeId: string; regularMinutes: number; hourlyRateCents: number | null; description: string | null; paid: boolean; periodId: string; startsOn: string; endsOn: string }>>`
        select pe.id,pe.employee_id as "employeeId",pe.regular_minutes as "regularMinutes",pe.rate_cents as "hourlyRateCents",pe.description,pe.paid,pe.pay_period_id as "periodId",pp.starts_on::text as "startsOn",pp.ends_on::text as "endsOn"
        from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id
        where pe.property_id=${session.propertyId}::uuid and pe.pay_period_id<>${period.id}::uuid order by pp.ends_on desc limit 100
      `;
      const mapEntry = (entry: typeof entries[number]) => { const meta = parseDescription(entry.description); return { id: entry.id, payrollPeriodId: entry.periodId, employeeId: entry.employeeId, regularMinutes: entry.regularMinutes, hourlyRateCents: entry.hourlyRateCents ?? 0, adjustmentCents: meta.adjustmentCents ?? 0, paymentStatus: entry.paid ? "Paid" : meta.status === "Approved" ? "Approved" : "Pending", ...("roomsCleaned" in entry ? { roomsCleaned: Number(entry.roomsCleaned) } : {}) }; };
      return {
        period: { id: period.id, label: `${period.start} to ${period.end}`, startDate: period.start, endDate: period.end, payDate: period.payDate },
        employees: employees.map((employee) => {
          const role = employee.role?.toLowerCase() ?? "";
          return {
            ...employee,
            name: employee.name?.trim() || "Unnamed employee",
            // Titles vary ("Owner/Admin", "General Manager").
            role: /housekeep/.test(role) ? "Housekeeper" : /(^|[^a-z])(manager|owner)([^a-z]|$)/.test(role) ? "Manager" : "Other Employee",
            status: employee.active ? "Active" : "Inactive",
          };
        }),
        entries: entries.map(mapEntry),
        history: history.map((entry) => ({ ...mapEntry(entry), periodLabel: `${entry.startsOn} to ${entry.endsOn}` })),
      };
    });
    return Response.json(result);
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Payroll update is invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const updated = await productionSql().begin(async (tx) => {
      const [current] = await tx<Array<{ description: string | null; paid: boolean }>>`select description,paid from payroll_entries where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!current) return false;
      const meta = parseDescription(current.description);
      const status = parsed.data.status ?? (current.paid ? "Paid" : meta.status === "Approved" ? "Approved" : "Pending");
      const adjustmentCents = parsed.data.adjustmentCents ?? meta.adjustmentCents ?? 0;
      await tx`update payroll_entries set paid=${status === "Paid"},paid_on=case when ${status === "Paid"} then ${await propertyBusinessDate(tx, session.propertyId)}::date else null end,description=${tx.json({ adjustmentCents, status })}::text,updated_at=now() where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid`;
      return true;
    });
    if (!updated) return Response.json({ error: "Payroll entry not found." }, { status: 404 });
    return Response.json({ updated: true });
  } catch (error) { return propertyAccessResponse(error); }
}
