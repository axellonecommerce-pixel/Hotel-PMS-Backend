import type { Sql } from "postgres";

/**
 * Rooms sold and their room revenue, by the industry rules (USALI / STR, as
 * Opera and Cloudbeds report them): the one definition behind occupancy, ADR
 * and RevPAR everywhere (Dashboard, Revenue page, Revenue & Performance,
 * Occupancy, Final Audit), so they always agree.
 *
 * Rooms sold = paid overnight rooms in house: a room on a stay that is
 * checked in or has checked out, for each night it covered (check-in ≤ night
 * < check-out) and was charged room rent above $0. A guest who left early
 * stops counting from the day they left (the first night counts).
 *
 * Not rooms sold (shown on their own lines instead):
 * - day use (in and out the same day): its rent is room revenue;
 * - no-shows: a No-show Fee is room revenue, the room is not occupied;
 * - complimentary rooms ($0 rent);
 * - bookings that have not arrived yet and cancellations.
 *
 * Room revenue for ADR and RevPAR = posted room rent of stays that arrived
 * (overnight and day use, dated that day) plus No-show Fees, before tax.
 * ADR = room revenue ÷ rooms sold; RevPAR = room revenue ÷ rentable rooms.
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

/** Room rent above $0 posted to this room for the night. */
const paidNight = (sql: Sql) => sql`exists (select 1 from charges c join folios f on f.id = c.folio_id
  where f.reservation_id = r.id and (c.reservation_room_id = rr.id or c.reservation_room_id is null)
    and c.type = 'Room Rent' and c.status = 'posted' and c.service_date = day::date and c.amount_cents > 0)`;

function inHouseOvernight(sql: Sql, propertyId: string) {
  return sql`${usedRoom(sql, propertyId)}
      and r.arrival_date <= day::date and r.departure_date > day::date
      and ${leftEarlyAfter(sql, propertyId)}`;
}

/** Paid overnight rooms in house: the industry "rooms sold". */
export function overnightRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${inHouseOvernight(sql, propertyId)} and ${paidNight(sql)}
  ), 0)::int`;
}

/** Complimentary rooms: in house overnight with no room rent above $0. */
export function compRoomsSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${inHouseOvernight(sql, propertyId)} and not ${paidNight(sql)}
  ), 0)::int`;
}

/** Day-use rooms (in and out the same day). Not rooms sold; their rent is room revenue. */
export function dayUseRoomsSoldSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where ${usedRoom(sql, propertyId)}
      and r.arrival_date = day::date and r.departure_date = day::date
  ), 0)::int`;
}

/** No-shows charged a No-show Fee, on their arrival date. Not rooms sold; the fee is room revenue. */
export function chargedNoShowRoomsSql(sql: Sql, propertyId: string) {
  return sql`coalesce((select count(*) from reservation_rooms rr join reservations r on r.id = rr.reservation_id
    where r.property_id = ${propertyId}::uuid and r.status = 'no_show' and r.arrival_date = day::date
      and exists (select 1 from charges c join folios f on f.id = c.folio_id
        where f.reservation_id = r.id and c.type = 'No-show Fee' and c.status = 'posted' and c.amount_cents > 0)
  ), 0)::int`;
}

/** Rooms sold for the day (industry rule: paid overnight rooms in house). */
export function roomsSoldSql(sql: Sql, propertyId: string) {
  return overnightRoomsSoldSql(sql, propertyId);
}

/** Room revenue for ADR/RevPAR for the day: room rent of stays that arrived (overnight + day use) plus No-show Fees, before tax. */
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
