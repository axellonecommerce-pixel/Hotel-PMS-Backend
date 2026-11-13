import type { Sql } from "postgres";

/**
 * Rooms sold and their room revenue: the one definition behind occupancy,
 * ADR and RevPAR everywhere (Dashboard, Revenue page, Revenue & Performance,
 * Occupancy, Final Audit), so they always agree.
 *
 * A room counts for a night when it was really used or really charged:
 * - in house: a room on a stay that is checked in or has checked out, for
 *   each night it covered (check-in ≤ night < check-out); a guest who left
 *   early stops counting from the day they left (the first night counts);
 * - day use: a checked-in/out stay that arrived and left the same day,
 *   counted on that day (it does not take a night of overnight inventory);
 * - a charged no-show: a no-show with a posted No-show Fee, counted on its
 *   arrival date.
 * A booking that has not arrived yet, a cancellation, or a no-show without a
 * fee does not count.
 *
 * Room revenue for these figures is the posted room rent of the counted
 * nights plus the No-show Fees (before tax).
 *
 * Every fragment is a correlated subquery on a `day` column from
 * generate_series(…) as days(day).
 */
function usedRoom(sql: Sql, propertyId: string) {
  return sql`r.property_id = ${propertyId}::uuid
    and r.status in ('checked_in', 'checked_out')
    and rr.status in ('checked_in', 'checked_out')`;
}

const leftEarlyAfter = (sql: Sql, propertyId: string) => sql`(rr.checked_out_at is null
  or r.arrival_date = day::date
  or (rr.checked_out_at at time zone coalesce((select timezone from properties where id = ${propertyId}::uuid), 'UTC'))::date > day::date)`;

export function overnightRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${usedRoom(sql, propertyId)}
      and r.arrival_date <= day::date and r.departure_date > day::date
      and ${leftEarlyAfter(sql, propertyId)}
  ), 0)::int`;
}

export function dayUseRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${usedRoom(sql, propertyId)}
      and r.arrival_date = day::date and r.departure_date = day::date
  ), 0)::int`;
}

export function chargedNoShowRoomsSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where r.property_id = ${propertyId}::uuid and r.status = 'no_show' and r.arrival_date = day::date
      and exists (select 1 from charges c join folios f on f.id = c.folio_id
        where f.reservation_id = r.id and c.type = 'No-show Fee' and c.status = 'posted' and c.amount_cents > 0)
  ), 0)::int`;
}

/** Overnight, day-use and charged no-show rooms for the day. */
export function roomsSoldSql(sql: Sql, propertyId: string) {
  return sql`(${overnightRoomsSoldSql(sql, propertyId)} + ${dayUseRoomsSoldSql(sql, propertyId)} + ${chargedNoShowRoomsSql(sql, propertyId)})`;
}

/** Room revenue of the counted rooms for the day (room rent of used nights + No-show Fees), before tax. */
export function soldRoomRevenueSql(sql: Sql, propertyId: string) {
  return sql`(coalesce((select sum(c.amount_cents) from charges c join folios f on f.id = c.folio_id join reservations r on r.id = f.reservation_id
      where r.property_id = ${propertyId}::uuid and r.status in ('checked_in', 'checked_out')
        and c.type = 'Room Rent' and c.status = 'posted' and c.service_date = day::date), 0)
    + coalesce((select sum(c.amount_cents) from charges c join folios f on f.id = c.folio_id join reservations r on r.id = f.reservation_id
      where r.property_id = ${propertyId}::uuid and r.status = 'no_show' and r.arrival_date = day::date
        and c.type = 'No-show Fee' and c.status = 'posted'), 0))::int`;
}

/**
 * Rooms taken for the night for availability (not for occupancy): every
 * active booking, arrived or not, so future nights are not shown as free.
 */
export function bookedOvernightRoomsSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where r.property_id = ${propertyId}::uuid
      and rr.status in ('reserved', 'checked_in', 'checked_out') and r.status not in ('cancelled', 'no_show')
      and r.arrival_date <= day::date and r.departure_date > day::date
      and ${leftEarlyAfter(sql, propertyId)}
  ), 0)::int`;
}
