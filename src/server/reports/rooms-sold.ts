import type { Sql } from "postgres";

/**
 * Rooms sold, the one definition every report, the Revenue page and the
 * Dashboard use (so ADR, occupancy and RevPAR agree everywhere):
 *
 * - a room on a stay that is reserved, in house or checked out (not
 *   cancelled, not a no-show), counted per room on the stay;
 * - for each night the stay covers (arrival ≤ night < departure), whether
 *   or not a room number has been assigned yet;
 * - a guest who checked out early stops counting from the day they left
 *   (their first night still counts);
 * - a day-use stay (arrives and leaves the same day) counts on its day,
 *   separately, so it does not take a night of overnight inventory.
 *
 * Both fragments are correlated subqueries on a `day` column from
 * generate_series(…) as days(day).
 */
function activeRoom(sql: Sql, propertyId: string) {
  return sql`r.property_id = ${propertyId}::uuid
    and rr.status in ('reserved', 'checked_in', 'checked_out')
    and r.status not in ('cancelled', 'no_show')`;
}

export function overnightRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${activeRoom(sql, propertyId)}
      and r.arrival_date <= day::date and r.departure_date > day::date
      and (rr.checked_out_at is null
        or r.arrival_date = day::date
        or (rr.checked_out_at at time zone coalesce((select timezone from properties where id = ${propertyId}::uuid), 'UTC'))::date > day::date)
  ), 0)::int`;
}

export function dayUseRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${activeRoom(sql, propertyId)}
      and r.arrival_date = day::date and r.departure_date = day::date
  ), 0)::int`;
}

/** Overnight plus day-use rooms sold for the day. */
export function roomsSoldSql(sql: Sql, propertyId: string) {
  return sql`(${overnightRoomsSoldSql(sql, propertyId)} + ${dayUseRoomsSoldSql(sql, propertyId)})`;
}
