import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql<Record<string, never>>;

export type RateCalendarDay = { stayDate: string; rateCents: number | null; minStay: number | null; closed: boolean };

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Calendar entries for one Settings room type over [start, endExclusive). */
export async function rateCalendarDays(db: Db, propertyId: string, roomTypeId: string, start: string, endExclusive: string) {
  const rows = await db<RateCalendarDay[]>`
    select stay_date::text as "stayDate", rate_cents as "rateCents", min_stay as "minStay", closed
    from rate_calendar
    where property_id=${propertyId}::uuid and room_type_id=${roomTypeId}
      and stay_date >= ${start}::date and stay_date < ${endExclusive}::date
  `;
  return new Map(rows.map((row) => [row.stayDate, row]));
}

/**
 * HotelKey-style restrictions: a stay cannot include a closed night, and its
 * length must meet the minimum stay set for the arrival date. A day-use stay
 * (zero nights) is only checked for a closed date.
 */
export function rateCalendarRestriction(days: Map<string, RateCalendarDay>, checkIn: string, nights: number) {
  const span = Math.max(1, nights);
  for (let night = 0; night < span; night += 1) {
    const date = addDays(checkIn, night);
    if (days.get(date)?.closed) return `This room type is closed to bookings on ${date}.`;
  }
  const minStay = days.get(checkIn)?.minStay;
  if (nights > 0 && minStay && nights < minStay) return `Arrivals on ${checkIn} require a minimum stay of ${minStay} nights.`;
  return null;
}
