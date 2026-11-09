import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql<Record<string, never>>;

export type OpenBalance = { reservationId: string; confirmationNumber: string; guest: string; status: string; departureDate: string; balanceCents: number };

/**
 * Reservations that are finished (checked out, no-show or cancelled) but
 * whose folio still has a balance: a guest who still owes money, or money
 * owed back (for example a refund given without adjusting the charges).
 * Company stays are billed on the company invoice and are left out.
 */
export async function pastReservationsWithBalance(db: Db, propertyId: string) {
  return db<OpenBalance[]>`
    select * from (
      select r.id as "reservationId", r.confirmation_number as "confirmationNumber",
        g.first_name||' '||g.last_name as guest, r.status, r.departure_date::text as "departureDate",
        (coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0))
            from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0))::int as "balanceCents"
      from reservations r join guests g on g.id=r.main_guest_id
      where r.property_id=${propertyId}::uuid and r.company_id is null and r.status in ('checked_out','no_show','cancelled')
    ) open where "balanceCents" <> 0
    order by "departureDate" desc
    limit 200
  `;
}
