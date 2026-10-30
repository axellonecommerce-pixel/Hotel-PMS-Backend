import type { TransactionSql } from "postgres";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { grossPayCents, payForPeriod, salaryForPeriod, splitWorkedMinutes, workweekBounds, type PayChange, type WorkDay } from "@/server/payroll/pay-calculation";

const PAYROLL_PAYMENT_METHODS = ["Cash", "Check", "Direct deposit", "Other"] as const;
const updateSchema = z.union([
  // Checked first. The status update below is strict, so a request with
  // invalid hours is refused instead of being read as a status change.
  // Hours typed in for a pay period the time clock did not record (for
  // example before the employee was set up); null goes back to the clock.
  z.object({
    action: z.literal("hours"),
    id: z.string().uuid(),
    hours: z.object({
      regularMinutes: z.number().int().min(0).max(744 * 60),
      overtimeMinutes: z.number().int().min(0).max(744 * 60),
      doubleTimeMinutes: z.number().int().min(0).max(744 * 60),
    }).nullable(),
  }),
  z.object({
    id: z.string().uuid(),
    status: z.enum(["Pending", "Approved", "Paid"]).optional(),
    adjustmentCents: z.number().int().min(-10_000_000).max(10_000_000).optional(),
    paymentMethod: z.enum(PAYROLL_PAYMENT_METHODS).optional(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict(),
  // Pay setup: hourly (rate × clocked hours) or a fixed salary per pay period.
  z.object({
    action: z.literal("employee"),
    employeeId: z.string().uuid(),
    payType: z.enum(["hourly", "salary"]),
    hourlyRateCents: z.number().int().min(0).max(100_000),
    salaryCents: z.number().int().min(0).max(10_000_000).optional(),
  }),
]);
type StoredPayroll = { payroll?: { frequency?: string }; property?: { state?: string }; employees?: Array<{ name?: string; payChanges?: PayChange[]; startDate?: string; payFrequency?: string }> };
const PAY_FREQUENCIES = ["Weekly", "Biweekly", "Semi-monthly", "Monthly"];

type ManualHours = { regularMinutes: number; overtimeMinutes: number; doubleTimeMinutes: number };
type EntryMeta = { adjustmentCents?: number; status?: string; doubleTimeMinutes?: number; manualHours?: ManualHours };
/** Back-dated start dates create pay periods up to this far back. */
const SCHEDULE_DAYS = 400;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ start: isoDate.optional(), end: isoDate.optional() }).refine((value) => {
  if (!value.start && !value.end) return true;
  if (!value.start || !value.end || value.end < value.start) return false;
  return (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000 <= 93;
});

function shiftDate(date: string, days: number) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function datesForPeriod(today: string, frequency: string) {
  const date = new Date(`${today}T12:00:00Z`);
  const ymd = (value: Date) => value.toISOString().slice(0, 10);
  if (frequency.toLowerCase().includes("semi")) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() <= 15 ? 1 : 16));
    const end = date.getUTCDate() <= 15 ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 15)) : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { start: ymd(start), end: ymd(end) };
  }
  // Checked after semi-monthly, whose name also contains "monthly".
  if (frequency.toLowerCase().includes("monthly")) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
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

function parseDescription(value: string | null): EntryMeta {
  try { const parsed = value ? JSON.parse(value) as unknown : {}; return parsed && typeof parsed === "object" ? parsed as EntryMeta : {}; }
  catch { return {}; }
}

type Employee = { id: string; name: string | null; role: string | null; hourlyRateCents: number | null; payType: string | null; salaryCents: number | null; active: boolean };
type Tx = TransactionSql<Record<string, never>>;

