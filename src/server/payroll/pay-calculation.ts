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

/**
 * Split worked minutes for the days inside [start, end]. Workweeks run Monday
 * to Sunday (the same weeks as weekly pay periods) and weekly overtime counts the whole week, so `days` should
 * include the days of the first and last week that fall outside the period.
 */
export function splitWorkedMinutes(days: WorkDay[], start: string, end: string, state: string): PaySplit {
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
    // Monday-start workweek (day 0, 1970-01-01, was a Thursday).
    const week = Math.floor((dayNumber(date) + 3) / 7);
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

/** The Monday on or before `start`, and the Sunday on or after `end`. */
export function workweekBounds(start: string, end: string) {
  const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * 86_400_000 + 43_200_000).toISOString().slice(0, 10);
  const weekday = (date: string) => (dayNumber(date) + 3) % 7;
  return { from: shift(start, -weekday(start)), to: shift(end, 6 - weekday(end)) };
}
