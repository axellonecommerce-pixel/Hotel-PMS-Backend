import type { TransactionSql } from "postgres";

import { postProductionLedger } from "@/server/finance/production-finance";

type Tx = TransactionSql<Record<string, never>>;

/**
 * A no-show is a financial release, not only an operational status. Keep the
 * original room-rent charges for audit, remove them from the active folio,
 * and post the matching reversal before the business day is closed.
 */
async function releaseUnarrivedReservations(tx: Tx, propertyId: string, businessDate: string) {
  const reservations = await tx<Array<{ id: string }>>`
    select id from reservations
    where property_id=${propertyId}::uuid and status='reserved'
      and arrival_date=${businessDate}::date
    for update
  `;
  for (const reservation of reservations) {
    const rooms = await tx<Array<{ id: string }>>`
      select id from reservation_rooms
      where reservation_id=${reservation.id}::uuid and property_id=${propertyId}::uuid
      for update
    `;
    const roomRentCharges = await tx<Array<{ id: string; serviceDate: string; amountCents: number; taxCents: number }>>`
      select c.id,c.service_date::text as "serviceDate",c.amount_cents as "amountCents",
        coalesce(ct.amount_cents,0)::int as "taxCents"
      from charges c
      join folios f on f.id=c.folio_id
      left join charge_taxes ct on ct.charge_id=c.id
      where f.reservation_id=${reservation.id}::uuid and c.property_id=${propertyId}::uuid
        and c.type='Room Rent' and c.status='posted'
      for update of c
    `;
    if (roomRentCharges.length) {
      await tx`
        update charges set status='voided',updated_at=now()
        where id in ${tx(roomRentCharges.map((charge) => charge.id))}
          and property_id=${propertyId}::uuid
      `;
    }
    for (const charge of roomRentCharges) {
      if (charge.amountCents > 0) await postProductionLedger(tx, {
        propertyId,
        businessDate,
        resourceType: "night-audit-no-show",
        resourceId: reservation.id,
        description: `Night-audit no-show room-rent reversal · ${charge.serviceDate}`,
        debitAccount: "Room Revenue",
        creditAccount: "Guest Receivable",
        amountCents: charge.amountCents,
      });
      if (charge.taxCents > 0) await postProductionLedger(tx, {
        propertyId,
        businessDate,
        resourceType: "night-audit-no-show-tax",
        resourceId: reservation.id,
        description: `Night-audit no-show room-tax reversal · ${charge.serviceDate}`,
        debitAccount: "Tax Payable",
        creditAccount: "Guest Receivable",
        amountCents: charge.taxCents,
      });
    }
    if (rooms.length) await tx`
      delete from nightly_rates
      where property_id=${propertyId}::uuid
        and reservation_room_id in ${tx(rooms.map((room) => room.id))}
    `;
    await tx`
      update reservation_rooms set status='no_show',updated_at=now()
      where reservation_id=${reservation.id}::uuid and property_id=${propertyId}::uuid
    `;
    await tx`
      update reservations set status='no_show',version=version+1,updated_at=now()
      where id=${reservation.id}::uuid and property_id=${propertyId}::uuid
    `;
  }
  return reservations.length;
}

export async function runNightAudit(tx: Tx, input: { propertyId: string; trigger: "manual" | "scheduled"; employeeId?: string | null }) {
  await tx`select pg_advisory_xact_lock(hashtext(${`night-audit:${input.propertyId}`}))`;
  const [day] = await tx<Array<{ id: string; businessDate: string }>>`
    select id,business_date::text as "businessDate" from business_days
    where property_id=${input.propertyId}::uuid and status='open'
    order by business_date limit 1 for update
  `;
  if (!day) throw new Error("There is no open business day.");
  const [counts] = await tx<Array<{ unpaidDepartures: number; unpaidInHouse: number; unresolvedDeposits: number; openCashShifts: number; operationalIssues: number }>>`
    select
      (select count(distinct r.id) from reservations r
        join reservation_rooms rr on rr.reservation_id=r.id
        where r.property_id=${input.propertyId}::uuid and r.company_id is null
          and rr.status='checked_in' and r.departure_date<=${day.businessDate}::date
          and exists (
            select 1 from folios f where f.reservation_id=r.id
              and (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
                - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0)) <> 0
          ))::int as "unpaidDepartures",
      (select count(distinct r.id) from reservations r
        join reservation_rooms rr on rr.reservation_id=r.id
        where r.property_id=${input.propertyId}::uuid and rr.status='checked_in'
          and exists (
            select 1 from folios f where f.reservation_id=r.id
              and (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
                - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0)) <> 0
          ))::int as "unpaidInHouse",
      (select count(*) from security_deposits d where d.property_id=${input.propertyId}::uuid
        and d.amount_cents > coalesce((select sum(dt.amount_cents) from deposit_transactions dt where dt.deposit_id=d.id and dt.type in ('release','charge')),0))::int as "unresolvedDeposits",
      (select count(*) from cash_shifts where property_id=${input.propertyId}::uuid and status='open')::int as "openCashShifts",
      (select count(*) from maintenance_orders where property_id=${input.propertyId}::uuid and status not in ('completed','cancelled') and priority='critical')::int as "operationalIssues"
  `;
  const blockers: string[] = [];
  if (counts.unpaidDepartures) blockers.push("UNPAID_DEPARTURES");
  if (counts.unpaidInHouse) blockers.push("UNPAID_IN_HOUSE_FOLIOS");
  if (counts.unresolvedDeposits) blockers.push("UNRESOLVED_DEPOSITS");
  if (counts.openCashShifts) blockers.push("OPEN_CASH_SHIFTS");
  if (counts.operationalIssues) blockers.push("OPERATIONAL_ISSUES");
  const [run] = await tx<Array<{ id: string }>>`
    insert into night_audit_runs (property_id,business_day_id,trigger,status,blocking_issues,initiated_by_employee_id)
    values (${input.propertyId}::uuid,${day.id}::uuid,${input.trigger},${blockers.length ? "failed" : "completed"},${tx.json(blockers)},${input.employeeId ?? null}::uuid)
    returning id
  `;
  if (blockers.length) {
    await tx`update night_audit_runs set completed_at=now() where id=${run.id}::uuid`;
    await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
      values (${input.propertyId}::uuid,'manager','NIGHT_AUDIT_FAILED','Night Audit needs attention',${`Resolve: ${blockers.join(", ")}`},'night_audit_run',${run.id}::uuid)`;
    return { runId: run.id, status: "failed" as const, businessDate: day.businessDate, blockers };
  }
  // Reservations that were due to arrive today but never checked in are
  // closed as no-shows before the business day advances. Their rent and tax
  // must be reversed at the same time so they do not remain in Revenue or a
  // guest folio after disappearing from Arrivals.
  await releaseUnarrivedReservations(tx, input.propertyId, day.businessDate);
  await tx`update business_days set status='closed',closed_at=now() where id=${day.id}::uuid`;
  await tx`
    insert into business_days (property_id,business_date,status,opened_at)
    values (${input.propertyId}::uuid,(${day.businessDate}::date+1)::date,'open',now())
    on conflict (property_id,business_date) do update set status='open',opened_at=coalesce(business_days.opened_at,excluded.opened_at),closed_at=null
  `;
  await tx`update night_audit_runs set completed_at=now() where id=${run.id}::uuid`;
  return { runId: run.id, status: "completed" as const, businessDate: day.businessDate, blockers };
}
