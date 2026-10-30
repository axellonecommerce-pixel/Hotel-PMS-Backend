// Gross pay for a pay period: hours from the time clock, split into regular,
// overtime (1.5×) and double time (2×) by the property's state rules, or a
// fixed amount per pay period for salaried staff.

/** States with daily overtime; every state also pays 1.5× over 40 hours a week (FLSA). */
const DAILY_OVERTIME: Record<string, { after: number; doubleAfter?: number }> = {
  CA: { after: 8 * 60, doubleAfter: 12 * 60 },
  AK: { after: 8 * 60 },
  NV: { after: 8 * 60 },
  CO: { after: 12 * 60 },
};

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** "California", "CA" or "ca" → "CA"; anything else → "". */
export function stateCode(value: string | null | undefined) {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return "";
  if (STATE_CODES[text]) return STATE_CODES[text];
  const upper = text.toUpperCase();
  return Object.values(STATE_CODES).includes(upper) ? upper : "";
}

export type WorkDay = { date: string; minutes: number };
export type PaySplit = { regularMinutes: number; overtimeMinutes: number; doubleTimeMinutes: number };

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
/** Days since the workweek started (0–6). `weekStart`: 0 Sunday … 6 Saturday; day 0 (1970-01-01) was a Thursday. */
const daysIntoWeek = (date: string, weekStart: number) => (((dayNumber(date) + 4 - weekStart) % 7) + 7) % 7;

/**
 * Split worked minutes for the days inside [start, end]. Workweeks start on
 * `weekStart` (0 Sunday … 6 Saturday, Monday by default), the same weeks as
 * weekly pay periods, and weekly overtime counts the whole week, so `days`
 * should include the days of the first and last week that fall outside the period.
 */
export function splitWorkedMinutes(days: WorkDay[], start: string, end: string, state: string, weekStart = 1): PaySplit {
  const daily = DAILY_OVERTIME[stateCode(state)];
  const byDate = new Map<string, number>();
  for (const day of days) byDate.set(day.date, (byDate.get(day.date) ?? 0) + Math.max(0, day.minutes));
  const result: PaySplit = { regularMinutes: 0, overtimeMinutes: 0, doubleTimeMinutes: 0 };
  const weekRegular = new Map<number, number>();
  for (const date of [...byDate.keys()].sort()) {
    const minutes = byDate.get(date)!;
    let regular = minutes;
    let overtime = 0;
    let doubleTime = 0;
    if (daily) {
      const doubleAfter = daily.doubleAfter ?? Infinity;
      doubleTime = Math.max(0, minutes - doubleAfter);
      overtime = Math.max(0, Math.min(minutes, doubleAfter) - daily.after);
      regular = minutes - overtime - doubleTime;
    }
    const week = Math.floor((dayNumber(date) - daysIntoWeek(date, weekStart)) / 7);
    const before = weekRegular.get(week) ?? 0;
    const weeklyOvertime = Math.max(0, before + regular - 40 * 60) - Math.max(0, before - 40 * 60);
    regular -= weeklyOvertime;
    overtime += weeklyOvertime;
    weekRegular.set(week, before + regular + weeklyOvertime);
    if (date < start || date > end) continue;
    result.regularMinutes += regular;
    result.overtimeMinutes += overtime;
    result.doubleTimeMinutes += doubleTime;
  }
  return result;
}

export function grossPayCents(split: PaySplit, rateCents: number) {
  return Math.round((split.regularMinutes * rateCents + split.overtimeMinutes * rateCents * 1.5 + split.doubleTimeMinutes * rateCents * 2) / 60);
}

/** The first day of the workweek holding `start`, and the last day of the one holding `end`. */
export function workweekBounds(start: string, end: string, weekStart = 1) {
  const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * 86_400_000 + 43_200_000).toISOString().slice(0, 10);
  return { from: shift(start, -daysIntoWeek(start, weekStart)), to: shift(end, 6 - daysIntoWeek(end, weekStart)) };
}

export type PayChange = { effectiveDate?: string; payType?: string; fromHourlyCents?: number; toHourlyCents?: number; fromSalaryCents?: number; toSalaryCents?: number };

/**
 * The pay in force for a period: the latest pay increase dated on or before
 * the period's first day, or (before the first increase) the pay it replaced.
 * With no increases recorded, the employee's current pay.
 */
export function payForPeriod(employee: { payType: string | null; hourlyRateCents: number | null; salaryCents: number | null }, changes: PayChange[] | undefined, periodStart: string) {
  const dated = (changes ?? []).filter((change) => typeof change.effectiveDate === "string").sort((a, b) => a.effectiveDate!.localeCompare(b.effectiveDate!));
  const current = { payType: employee.payType === "salary" ? "salary" : "hourly", hourly: employee.hourlyRateCents ?? 0, salary: employee.salaryCents ?? 0 };
  if (!dated.length) return current;
  const applied = [...dated].reverse().find((change) => change.effectiveDate! <= periodStart);
  if (applied) return { payType: applied.payType === "salary" ? "salary" : applied.payType === "hourly" ? "hourly" : current.payType, hourly: applied.toHourlyCents ?? current.hourly, salary: applied.toSalaryCents ?? current.salary };
  const first = dated[0];
  return { payType: current.payType, hourly: first.fromHourlyCents ?? current.hourly, salary: first.fromSalaryCents ?? current.salary };
}

/**
 * Salary for one pay period. A period that starts before the employee's
 * start date pays only the days from the start date on, by calendar days.
 */
export function salaryForPeriod(salaryCents: number, periodStart: string, periodEnd: string, startDate?: string) {
  if (!startDate || startDate <= periodStart) return salaryCents;
  if (startDate > periodEnd) return 0;
  const periodDays = dayNumber(periodEnd) - dayNumber(periodStart) + 1;
  return Math.round(salaryCents * (dayNumber(periodEnd) - dayNumber(startDate) + 1) / periodDays);
}