type PeriodRow = { id: string; start: string; end: string; status: string };
type PayrollSetup = {
  payChanges: Map<string, PayChange[]>;
  startDates: Map<string, string>;
  /** Each employee's own pay schedule (Settings › Employees, else the motel's). */
  frequencyOf: Map<string, string>;
  /** The period Payroll shows for each employee. */
  shownPeriodOf: Map<string, string>;
};
/** True when the period is one of the schedule's own periods (not a custom range or another schedule's). */
const onSchedule = (period: { start: string; end: string }, frequency: string) => {
  const dates = datesForPeriod(period.start, frequency);
  return dates.start === period.start && dates.end === period.end;
};
const nameKey = (name: string | null | undefined) => (name ?? "").trim().toLowerCase();

/**
 * Recount unpaid entries of the given periods from the time clock: regular,
 * overtime and double time by the property's state, or the fixed salary.
 * A paid entry keeps exactly what was paid, and hours typed in for a period
 * replace the time clock for it.
 *
 * Each employee is paid on their own pay schedule. With a start date
 * (Settings › Employees) they have every period of it from that date on and
 * nothing before it; without one, the period Payroll shows and periods where
 * they already have an entry. A custom date range counts for the employees
 * shown in it.
 */
async function recountPeriods(tx: Tx, propertyId: string, state: string, employees: Employee[], periods: PeriodRow[], setup: PayrollSetup) {
  if (!periods.length) return;
  const periodIds = periods.map((period) => period.id);
  const existing = await tx<Array<{ periodId: string; employeeId: string; description: string | null; paid: boolean }>>`
    select pay_period_id as "periodId",employee_id as "employeeId",description,paid from payroll_entries
    where property_id=${propertyId}::uuid and pay_period_id = any(${periodIds}::uuid[])
  `;
  const existingByKey = new Map(existing.map((entry) => [`${entry.periodId}|${entry.employeeId}`, entry]));
  const from = workweekBounds(periods.reduce((min, period) => period.start < min ? period.start : min, periods[0].start), periods[0].end).from;
  const to = workweekBounds(periods[0].start, periods.reduce((max, period) => period.end > max ? period.end : max, periods[0].end)).to;
  const worked = await tx<Array<{ employeeId: string; date: string; minutes: number }>>`
    select employee_id as "employeeId", work_date::text as date,
      sum(greatest(0,extract(epoch from (clock_out_at-clock_in_at))/60-break_minutes))::int as minutes
    from time_entries
    where property_id=${propertyId}::uuid and clock_out_at is not null and work_date between ${from}::date and ${to}::date
    group by 1,2
  `;
  const daysByEmployee = new Map<string, WorkDay[]>();
  for (const row of worked) daysByEmployee.set(row.employeeId, [...(daysByEmployee.get(row.employeeId) ?? []), { date: row.date, minutes: row.minutes }]);
  const notEmployedYet: Array<{ period: string; employee: string }> = [];
  const rows = periods.flatMap((period) => employees.flatMap((employee) => {
    const key = `${period.id}|${employee.id}`;
    const startDate = setup.startDates.get(nameKey(employee.name));
    const current = existingByKey.get(key);
    const shown = setup.shownPeriodOf.get(employee.id) === period.id;
    const meta = parseDescription(current?.description ?? null);
    // An untouched unpaid entry left from an earlier schedule is removed.
    const untouched = current && !current.paid && meta.status !== "Approved" && !meta.adjustmentCents && !meta.manualHours;
    let counted: boolean;
    if (startDate && startDate > period.end) counted = false;
    else if (period.status === "custom") counted = shown || Boolean(current);
    else if (!onSchedule(period, setup.frequencyOf.get(employee.id) ?? "Semi-monthly")) counted = false;
    else counted = shown || Boolean(startDate) || Boolean(current);
    if (!counted) {
      if (current && !current.paid && ((startDate && startDate > period.end) || (period.status !== "custom" && untouched))) notEmployedYet.push({ period: period.id, employee: employee.id });
      return [];
    }
    const pay = payForPeriod(employee, setup.payChanges.get(nameKey(employee.name)), period.start);
    const salaried = pay.payType === "salary";
    const split = splitWorkedMinutes(daysByEmployee.get(employee.id) ?? [], period.start, period.end, state);
    const rate = salaried ? pay.salary : pay.hourly;
    const manual = salaried ? undefined : meta.manualHours;
    // Salaried (exempt) staff are paid the same amount each pay period.
    const hours = salaried ? { regularMinutes: split.regularMinutes + split.overtimeMinutes + split.doubleTimeMinutes, overtimeMinutes: 0, doubleTimeMinutes: 0 } : manual ?? split;
    return [{
      period: period.id, employee: employee.id, type: salaried ? "salary" : "hourly", regular: hours.regularMinutes, overtime: hours.overtimeMinutes,
      double: hours.doubleTimeMinutes, rate, gross: salaried ? salaryForPeriod(rate, period.start, period.end, startDate) : grossPayCents(hours, rate),
    }];
  }));
  // A start date moved later, or a changed pay schedule, removes unpaid pay that no longer applies.
  if (notEmployedYet.length) await tx`
    delete from payroll_entries pe using jsonb_to_recordset(${tx.json(notEmployedYet)}) as x(period uuid,employee uuid)
    where pe.property_id=${propertyId}::uuid and pe.pay_period_id=x.period and pe.employee_id=x.employee and pe.paid=false
  `;
  if (!rows.length) return;
  await tx`
    insert into payroll_entries (property_id,pay_period_id,employee_id,calculation_type,regular_minutes,overtime_minutes,rate_cents,description,gross_pay_cents,paid)
    select ${propertyId}::uuid,x.period,x.employee,x.type,x.regular,x.overtime,x.rate,
      jsonb_build_object('adjustmentCents',0,'status','Pending','doubleTimeMinutes',x.double)::text,x.gross,false
    from jsonb_to_recordset(${tx.json(rows)}) as x(period uuid,employee uuid,type text,regular int,overtime int,double int,rate int,gross int)
    on conflict (pay_period_id,employee_id) do update set calculation_type=excluded.calculation_type,regular_minutes=excluded.regular_minutes,
      overtime_minutes=excluded.overtime_minutes,rate_cents=excluded.rate_cents,gross_pay_cents=excluded.gross_pay_cents,
      description=((case when payroll_entries.description ~ '^\s*\{' then payroll_entries.description else '{}' end)::jsonb || jsonb_build_object('doubleTimeMinutes',(excluded.description::jsonb)->'doubleTimeMinutes'))::text,
      updated_at=now()
    where payroll_entries.paid=false
  `;
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    if (!hasProductionDatabase()) return Response.json({ employees: [], entries: [], history: [] });
    const params = new URL(request.url).searchParams;
    const parsedRange = rangeSchema.safeParse({ start: params.get("startDate") ?? undefined, end: params.get("endDate") ?? undefined });
    if (!parsedRange.success) return Response.json({ error: "Choose a payroll date range of up to 93 days." }, { status: 400 });
    const range = parsedRange.data.start && parsedRange.data.end ? { start: parsedRange.data.start, end: parsedRange.data.end } : null;
    const result = await productionSql().begin(async (tx) => {
      const [configured] = await tx<Array<{ value: StoredPayroll; region: string | null }>>`
        select ps.value,p.region from properties p
        left join property_settings ps on ps.property_id=p.id and ps.key='application_settings'
        where p.id=${session.propertyId}::uuid
      `;
      // The screen sends the schedule it shows, so a change applies before Settings finishes saving.
      const requested = params.get("frequency") ?? "";
      const frequency = ["Weekly", "Biweekly", "Semi-monthly", "Monthly"].includes(requested) ? requested : configured?.value?.payroll?.frequency ?? "Semi-monthly";
      // Overtime follows the state the property is registered in.
      const state = configured?.value?.property?.state || configured?.region || "";
      const today = await propertyBusinessDate(tx, session.propertyId);
      const currentDates = datesForPeriod(today, frequency);
      const previousDates = datesForPeriod(shiftDate(currentDates.start, -1), frequency);
      const sameDates = (one: { start: string; end: string }, two: { start: string; end: string }) => one.start === two.start && one.end === two.end;
      // Staff can run payroll for any dates; This period / Last period show
      // each employee's own current or last period.
      const mode = !range || sameDates(range, currentDates) ? "current" : sameDates(range, previousDates) ? "previous" : "custom";
      // Keep inactive employees in this response too. Their historical pay
      // entries remain part of payroll and omitting them leaves the frontend
      // with an entry whose employee cannot be resolved.
      // Payroll is for the people added under Settings › Employees. A staff
      // sign-in (Users & Roles) also has an employee record; it is left out
      // unless the same person is added as an employee.
      const settingsEmployees = Array.isArray(configured?.value?.employees) ? configured.value.employees : [];
      const payrollNames = settingsEmployees.map((employee) => nameKey(employee?.name)).filter(Boolean);
      const employees = await tx<Employee[]>`
        select id,name,job_role as role,hourly_rate_cents as "hourlyRateCents",pay_method as "payType",fixed_rate_cents as "salaryCents",active
        from employees where property_id=${session.propertyId}::uuid
          and (membership_id is null or lower(name) = any(${payrollNames}::text[]))
        order by active desc,name
      `;
      const payrollIds = employees.map((employee) => employee.id);
      const settingsByName = new Map(settingsEmployees.filter((employee) => employee?.name).map((employee) => [nameKey(employee.name), employee] as const));
      const payChanges = new Map([...settingsByName].filter(([, employee]) => Array.isArray(employee.payChanges)).map(([name, employee]) => [name, employee.payChanges!] as const));
      const startDates = new Map([...settingsByName]
        .filter(([, employee]) => typeof employee.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(employee.startDate))
        .map(([name, employee]) => [name, employee.startDate!] as const));
      const frequencyOf = new Map(employees.map((employee) => {
        const own = settingsByName.get(nameKey(employee.name))?.payFrequency;
        return [employee.id, own && PAY_FREQUENCIES.includes(own) ? own : frequency] as const;
      }));
      const scheduleFrom = shiftDate(today, -SCHEDULE_DAYS);
      // Every pay period needed: the motel's current and last period, the
      // custom range, and for each employee their own current and last period
      // and, from a start date before that, every period since (back pay).
      const wanted = new Map<string, { start: string; end: string; payDate: string; status: string }>();
      const want = (dates: { start: string; end: string }, status = "open") => {
        const key = `${dates.start}|${dates.end}`;
        if (!wanted.has(key)) wanted.set(key, { ...dates, payDate: shiftDate(dates.end, 3), status });
      };
      want(currentDates); want(previousDates);
      if (mode === "custom" && range) want(range, "custom");
      const shownDates = new Map<string, { start: string; end: string }>();
      for (const employee of employees) {
        const employeeFrequency = frequencyOf.get(employee.id)!;
        const current = datesForPeriod(today, employeeFrequency);
        const previous = datesForPeriod(shiftDate(current.start, -1), employeeFrequency);
        want(current); want(previous);
        shownDates.set(employee.id, mode === "custom" && range ? range : mode === "previous" ? previous : current);
        const startDate = startDates.get(nameKey(employee.name));
        if (startDate && startDate < current.start) {
          for (let dates = previous; dates.end >= startDate && dates.end >= scheduleFrom; dates = datesForPeriod(shiftDate(dates.start, -1), employeeFrequency)) want(dates);
        }
      }
      const periodRows = await tx<Array<PeriodRow & { payDate: string }>>`
        insert into pay_periods (property_id,starts_on,ends_on,scheduled_pay_date,status)
        select ${session.propertyId}::uuid,x.start,x."end",x."payDate",x.status from jsonb_to_recordset(${tx.json([...wanted.values()])}) as x(start date,"end" date,"payDate" date,status text)
        on conflict (property_id,starts_on,ends_on) do update set scheduled_pay_date=excluded.scheduled_pay_date
        returning id,starts_on::text as start,ends_on::text as end,scheduled_pay_date::text as "payDate",status
      `;
      const periodAt = (dates: { start: string; end: string }) => periodRows.find((row) => sameDates(row, dates))!;
      const period = periodAt(mode === "custom" && range ? range : mode === "previous" ? previousDates : currentDates);
      const shownPeriodOf = new Map([...shownDates].map(([employeeId, dates]) => [employeeId, periodAt(dates).id] as const));
      const shownIds = [...new Set([period.id, ...shownPeriodOf.values()])];
      // Earlier periods with unpaid entries are recounted too, so time
      // entered after a period ended is included.
      const openPeriods = await tx<PeriodRow[]>`
        select pp.id,pp.starts_on::text as start,pp.ends_on::text as end,pp.status from pay_periods pp
        where pp.property_id=${session.propertyId}::uuid and pp.ends_on >= ${scheduleFrom}::date
          and not (pp.id = any(${periodRows.map((row) => row.id)}::uuid[]))
          and exists (select 1 from payroll_entries pe where pe.pay_period_id=pp.id and pe.paid=false)
      `;
      await recountPeriods(tx, session.propertyId, state, employees, [...periodRows, ...openPeriods], { payChanges, startDates, frequencyOf, shownPeriodOf });
      type EntryRow = { id: string; employeeId: string; regularMinutes: number; overtimeMinutes: number; hourlyRateCents: number | null; grossPayCents: number; calculationType: string; description: string | null; paid: boolean; paidOn: string | null; paymentMethod: string | null; periodId: string; startsOn: string; endsOn: string; payDate: string; roomsCleaned: number };
      // The pay schedule: every pay period of the last ~13 months, with what
      // is paid and what is still to pay. A custom date range only stays once
      // it is approved or paid; empty pay shows only for employees with a
      // start date (back pay still to enter) or the periods shown.
      const startedIds = employees.filter((employee) => startDates.has(nameKey(employee.name))).map((employee) => employee.id);
      const history = await tx<EntryRow[]>`
        select pe.id,pe.employee_id as "employeeId",pe.regular_minutes as "regularMinutes",pe.overtime_minutes as "overtimeMinutes",pe.rate_cents as "hourlyRateCents",
          pe.gross_pay_cents as "grossPayCents",pe.calculation_type as "calculationType",pe.description,pe.paid,pe.paid_on::text as "paidOn",pe.payment_method as "paymentMethod",
          pe.pay_period_id as "periodId",pp.starts_on::text as "startsOn",pp.ends_on::text as "endsOn",pp.scheduled_pay_date::text as "payDate",
          (select count(*) from housekeeping_records h where h.property_id=pe.property_id and h.housekeeper_employee_id=pe.employee_id
            and h.assignment_status='completed' and h.service_date between pp.starts_on and pp.ends_on)::int as "roomsCleaned"
        from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id join employees e on e.id=pe.employee_id
        where pe.property_id=${session.propertyId}::uuid and (pp.ends_on >= ${scheduleFrom}::date or pp.id = any(${shownIds}::uuid[]))
          and (pp.id = any(${shownIds}::uuid[]) or pp.status<>'custom' or pe.paid or pe.description like '%"Approved"%')
          and (pe.paid or (pe.employee_id = any(${payrollIds}::uuid[])
            and (pp.id = any(${shownIds}::uuid[]) or pe.gross_pay_cents<>0 or pe.regular_minutes<>0 or pe.employee_id = any(${startedIds}::uuid[]))))
        order by pp.ends_on desc,e.name limit 1000
      `;
      // The period table: each employee's shown period (paid staff who are no
      // longer on payroll still show in the motel's period).
      const entries = history.filter((entry) => shownPeriodOf.has(entry.employeeId) ? shownPeriodOf.get(entry.employeeId) === entry.periodId : entry.periodId === period.id);
      const mapEntry = (entry: EntryRow) => {
        const meta = parseDescription(entry.description);
        return {
          id: entry.id, payrollPeriodId: entry.periodId, employeeId: entry.employeeId, regularMinutes: entry.regularMinutes,
          overtimeMinutes: entry.overtimeMinutes ?? 0, doubleTimeMinutes: meta.doubleTimeMinutes ?? 0, payType: entry.calculationType === "salary" ? "salary" : "hourly",
          hourlyRateCents: entry.hourlyRateCents ?? 0, grossPayCents: entry.grossPayCents ?? 0, adjustmentCents: meta.adjustmentCents ?? 0,
          paymentStatus: entry.paid ? "Paid" : meta.status === "Approved" ? "Approved" : "Pending", paidOn: entry.paidOn, paymentMethod: entry.paymentMethod,
          hoursEntered: Boolean(meta.manualHours), roomsCleaned: Number(entry.roomsCleaned),
          periodLabel: `${entry.startsOn} to ${entry.endsOn}`, periodStart: entry.startsOn, periodEnd: entry.endsOn, payDate: entry.payDate,
        };
      };
      return {
        frequency,
        state,
        period: { id: period.id, label: `${period.start} to ${period.end}`, startDate: period.start, endDate: period.end, payDate: period.payDate },
        currentPeriod: currentDates,
        previousPeriod: previousDates,
        employees: employees.map((employee) => {
          const role = employee.role?.toLowerCase() ?? "";
          return {
            id: employee.id,
            hourlyRateCents: employee.hourlyRateCents ?? 0,
            payType: employee.payType === "salary" ? "salary" : "hourly",
            salaryCents: employee.salaryCents ?? 0,
            jobTitle: employee.role ?? "",
            name: employee.name?.trim() || "Unnamed employee",
            // Titles vary ("Owner/Admin", "General Manager").
            role: /housekeep/.test(role) ? "Housekeeper" : /(^|[^a-z])(manager|owner)([^a-z]|$)/.test(role) ? "Manager" : "Other Employee",
            status: employee.active ? "Active" : "Inactive",
            payFrequency: frequencyOf.get(employee.id),
          };
        }),
        entries: entries.map(mapEntry),
        history: history.map(mapEntry),
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
    const input = parsed.data;
    if ("action" in input && input.action === "hours") {
      const hours = input.hours;
      const result = await productionSql().begin(async (tx) => {
        const [current] = await tx<Array<{ description: string | null; paid: boolean; calculationType: string; rateCents: number | null }>>`
          select description,paid,calculation_type as "calculationType",rate_cents as "rateCents" from payroll_entries
          where id=${input.id}::uuid and property_id=${session.propertyId}::uuid for update
        `;
        if (!current) return "missing" as const;
        if (current.paid) return "paid" as const;
        if (current.calculationType === "salary") return "salary" as const;
        const meta = parseDescription(current.description);
        const description = { ...meta, manualHours: hours ?? undefined, doubleTimeMinutes: hours?.doubleTimeMinutes ?? meta.doubleTimeMinutes ?? 0 };
        // With hours typed in, pay is worked out now; back to the time clock,
        // the next payroll load recounts it.
        if (hours) await tx`
          update payroll_entries set regular_minutes=${hours.regularMinutes},overtime_minutes=${hours.overtimeMinutes},
            gross_pay_cents=${grossPayCents(hours, current.rateCents ?? 0)},description=${tx.json(description)}::text,updated_at=now()
          where id=${input.id}::uuid and property_id=${session.propertyId}::uuid
        `;
        else await tx`update payroll_entries set description=${tx.json(description)}::text,updated_at=now() where id=${input.id}::uuid and property_id=${session.propertyId}::uuid`;
        return "updated" as const;
      });
      if (result === "missing") return Response.json({ error: "Payroll entry not found." }, { status: 404 });
      if (result === "paid") return Response.json({ error: "This pay is already marked paid. Mark it Pending to change the hours." }, { status: 409 });
      if (result === "salary") return Response.json({ error: "Salary pay does not depend on hours." }, { status: 400 });
      return Response.json({ updated: true });
    }
    if ("action" in input) {
      if (input.payType === "salary" && !input.salaryCents) return Response.json({ error: "Enter the salary paid each pay period." }, { status: 400 });
      if (input.payType === "hourly" && !input.hourlyRateCents) return Response.json({ error: "Enter the hourly rate." }, { status: 400 });
      const saved = await productionSql().begin(async (tx) => {
        const [employee] = await tx<Array<{ name: string }>>`
          update employees set pay_method=${input.payType},hourly_rate_cents=${input.hourlyRateCents},fixed_rate_cents=${input.payType === "salary" ? input.salaryCents ?? 0 : null},updated_at=now()
          where id=${input.employeeId}::uuid and property_id=${session.propertyId}::uuid returning name
        `;
        if (!employee) return false;
        // Settings keeps its own employee list and writes the rate back on
        // save; keep it in step so the new pay is not overwritten.
        await tx`
          update property_settings set value=jsonb_set(value,'{employees}',(
            select coalesce(jsonb_agg(case when lower(item->>'name')=lower(${employee.name})
              then item || jsonb_build_object('hourlyRateCents',${input.hourlyRateCents}::int,'payType',${input.payType}::text,'salaryCents',${input.salaryCents ?? 0}::int)
              else item end),'[]'::jsonb) from jsonb_array_elements(value->'employees') item)),updated_at=now()
          where property_id=${session.propertyId}::uuid and key='application_settings' and jsonb_typeof(value->'employees')='array'
        `;
        return true;
      });
      if (!saved) return Response.json({ error: "Employee not found." }, { status: 404 });
      return Response.json({ updated: true });
    }
    const updated = await productionSql().begin(async (tx) => {
      const [current] = await tx<Array<{ description: string | null; paid: boolean; paidOn: string | null; paymentMethod: string | null }>>`
        select description,paid,paid_on::text as "paidOn",payment_method as "paymentMethod" from payroll_entries
        where id=${input.id}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!current) return "missing" as const;
      const meta = parseDescription(current.description);
      const status = input.status ?? (current.paid ? "Paid" : meta.status === "Approved" ? "Approved" : "Pending");
      if (current.paid && input.adjustmentCents !== undefined && input.adjustmentCents !== (meta.adjustmentCents ?? 0)) return "paid" as const;
      const paid = status === "Paid";
      const paymentMethod = paid ? input.paymentMethod ?? current.paymentMethod ?? "Cash" : null;
      const paidOn = paid ? input.paidOn ?? current.paidOn ?? await propertyBusinessDate(tx, session.propertyId) : null;
      const description = { ...meta, adjustmentCents: input.adjustmentCents ?? meta.adjustmentCents ?? 0, status };
      await tx`
        update payroll_entries set paid=${paid},paid_on=${paidOn}::date,payment_method=${paymentMethod},description=${tx.json(description)}::text,updated_at=now()
        where id=${input.id}::uuid and property_id=${session.propertyId}::uuid
      `;
      return "updated" as const;
    });
    if (updated === "missing") return Response.json({ error: "Payroll entry not found." }, { status: 404 });
    if (updated === "paid") return Response.json({ error: "This pay is already marked paid. Mark it Pending to change the adjustment." }, { status: 409 });
    return Response.json({ updated: true });
  } catch (error) { return propertyAccessResponse(error); }
}
