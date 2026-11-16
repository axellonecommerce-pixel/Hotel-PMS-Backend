/**
 * Which cleaned rooms belong to a housekeeper's time entry.
 *
 * A room cleaned during the shift (completed between clock-in and clock-out)
 * always counts for that shift, even when the Night Audit moved the business
 * date in the middle of the shift. Rooms whose cleaning time falls outside
 * every shift of that housekeeper (marked clean after clock-out, or entered by
 * hand) count for the shift on the same service date.
 *
 * `te` must be the time_entries alias in the outer query. Used with `unsafe`,
 * so it must stay free of user input.
 */
const shiftWindow = (alias: string) =>
  `h.completed_at between ${alias}.clock_in_at and coalesce(${alias}.clock_out_at, ${alias}.clock_in_at + interval '16 hours')`;

export const roomsCleanedWhere = (te = "te") => `
  h.property_id=${te}.property_id and h.housekeeper_employee_id=${te}.employee_id and h.assignment_status='completed'
  and (
    ${shiftWindow(te)}
    or (h.service_date=${te}.work_date and not exists (
      select 1 from time_entries other
      where other.employee_id=h.housekeeper_employee_id and other.id<>${te}.id and ${shiftWindow("other")}
    ))
  )`;

/** `count` and sorted room numbers of the rooms cleaned on a time entry. */
export const roomsCleanedCountSql = (te = "te") =>
  `coalesce((select count(*) from housekeeping_records h where ${roomsCleanedWhere(te)}),0)::int`;
export const roomsCleanedListSql = (te = "te") =>
  `coalesce((select array_agg(r.number order by r.number) from housekeeping_records h join rooms r on r.id=h.room_id where ${roomsCleanedWhere(te)}),'{}')`;
