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

/** One line of what a night audit did, shown on the Night Audit page. */
export type NightAuditStep = { step: string; detail: string; status: "done" | "blocked" | "info" };

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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
  const steps: NightAuditStep[] = [{
    step: "Checked blockers",
    detail: blockers.length ? `Blocked: ${blockers.join(", ")}` : "No unpaid departures, unresolved deposits, or critical maintenance.",
    status: blockers.length ? "blocked" : "done",
  }];
  if (blockers.length) {
    await tx`update night_audit_runs set completed_at=now(),summary=${tx.json(steps)} where id=${run.id}::uuid`;
    await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
      values (${input.propertyId}::uuid,'manager','NIGHT_AUDIT_FAILED','Night Audit needs attention',${`Resolve: ${blockers.join(", ")}`},'night_audit_run',${run.id}::uuid)`;
    return { runId: run.id, status: "failed" as const, businessDate: day.businessDate, blockers, steps };
  }
  // Reservations that were due to arrive today but never checked in are
  // closed as no-shows before the business day advances. Their rent and tax
  // must be reversed at the same time so they do not remain in Revenue or a
  // guest folio after disappearing from Arrivals.
  const noShows = await releaseUnarrivedReservations(tx, input.propertyId, day.businessDate);
  steps.push({ step: "Processed no-shows", detail: noShows ? `${noShows} unarrived reservation${noShows === 1 ? "" : "s"} marked No Show; their room nights were reversed.` : "Every arrival was checked in or cancelled.", status: noShows ? "done" : "info" });
  // The day's room charges and other posted charges are closed with the day.
  const [revenue] = await tx<Array<{ nights: number; rentCents: number; taxCents: number; extraCount: number; extraCents: number; paymentCents: number }>>`
    select
      count(*) filter (where c.type='Room Rent')::int as nights,
      coalesce(sum(c.amount_cents) filter (where c.type='Room Rent'),0)::int as "rentCents",
      coalesce(sum((select coalesce(sum(ct.amount_cents),0) from charge_taxes ct where ct.charge_id=c.id)) filter (where c.type='Room Rent'),0)::int as "taxCents",
      count(*) filter (where c.type<>'Room Rent')::int as "extraCount",
      coalesce(sum(c.amount_cents) filter (where c.type<>'Room Rent'),0)::int as "extraCents",
      coalesce((select sum(p.amount_cents) from payments p where p.property_id=${input.propertyId}::uuid and p.effective_date=${day.businessDate}::date and upper(p.method) not in ('OTA COMMISSION','DIRECT BILL')),0)::int as "paymentCents"
    from charges c
    where c.property_id=${input.propertyId}::uuid and c.service_date=${day.businessDate}::date and c.status='posted'
  `;
  steps.push({ step: "Posted room charges", detail: `${revenue.nights} room night${revenue.nights === 1 ? "" : "s"} for ${day.businessDate}: room rent ${usd(revenue.rentCents)} + tax ${usd(revenue.taxCents)}.`, status: "done" });
  steps.push({ step: "Posted extra charges", detail: revenue.extraCount ? `${revenue.extraCount} extra charge${revenue.extraCount === 1 ? "" : "s"} totaling ${usd(revenue.extraCents)}.` : "No extra charges today.", status: revenue.extraCount ? "done" : "info" });
  steps.push({ step: "Payments for the day", detail: `${usd(revenue.paymentCents)} collected on ${day.businessDate}.`, status: "info" });
  // Every occupied room (stay-over or due out) needs service tomorrow.
  const dirtied = await tx<Array<{ number: string }>>`
    update rooms r set cleanliness_status='dirty',updated_at=now()
    where r.property_id=${input.propertyId}::uuid and r.cleanliness_status<>'dirty'
      and exists (select 1 from reservation_rooms rr join reservations rs on rs.id=rr.reservation_id
        where rr.room_id=r.id and rr.status='checked_in' and rs.status='checked_in')
    returning r.number
  `;
  const occupiedRooms = dirtied.map((room) => room.number).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  steps.push({ step: "Marked occupied rooms dirty", detail: occupiedRooms.length ? `Rooms ${occupiedRooms.join(", ")} need service.` : "All occupied rooms were already marked for service.", status: "done" });
  const [due] = await tx<Array<{ departures: number; arrivals: number }>>`
    select
      count(*) filter (where status='checked_in' and departure_date=(${day.businessDate}::date+1))::int as departures,
      count(*) filter (where status='reserved' and arrival_date=(${day.businessDate}::date+1))::int as arrivals
    from reservations where property_id=${input.propertyId}::uuid
  `;
  steps.push({ step: "Prepared the next day", detail: `${due.departures} departure${due.departures === 1 ? "" : "s"} and ${due.arrivals} arrival${due.arrivals === 1 ? "" : "s"} due tomorrow.`, status: "info" });
  await tx`update business_days set status='closed',closed_at=now() where id=${day.id}::uuid`;
  await tx`
    insert into business_days (property_id,business_date,status,opened_at)
    values (${input.propertyId}::uuid,(${day.businessDate}::date+1)::date,'open',now())
    on conflict (property_id,business_date) do update set status='open',opened_at=coalesce(business_days.opened_at,excluded.opened_at),closed_at=null
  `;
  steps.push({ step: "Closed the business day", detail: `${day.businessDate} is closed. The new business day has started.`, status: "done" });
  await tx`update night_audit_runs set completed_at=now(),summary=${tx.json(steps)} where id=${run.id}::uuid`;
  return { runId: run.id, status: "completed" as const, businessDate: day.businessDate, blockers, steps };
}

/**
 * When the scheduled audit for a business day is due, in the hotel's time
 * zone: a morning time (before noon) belongs to the next calendar day, an
 * evening time to the business day itself.
 */
export function nightAuditDue(input: { businessDate: string; time: string; timezone: string; now?: Date }) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(input.now ?? new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const localTime = `${part("hour")}:${part("minute")}`;
  const next = new Date(`${input.businessDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dueDate = input.time < "12:00" ? next.toISOString().slice(0, 10) : input.businessDate;
  return localDate > dueDate || (localDate === dueDate && localTime >= input.time);
}
