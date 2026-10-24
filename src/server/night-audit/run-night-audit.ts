import type { TransactionSql } from "postgres";

import { nightAuditBlockers } from "@/domain/rules/reservation-lifecycle";
import { postProductionLedger, reversalBusinessDate } from "@/server/finance/production-finance";
import { readReservationCommission, setReservationCommission } from "@/server/finance/ota-commission";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";

type Tx = TransactionSql<Record<string, never>>;

type ReleasedCharge = { id: string; serviceDate: string; amountCents: number; taxCents: number };
type ReleasedNightlyRate = { reservationRoomId: string; stayDate: string; baseRateCents: number; discountCents: number; finalRateCents: number };

function addNightAuditNoShowMetadata(
  notes: string | null,
  event: { roomRentCharges: ReleasedCharge[]; nightlyRates: ReleasedNightlyRate[]; commissionCents: number; at: string },
) {
  try {
    const parsed = notes ? JSON.parse(notes) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const current = parsed as Record<string, unknown>;
    const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
    return JSON.stringify({ ...current, lifecycleEvents: [...events, { action: "no-show", source: "night-audit", ...event }].slice(-20) });
  } catch {
    return `${notes?.trim() ?? ""}${notes?.trim() ? "\n" : ""}no-show by night audit on ${event.at}.`;
  }
}

/**
 * A no-show is a financial release, not only an operational status. Keep the
 * original room-rent charges for audit, remove them from the active folio,
 * and post the matching reversal before the business day is closed.
 */
async function releaseUnarrivedReservations(tx: Tx, propertyId: string, businessDate: string) {
  const reservations = await tx<Array<{ id: string; notes: string | null }>>`
    select id,notes from reservations
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
    const nightlyRates = rooms.length ? await tx<ReleasedNightlyRate[]>`
      select reservation_room_id as "reservationRoomId",stay_date::text as "stayDate",
        base_rate_cents as "baseRateCents",discount_cents as "discountCents",final_rate_cents as "finalRateCents"
      from nightly_rates
      where property_id=${propertyId}::uuid and reservation_room_id in ${tx(rooms.map((room) => room.id))}
      for update
    ` : [];
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
        businessDate: reversalBusinessDate(businessDate, charge.serviceDate),
        resourceType: "night-audit-no-show",
        resourceId: reservation.id,
        description: `Night-audit no-show room-rent reversal · ${charge.serviceDate}`,
        debitAccount: "Room Revenue",
        creditAccount: "Guest Receivable",
        amountCents: charge.amountCents,
      });
      if (charge.taxCents > 0) await postProductionLedger(tx, {
        propertyId,
        businessDate: reversalBusinessDate(businessDate, charge.serviceDate),
        resourceType: "night-audit-no-show-tax",
        resourceId: reservation.id,
        description: `Night-audit no-show room-tax reversal · ${charge.serviceDate}`,
        debitAccount: "Tax Payable",
        creditAccount: "Guest Receivable",
        amountCents: charge.taxCents,
      });
    }
    // Same as a manual No Show: an unpaid OTA commission (and the OTA's
    // settlement on the folio) is reversed; reinstatement restores it.
    const commission = await readReservationCommission(tx, propertyId, reservation.id);
    const commissionCents = commission.deducted || commission.paidCents === 0 ? commission.commissionCents : 0;
    if (commissionCents > 0) {
      await setReservationCommission(tx, { propertyId, reservationId: reservation.id, targetCents: 0, businessDate, reason: "Night-audit no-show commission reversal" });
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
      update reservations set status='no_show',notes=${addNightAuditNoShowMetadata(reservation.notes, { roomRentCharges, nightlyRates, commissionCents, at: new Date().toISOString() })},version=version+1,updated_at=now()
      where id=${reservation.id}::uuid and property_id=${propertyId}::uuid
    `;
    await logReservationActivity(tx, { propertyId, systemName: "Night Audit" }, reservation.id, "Status", `Marked No Show by Night Audit for ${businessDate} · ${roomRentCharges.length} room night(s) reversed${commissionCents > 0 ? ` · OTA commission ${money(commissionCents)} reversed` : ""}`);
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
  const [counts] = await tx<Array<{ unpaidDepartures: number; unresolvedDeposits: number; openCashShifts: number; operationalIssues: number }>>`
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

      -- As in HotelKey, in-house guests may carry a balance and a held deposit
      -- overnight; they must settle at checkout. Only stays that are due out
      -- (or already departed) with an open deposit block the audit.
      (select count(*) from security_deposits d
        join reservation_rooms rr on rr.id=d.reservation_room_id join reservations r on r.id=rr.reservation_id
        where d.property_id=${input.propertyId}::uuid
          and (rr.status='checked_out' or r.departure_date<=${day.businessDate}::date)
          and d.amount_cents > coalesce((select sum(dt.amount_cents) from deposit_transactions dt where dt.deposit_id=d.id and dt.type in ('release','charge')),0))::int as "unresolvedDeposits",
      -- Shifts are clerk sessions counted by time, not by business day, so the
      -- night clerk's open shift does not block the audit.
      0 as "openCashShifts",
      (select count(*) from maintenance_orders where property_id=${input.propertyId}::uuid and status not in ('completed','cancelled') and priority='critical')::int as "operationalIssues"
  `;
  const blockers = nightAuditBlockers({
    unpaidDepartureCount: counts.unpaidDepartures,
    unresolvedDepositCount: counts.unresolvedDeposits,
    openCashShiftCount: counts.openCashShifts,
    unresolvedOperationalIssueCount: counts.operationalIssues,
  });
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
