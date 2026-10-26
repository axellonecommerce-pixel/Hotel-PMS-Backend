import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

// Daily-use reports modelled on HotelKey's NextGen catalogue (Arrivals,
// Departures List, In House Guest Balances, Do Not Rent, Payment Activity,
// Tax Report, Direct Bill Aging, Trial Balance, Revenue by Room Type, Room
// Status). Money stays in cents; every query is tenant-scoped.
const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  view: z.enum([
    "arrivals", "departures", "in-house-balances", "do-not-rent", "payment-activity",
    "tax", "direct-bill-aging", "trial-balance", "revenue-by-room-type", "room-status", "paid-outs", "lost-and-found", "clerk-activity", "clerk-shift",
    "housekeeping-board", "room-reconciliation", "room-move", "vacant-rooms", "housekeeping-forecast",
  ]),
  // Housekeeping Board: one housekeeper (or all).
  housekeeper: z.string().trim().max(120).optional(),
});

type Column = { key: string; label: string; format?: "text" | "money" | "number" | "percent" | "date" | "status"; align?: "left" | "right" };
type Metric = { label: string; value: string | number; format?: "text" | "money" | "number" | "percent" };

const money = (key: string, label: string): Column => ({ key, label, format: "money", align: "right" });
const count = (key: string, label: string): Column => ({ key, label, format: "number", align: "right" });
const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const statusLabel = (value: string) => value.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const sql = productionSql();
    const propertyId = session.propertyId;
    const { startDate, endDate, view } = input.data;
    const respond = (metrics: Metric[], columns: Column[], rows: Array<Record<string, string | number>>, note?: string) =>
      Response.json({ report: { metrics, columns, rows, note } });

    // Folio balance for one reservation: posted charges + tax - allocations.
    const balance = sql`(
      coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)
      - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0))::int`;
    const roomList = sql`coalesce((select string_agg(coalesce(room.number,'Unassigned'), ', ' order by room.number) from reservation_rooms rr left join rooms room on room.id=rr.room_id where rr.reservation_id=r.id),'Unassigned')`;
    const roomTypes = sql`coalesce((select string_agg(distinct rt.name, ', ') from reservation_rooms rr join room_types rt on rt.id=rr.room_type_id where rr.reservation_id=r.id),'')`;

    if (view === "arrivals" || view === "departures") {
      const arrivals = view === "arrivals";
      const records = await sql<Array<{ id: string; date: string; confirmation: string; guest: string; rooms: string; roomType: string; nights: number; source: string; ratePlan: string; status: string; billTo: string; totalCents: number; balanceCents: number; checkInDate: string; departedTime: string; arCents: number }>>`
        select r.id, (case when ${arrivals} then r.arrival_date else r.departure_date end)::text as date, r.confirmation_number as confirmation,
          g.first_name||' '||g.last_name as guest, ${roomList} as rooms, ${roomTypes} as "roomType",
          (r.departure_date - r.arrival_date)::int as nights, coalesce(bs.name,'Direct') as source,
          coalesce(case when r.notes like '{%' then r.notes::jsonb->>'rateCode' end,'—') as "ratePlan", r.status,
          coalesce(c.name,'Guest') as "billTo",
          coalesce((select sum(ch.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=ch.id),0)) from charges ch join folios f on f.id=ch.folio_id where f.reservation_id=r.id and ch.status='posted'),0)::int as "totalCents",
          ${balance} as "balanceCents",
          r.arrival_date::text as "checkInDate",
          coalesce((select to_char(max(rrx.checked_out_at) at time zone p.timezone,'HH12:MI AM') from reservation_rooms rrx where rrx.reservation_id=r.id),'') as "departedTime",
          coalesce((select sum(pay.amount_cents) from payments pay where pay.reservation_id=r.id and upper(pay.method)='DIRECT BILL'),0)::int as "arCents"
        from reservations r join guests g on g.id=r.main_guest_id join properties p on p.id=r.property_id
        left join booking_sources bs on bs.id=r.booking_source_id left join companies c on c.id=r.company_id
        where r.property_id=${propertyId}::uuid and r.status not in ('cancelled')
          and (${arrivals} or r.status <> 'no_show')
          and (case when ${arrivals} then r.arrival_date else r.departure_date end) between ${startDate}::date and ${endDate}::date
        order by date, rooms
      `;
      const rows = records.map((record) => ({ ...record, status: arrivals ? statusLabel(record.status) : record.status === "checked_out" ? "Departed" : record.status === "checked_in" ? "Pending Depart" : statusLabel(record.status) }));
      const done = records.filter((record) => record.status === (arrivals ? "reserved" : "checked_in")).length;
      if (!arrivals) {
        // HotelKey Departures List layout.
        return respond(
          [{ label: "Total", value: records.length, format: "number" }, { label: "Pending Depart", value: done, format: "number" }, { label: "Departed", value: records.filter((row) => row.status === "checked_out").length, format: "number" }, { label: "Open Balance", value: sum(records, (row) => Math.max(0, row.balanceCents)), format: "money" }],
          [{ key: "confirmation", label: "Confirmation No" }, { key: "rooms", label: "Room Number" }, { key: "guest", label: "Guest Name" }, { key: "checkInDate", label: "Check In Date", format: "date" }, { key: "status", label: "Status", format: "status" }, money("arCents", "ARR"), money("balanceCents", "Balance"), { key: "departedTime", label: "Departed Time" }],
          rows,
          "Stays departing in the range. ARR is the amount moved to accounts receivable (direct bill) at checkout.",
        );
      }
      return respond(
        arrivals
          ? [{ label: "Arrivals", value: records.length, format: "number" }, { label: "Still Due In", value: done, format: "number" }, { label: "Room Nights", value: sum(records, (row) => row.nights), format: "number" }, { label: "Balance Due", value: sum(records, (row) => Math.max(0, row.balanceCents)), format: "money" }]
          : [{ label: "Departures", value: records.length, format: "number" }, { label: "Still Due Out", value: done, format: "number" }, { label: "Checked Out", value: records.filter((row) => row.status === "checked_out").length, format: "number" }, { label: "Open Balance", value: sum(records, (row) => Math.max(0, row.balanceCents)), format: "money" }],
        [{ key: "date", label: arrivals ? "Arrival" : "Departure", format: "date" }, { key: "confirmation", label: "Confirmation" }, { key: "guest", label: "Guest" }, { key: "rooms", label: "Room" }, { key: "roomType", label: "Room Type" }, count("nights", "Nights"), { key: "source", label: "Source" }, { key: "ratePlan", label: "Rate Plan" }, { key: "billTo", label: "Bill To" }, { key: "status", label: "Status", format: "status" }, money("totalCents", "Folio Total"), money("balanceCents", "Balance")],
        rows,
        arrivals ? "Lists every booking arriving in the range except cancellations. No-shows stay listed with their status." : "Lists stays scheduled to depart in the range. Company stays are billed to the company at checkout.",
      );
    }

    if (view === "in-house-balances") {
      const records = await sql<Array<{ id: string; rooms: string; guest: string; arrival: string; departure: string; billTo: string; chargesCents: number; paymentsCents: number; balanceCents: number; depositCents: number }>>`
        select r.id, ${roomList} as rooms, g.first_name||' '||g.last_name as guest, r.arrival_date::text as arrival, r.departure_date::text as departure,
          coalesce(c.name,'Guest') as "billTo",
          coalesce((select sum(ch.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=ch.id),0)) from charges ch join folios f on f.id=ch.folio_id where f.reservation_id=r.id and ch.status='posted'),0)::int as "chargesCents",
          coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0)::int as "paymentsCents",
          ${balance} as "balanceCents",
          coalesce((select sum(d.amount_cents) from security_deposits d join reservation_rooms rr on rr.id=d.reservation_room_id where rr.reservation_id=r.id and d.status='held'),0)::int as "depositCents"
        from reservations r join guests g on g.id=r.main_guest_id left join companies c on c.id=r.company_id
        where r.property_id=${propertyId}::uuid and r.status='checked_in'
        order by rooms
      `;
      return respond(
        [{ label: "In-House Stays", value: records.length, format: "number" }, { label: "Charges", value: sum(records, (row) => row.chargesCents), format: "money" }, { label: "Payments", value: sum(records, (row) => row.paymentsCents), format: "money" }, { label: "Balance", value: sum(records, (row) => row.balanceCents), format: "money" }],
        [{ key: "rooms", label: "Room" }, { key: "guest", label: "Guest" }, { key: "arrival", label: "Arrival", format: "date" }, { key: "departure", label: "Departure", format: "date" }, { key: "billTo", label: "Bill To" }, money("chargesCents", "Charges"), money("paymentsCents", "Payments"), money("balanceCents", "Balance"), money("depositCents", "Deposit Held")],
        records,
        "Current snapshot of every checked-in stay, whatever the date range. Guests must settle before checkout; company balances move to the company invoice.",
      );
    }

    if (view === "do-not-rent") {
      const records = await sql<Array<{ id: string; guest: string; phone: string; reason: string; date: string }>>`
        select g.id, g.first_name||' '||g.last_name as guest, coalesce(g.phone,'') as phone, coalesce(g.dnr_reason,'—') as reason,
          (g.updated_at at time zone coalesce((select timezone from properties where id=${propertyId}::uuid),'UTC'))::date::text as date
        from guests g where g.property_id=${propertyId}::uuid and g.guest_status='do_not_rent' and g.archived_at is null
        order by g.last_name, g.first_name
      `;
      return respond(
        [{ label: "Do Not Rent Guests", value: records.length, format: "number" }],
        [{ key: "guest", label: "Guest" }, { key: "phone", label: "Phone" }, { key: "reason", label: "Reason" }, { key: "date", label: "Last Updated", format: "date" }],
        records,
        "Every guest currently flagged Do Not Rent, whatever the date range. Check-in is blocked for these guests.",
      );
    }

    if (view === "payment-activity") {
      const records = await sql<Array<{ id: string; date: string; payer: string; confirmation: string; method: string; reference: string; amountCents: number; refundedCents: number; netCents: number }>>`
        select p.id, p.effective_date::text as date,
          coalesce(co.name, g.first_name||' '||g.last_name, (select ha.name from house_accounts ha where ha.id=p.house_account_id), 'Unassigned') as payer,
          coalesce(r.confirmation_number, case when p.house_account_id is not null then 'House account' else 'Company payment' end) as confirmation,
          p.method, coalesce(case when p.last4 is not null then '•••• '||p.last4 end, p.external_reference, '—') as reference,
          p.amount_cents as "amountCents",
          coalesce((select sum(ref.amount_cents) from refunds ref where ref.payment_id=p.id),0)::int as "refundedCents",
          (p.amount_cents - coalesce((select sum(ref.amount_cents) from refunds ref where ref.payment_id=p.id),0))::int as "netCents"
        from payments p left join reservations r on r.id=p.reservation_id left join guests g on g.id=r.main_guest_id
        left join companies co on co.id=p.company_id and p.reservation_id is null
        where p.property_id=${propertyId}::uuid and p.effective_date between ${startDate}::date and ${endDate}::date
          and p.method not in ('BAD DEBT','OTA COMMISSION','DIRECT BILL')
        order by p.effective_date, p.created_at
      `;
      return respond(
        [{ label: "Payments", value: records.length, format: "number" }, { label: "Collected", value: sum(records, (row) => row.amountCents), format: "money" }, { label: "Refunded", value: sum(records, (row) => row.refundedCents), format: "money" }, { label: "Net Collected", value: sum(records, (row) => row.netCents), format: "money" }],
        [{ key: "date", label: "Date", format: "date" }, { key: "payer", label: "Guest / Company" }, { key: "confirmation", label: "Confirmation" }, { key: "method", label: "Method" }, { key: "reference", label: "Reference" }, money("amountCents", "Amount"), money("refundedCents", "Refunded"), money("netCents", "Net")],
        records,
        "Money received from guests and companies. OTA commission settlements, direct bill transfers, and bad debt write-offs are not payments and are excluded.",
      );
    }

    if (view === "paid-outs") {
      const records = await sql<Array<{ id: string; date: string; paidTo: string; reason: string; note: string; amountCents: number; time: string; clerk: string }>>`
        select po.id, po.business_date::text as date, po.paid_to as "paidTo", po.reason, coalesce(po.note,'') as note, po.amount_cents as "amountCents",
          to_char(po.created_at at time zone p.timezone, 'HH12:MI AM') as time,
          coalesce((select e.name from employees e join property_memberships m on m.id=e.membership_id where m.auth_user_id=po.created_by_auth_user_id and m.property_id=po.property_id limit 1), 'Staff') as clerk
        from paid_outs po join properties p on p.id=po.property_id
        where po.property_id=${propertyId}::uuid and po.business_date between ${startDate}::date and ${endDate}::date
        order by po.business_date, po.created_at
      `;
      return respond(
        [{ label: "Paid Outs", value: records.length, format: "number" }, { label: "Cash Paid Out", value: sum(records, (row) => row.amountCents), format: "money" }],
        [{ key: "date", label: "Date", format: "date" }, { key: "time", label: "Time" }, { key: "clerk", label: "Clerk" }, { key: "paidTo", label: "Paid To" }, { key: "reason", label: "Reason" }, { key: "note", label: "Note" }, money("amountCents", "Amount")],
        records,
        "Cash paid out of the front-desk drawer. Each paid out lowers the expected cash for that day's Cash Drop.",
      );
    }

    if (view === "clerk-activity") {
      // HotelKey "Clerk Activity": every action staff took, by clerk and time.
      const records = await sql<Array<{ id: string; date: string; time: string; clerk: string; area: string; reservation: string; activity: string }>>`
        with tz as (select timezone from properties where id=${propertyId}::uuid),
        events as (
          select a.id::text as id, a.created_at as at, a.actor_name as clerk, a.category as area,
            r.confirmation_number || ' · ' || g.first_name || ' ' || g.last_name as reservation, a.description as activity
          from reservation_activity a join reservations r on r.id=a.reservation_id join guests g on g.id=r.main_guest_id
          where a.property_id=${propertyId}::uuid
          union all
          select po.id::text, po.created_at,
            coalesce((select e.name from employees e join property_memberships m on m.id=e.membership_id where m.auth_user_id=po.created_by_auth_user_id and m.property_id=po.property_id limit 1), 'Staff'),
            'Paid Out', '—', 'Paid out $' || to_char(po.amount_cents/100.0,'FM999999990.00') || ' to ' || po.paid_to || ' · ' || po.reason
          from paid_outs po where po.property_id=${propertyId}::uuid
          union all
          select cs.id::text || '-start', cs.opened_at, e.name, 'Shift', '—', 'Started ' || split_part(cs.status, ':', 2) || ' · opening cash $' || to_char(cs.opening_cents/100.0,'FM999999990.00')
          from cash_shifts cs join employees e on e.id=cs.employee_id where cs.property_id=${propertyId}::uuid and cs.opened_at < coalesce(cs.closed_at, now())
          union all
          select cs.id::text || '-end', cs.closed_at, e.name, 'Shift', '—', 'Ended ' || split_part(cs.status, ':', 2) || ' · counted $' || to_char(coalesce(cs.counted_cents,0)/100.0,'FM999999990.00')
            || ' vs expected $' || to_char(coalesce(cs.expected_cents,0)/100.0,'FM999999990.00')
          from cash_shifts cs join employees e on e.id=cs.employee_id where cs.property_id=${propertyId}::uuid and cs.closed_at is not null
        )
        select id, to_char(at at time zone (select timezone from tz), 'YYYY-MM-DD') as date, to_char(at at time zone (select timezone from tz), 'HH12:MI AM') as time,
          clerk, area, reservation, activity
        from events
        where (at at time zone (select timezone from tz))::date between ${startDate}::date and ${endDate}::date
        order by at desc
        limit 5000
      `;
      const clerks = new Set(records.map((row) => row.clerk));
      return respond(
        [{ label: "Activities", value: records.length, format: "number" }, { label: "Clerks", value: clerks.size, format: "number" }, { label: "Payments & Refunds", value: records.filter((row) => row.area === "Payment").length, format: "number" }, { label: "Status Changes", value: records.filter((row) => row.area === "Status").length, format: "number" }],
        [{ key: "date", label: "Date", format: "date" }, { key: "time", label: "Time" }, { key: "clerk", label: "Clerk" }, { key: "area", label: "Area" }, { key: "reservation", label: "Reservation" }, { key: "activity", label: "Activity" }],
        records,
        "Every reservation change, payment, paid out, and shift start or end, with the staff member who did it. Times are in the hotel's time zone.",
      );
    }

    if (view === "clerk-shift") {
      // HotelKey "Clerk Shift": each shift's drawer from opening count to drop.
      const records = await sql<Array<{ id: string; date: string; shift: string; clerk: string; started: string; ended: string; openingCents: number; paymentCents: number; refundCents: number; depositCents: number; paidOutCents: number; expectedCents: number; countedCents: number; differenceCents: number; droppedCents: number; status: string }>>`
        select cs.id, bd.business_date::text as date, split_part(cs.status, ':', 2) as shift, e.name as clerk,
          to_char(cs.opened_at at time zone p.timezone, 'MM/DD HH12:MI AM') as started,
          coalesce(to_char(cs.closed_at at time zone p.timezone, 'MM/DD HH12:MI AM'), 'Open') as ended,
          cs.opening_cents as "openingCents",
          coalesce((select sum(pay.amount_cents) from payments pay where pay.property_id=cs.property_id and lower(pay.method) like '%cash%' and pay.created_at >= cs.opened_at and pay.created_at < coalesce(cs.closed_at, now())),0)::int as "paymentCents",
          coalesce((select sum(r.amount_cents) from refunds r join payments pay on pay.id=r.payment_id where r.property_id=cs.property_id and lower(pay.method) like '%cash%' and r.created_at >= cs.opened_at and r.created_at < coalesce(cs.closed_at, now())),0)::int as "refundCents",
          coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=cs.property_id and le.account='Cash' and le.resource_type in ('deposit-collect','deposit-release') and le.created_at >= cs.opened_at and le.created_at < coalesce(cs.closed_at, now())),0)::int as "depositCents",
          coalesce((select sum(po.amount_cents) from paid_outs po where po.property_id=cs.property_id and po.created_at >= cs.opened_at and po.created_at < coalesce(cs.closed_at, now())),0)::int as "paidOutCents",
          coalesce(cs.expected_cents,0)::int as "expectedCents", coalesce(cs.counted_cents,0)::int as "countedCents",
          (coalesce(cs.counted_cents,0) - coalesce(cs.expected_cents,0))::int as "differenceCents",
          coalesce((select sum(cd.amount_cents) from cash_drops cd where cd.cash_shift_id=cs.id),0)::int as "droppedCents",
          case when cs.status like 'open:%' then 'Open' when coalesce(cs.counted_cents,0)=coalesce(cs.expected_cents,0) then 'Balanced' when coalesce(cs.counted_cents,0)>coalesce(cs.expected_cents,0) then 'Over' else 'Short' end as status
        from cash_shifts cs join employees e on e.id=cs.employee_id join business_days bd on bd.id=cs.business_day_id join properties p on p.id=cs.property_id
        where cs.property_id=${propertyId}::uuid and bd.business_date between ${startDate}::date and ${endDate}::date
        order by cs.opened_at desc
      `;
      return respond(
        [{ label: "Shifts", value: records.length, format: "number" }, { label: "Cash Taken", value: sum(records, (row) => row.paymentCents), format: "money" }, { label: "Paid Outs", value: sum(records, (row) => row.paidOutCents), format: "money" }, { label: "Over / Short", value: sum(records, (row) => row.status === "Open" ? 0 : row.differenceCents), format: "money" }],
        [{ key: "date", label: "Business Date", format: "date" }, { key: "shift", label: "Shift" }, { key: "clerk", label: "Clerk" }, { key: "started", label: "Started" }, { key: "ended", label: "Ended" },
          money("openingCents", "Opening"), money("paymentCents", "Cash Payments"), money("refundCents", "Cash Refunds"), money("depositCents", "Cash Deposits"), money("paidOutCents", "Paid Outs"),
          money("expectedCents", "Expected"), money("countedCents", "Counted"), money("differenceCents", "Over / Short"), money("droppedCents", "Dropped"), { key: "status", label: "Status", format: "status" }],
        records,
        "Each clerk's shift: the opening count, cash taken and paid out during the shift, and the closing count and drop. An open shift shows its activity so far.",
      );
    }

    if (view === "lost-and-found") {
      const records = await sql<Array<{ id: string; date: string; item: string; location: string; foundBy: string; guest: string; storage: string; status: string; closed: string }>>`
        select l.id, l.found_date::text as date, l.item || coalesce(' — ' || l.description, '') as item, l.location, l.found_by as "foundBy",
          coalesce(l.guest_name, '—') as guest, coalesce(l.storage_location, '—') as storage, initcap(l.status) as status,
          coalesce(l.closed_by || coalesce(' · ' || l.closed_note, ''), '') as closed
        from lost_found_items l where l.property_id=${propertyId}::uuid and l.found_date between ${startDate}::date and ${endDate}::date
        order by l.found_date, l.created_at
      `;
      return respond(
        [{ label: "Items Found", value: records.length, format: "number" }, { label: "In Storage", value: records.filter((row) => row.status === "Stored").length, format: "number" }, { label: "Returned", value: records.filter((row) => row.status === "Returned").length, format: "number" }, { label: "Disposed", value: records.filter((row) => row.status === "Disposed").length, format: "number" }],
        [{ key: "date", label: "Found", format: "date" }, { key: "item", label: "Item" }, { key: "location", label: "Where Found" }, { key: "foundBy", label: "Found By" }, { key: "guest", label: "Guest" }, { key: "storage", label: "Stored At" }, { key: "status", label: "Status", format: "status" }, { key: "closed", label: "Returned To / Disposed By" }],
        records,
        "Items found in the date range and what happened to each one.",
      );
    }

    if (view === "tax") {
      const records = await sql<Array<{ id: string; date: string; roomRevenueCents: number; taxableCents: number; exemptCents: number; otherCents: number; taxCents: number }>>`
        select d::date::text as id, d::date::text as date,
          coalesce(sum(c.amount_cents) filter (where c.type='Room Rent'),0)::int as "roomRevenueCents",
          coalesce(sum(c.amount_cents) filter (where c.type='Room Rent' and not r.tax_exempt),0)::int as "taxableCents",
          coalesce(sum(c.amount_cents) filter (where c.type='Room Rent' and r.tax_exempt),0)::int as "exemptCents",
          coalesce(sum(c.amount_cents) filter (where c.type<>'Room Rent'),0)::int as "otherCents",
          coalesce(sum((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id)),0)::int as "taxCents"
        from generate_series(${startDate}::date, ${endDate}::date, '1 day') as days(d)
        left join charges c on c.property_id=${propertyId}::uuid and c.service_date=d::date and c.status='posted'
        left join folios f on f.id=c.folio_id left join reservations r on r.id=f.reservation_id
        group by d order by d
      `;
      return respond(
        [{ label: "Taxable Room Revenue", value: sum(records, (row) => row.taxableCents), format: "money" }, { label: "Exempt Room Revenue", value: sum(records, (row) => row.exemptCents), format: "money" }, { label: "Non-Taxable Charges", value: sum(records, (row) => row.otherCents), format: "money" }, { label: "Tax Collected", value: sum(records, (row) => row.taxCents), format: "money" }],
        [{ key: "date", label: "Stay Date", format: "date" }, money("roomRevenueCents", "Room Revenue"), money("taxableCents", "Taxable"), money("exemptCents", "Exempt"), money("otherCents", "Other Charges (Non-Taxable)"), money("taxCents", "Tax")],
        records,
        "Posted charges by stay date for occupancy-tax filing. Room rent is taxed unless the stay is tax-exempt; extra charges are non-taxable.",
      );
    }

    if (view === "direct-bill-aging") {
      const records = await sql<Array<{ id: string; company: string; invoices: number; currentCents: number; d30Cents: number; d60Cents: number; d90Cents: number; over90Cents: number; totalCents: number }>>`
        with open as (
          select i.company_id, ${endDate}::date - i.due_date as late,
            (coalesce((select sum(il.amount_cents) from invoice_lines il where il.invoice_id=i.id),0)
              - coalesce((select sum(ipa.amount_cents) from invoice_payment_allocations ipa where ipa.invoice_id=i.id),0))::int as due
          from invoices i where i.property_id=${propertyId}::uuid and i.status not in ('paid','void')
            and (i.created_at at time zone coalesce((select timezone from properties where id=${propertyId}::uuid),'UTC'))::date <= ${endDate}::date
        )
        select c.id, c.name as company, count(*)::int as invoices,
          coalesce(sum(due) filter (where late <= 0),0)::int as "currentCents",
          coalesce(sum(due) filter (where late between 1 and 30),0)::int as "d30Cents",
          coalesce(sum(due) filter (where late between 31 and 60),0)::int as "d60Cents",
          coalesce(sum(due) filter (where late between 61 and 90),0)::int as "d90Cents",
          coalesce(sum(due) filter (where late > 90),0)::int as "over90Cents",
          coalesce(sum(due),0)::int as "totalCents"
        from open join companies c on c.id=open.company_id where open.due > 0
        group by c.id, c.name order by "totalCents" desc
      `;
      return respond(
        [{ label: "Companies Owing", value: records.length, format: "number" }, { label: "Not Yet Due", value: sum(records, (row) => row.currentCents), format: "money" }, { label: "Past Due", value: sum(records, (row) => row.totalCents - row.currentCents), format: "money" }, { label: "Total Receivable", value: sum(records, (row) => row.totalCents), format: "money" }],
        [{ key: "company", label: "Company" }, count("invoices", "Open Invoices"), money("currentCents", "Current"), money("d30Cents", "1–30 Days"), money("d60Cents", "31–60 Days"), money("d90Cents", "61–90 Days"), money("over90Cents", "90+ Days"), money("totalCents", "Total Due")],
        records,
        `Open company invoices aged by days past their due date as of ${endDate}. Draft invoices are included because the company already owes them.`,
      );
    }

    if (view === "trial-balance") {
      const records = await sql<Array<{ id: string; account: string; debitCents: number; creditCents: number; netCents: number }>>`
        select account as id, account, sum(debit_cents)::int as "debitCents", sum(credit_cents)::int as "creditCents", sum(debit_cents-credit_cents)::int as "netCents"
        from ledger_entries where property_id=${propertyId}::uuid and business_date between ${startDate}::date and ${endDate}::date
        group by account order by account
      `;
      const debit = sum(records, (row) => row.debitCents);
      const credit = sum(records, (row) => row.creditCents);
      return respond(
        [{ label: "Accounts", value: records.length, format: "number" }, { label: "Total Debits", value: debit, format: "money" }, { label: "Total Credits", value: credit, format: "money" }, { label: "Out of Balance", value: debit - credit, format: "money" }],
        [{ key: "account", label: "Account" }, money("debitCents", "Debit"), money("creditCents", "Credit"), money("netCents", "Net (Debit − Credit)")],
        records,
        "Ledger activity by account for the business dates in range. Debits and credits must be equal; any difference is shown as Out of Balance.",
      );
    }

    if (view === "revenue-by-room-type") {
      const days = Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000) + 1;
      const records = await sql<Array<{ id: string; roomType: string; rooms: number; nights: number; revenueCents: number }>>`
        select rt.id, rt.name as "roomType",
          (select count(*) from rooms ro where ro.room_type_id=rt.id and ro.active)::int as rooms,
          count(c.id)::int as nights, coalesce(sum(c.amount_cents),0)::int as "revenueCents"
        from room_types rt
        left join reservation_rooms rr on rr.room_type_id=rt.id
        left join charges c on c.reservation_room_id=rr.id and c.type='Room Rent' and c.status='posted' and c.service_date between ${startDate}::date and ${endDate}::date
        where rt.property_id=${propertyId}::uuid
        group by rt.id, rt.name order by rt.name
      `;
      const rows = records.map((record) => ({
        ...record,
        adrCents: record.nights ? Math.round(record.revenueCents / record.nights) : 0,
        occupancy: record.rooms ? (record.nights / (record.rooms * days)) * 100 : 0,
        revParCents: record.rooms ? Math.round(record.revenueCents / (record.rooms * days)) : 0,
      }));
      const totalRooms = sum(records, (row) => row.rooms);
      const nights = sum(records, (row) => row.nights);
      const revenue = sum(records, (row) => row.revenueCents);
      return respond(
        [{ label: "Room Nights Sold", value: nights, format: "number" }, { label: "Room Revenue", value: revenue, format: "money" }, { label: "ADR", value: nights ? Math.round(revenue / nights) : 0, format: "money" }, { label: "Occupancy", value: totalRooms ? (nights / (totalRooms * days)) * 100 : 0, format: "percent" }],
        [{ key: "roomType", label: "Room Type" }, count("rooms", "Rooms"), count("nights", "Nights Sold"), { key: "occupancy", label: "Occupancy", format: "percent", align: "right" }, money("revenueCents", "Room Revenue"), money("adrCents", "ADR"), money("revParCents", "RevPAR")],
        rows,
        "Posted room rent by stay date. Cancelled, no-show, and shortened nights are voided and excluded.",
      );
    }

    // Housekeeping reports (HotelKey: Housekeeping Board, Head Housekeeper,
    // Vacant Room List, Forecasting, plus room attendant sheets).
    if (view === "housekeeping-board" || view === "room-reconciliation" || view === "vacant-rooms") {
      const [day] = await sql<Array<{ date: string }>>`select coalesce((select business_date::text from business_days where property_id=${propertyId}::uuid and status='open' order by business_date limit 1), current_date::text) as date`;
      // Short room-type codes and floors live in the Settings document.
      const [settingsRow] = await sql<Array<{ value: { rooms?: Array<{ number?: string; roomTypeId?: string; floor?: number }>; roomTypes?: Array<{ id?: string; name?: string; shortLabel?: string }> } | null }>>`
        select (case when jsonb_typeof(value)='object' then value else (value#>>'{}')::jsonb end) as value from property_settings where property_id=${propertyId}::uuid and key='application_settings'`;
      const configuredRooms = new Map((settingsRow?.value?.rooms ?? []).map((room) => [room.number ?? "", room]));
      const typeCode = (roomNumber: string, typeName: string) => {
        const configured = configuredRooms.get(roomNumber);
        const type = (settingsRow?.value?.roomTypes ?? []).find((item) => item.id === configured?.roomTypeId) ?? (settingsRow?.value?.roomTypes ?? []).find((item) => item.name === typeName);
        return type?.shortLabel || typeName;
      };
      const rooms = await sql<Array<{ id: string; room: string; roomType: string; occupied: boolean; stayStatus: string; dirty: boolean; outOfOrder: boolean; guest: string; adults: number; children: number; pets: number; arrival: string; departure: string; housekeeper: string; remarks: string; nextArrival: string; maintenance: string; returnedFromMaint: boolean; movedOut: boolean; earlyCheckout: boolean; refunded: boolean; carryOver: boolean }>>`
        select ro.id, ro.number as room, rt.name as "roomType",
          (stay.status='checked_in') as occupied,
          case when stay.status='checked_in' and stay.departure <= ${day.date}::date then 'Pending Depart'
            when stay.status='checked_in' then 'Stay Over'
            when departed.id is not null then 'Departed'
            when stay.status='reserved' then 'Arrival' else 'Vacant' end as "stayStatus",
          ro.cleanliness_status='dirty' as dirty, ro.service_status='non-rentable' as "outOfOrder",
          coalesce(stay.guest, departed.guest, '') as guest,
          coalesce(stay.adults, departed.adults, 0) as adults, coalesce(stay.children, departed.children, 0) as children,
          coalesce(stay.pets, departed.pets, 0) as pets,
          coalesce(stay.arrival::text,'') as arrival, coalesce(stay.departure::text, departed.departure::text, '') as departure,
          coalesce(e.name,'Unassigned') as housekeeper,
          coalesce(stay.remark, departed.remark, '') as remarks,
          coalesce((select to_char(r2.arrival_date,'Mon DD')||' · '||g2.first_name||' '||g2.last_name from reservation_rooms rr2 join reservations r2 on r2.id=rr2.reservation_id join guests g2 on g2.id=r2.main_guest_id
            where rr2.room_id=ro.id and rr2.status='reserved' and r2.status='reserved' and r2.arrival_date >= ${day.date}::date order by r2.arrival_date limit 1),'') as "nextArrival",
          coalesce((select string_agg(m.problem, '; ') from maintenance_orders m where m.room_id=ro.id and m.status not in ('resolved','cancelled')),'') as maintenance,
          exists (select 1 from maintenance_orders m where m.room_id=ro.id and (m.returned_to_service_at at time zone p.timezone)::date between (${day.date}::date - 1) and ${day.date}::date) as "returnedFromMaint",
          exists (select 1 from room_moves rm where rm.from_room_id=ro.id and (rm.moved_at at time zone p.timezone)::date between (${day.date}::date - 1) and ${day.date}::date) as "movedOut",
          coalesce(departed.early, false) as "earlyCheckout",
          coalesce(departed.refunded, false) as refunded,
          (ro.cleanliness_status='dirty' and ro.updated_at < (${day.date}::date)::timestamp at time zone p.timezone) as "carryOver"
        from rooms ro join room_types rt on rt.id=ro.room_type_id join properties p on p.id=ro.property_id
        left join lateral (
          select rr.status, r.arrival_date as arrival, r.departure_date as departure, g.first_name||' '||g.last_name as guest,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'adults' end)::int,1) as adults,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'children' end)::int,0) as children,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'petCount' end)::int,0) as pets,
            case when r.notes like '{%' then r.notes::jsonb->'remarks'->'housekeeping'->-1->>'text' end as remark
          from reservation_rooms rr join reservations r on r.id=rr.reservation_id join guests g on g.id=r.main_guest_id
          where rr.room_id=ro.id and rr.status in ('checked_in','reserved') and r.status in ('checked_in','reserved') and r.arrival_date <= ${day.date}::date
          order by (rr.status='checked_in') desc, r.arrival_date limit 1
        ) stay on true
        left join lateral (
          select rr.id, g.first_name||' '||g.last_name as guest, r.departure_date as departure,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'adults' end)::int,1) as adults,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'children' end)::int,0) as children,
            coalesce((case when r.notes like '{%' then r.notes::jsonb->>'petCount' end)::int,0) as pets,
            case when r.notes like '{%' then r.notes::jsonb->'remarks'->'housekeeping'->-1->>'text' end as remark,
            (rr.checked_out_at at time zone p.timezone)::date < r.departure_date as early,
            exists (select 1 from refunds rf join payments pay on pay.id=rf.payment_id where pay.reservation_id=r.id) as refunded
          from reservation_rooms rr join reservations r on r.id=rr.reservation_id join guests g on g.id=r.main_guest_id
          where rr.room_id=ro.id and rr.status='checked_out' and (rr.checked_out_at at time zone p.timezone)::date between (${day.date}::date - 1) and ${day.date}::date
          order by rr.checked_out_at desc limit 1
        ) departed on stay.status is distinct from 'checked_in'
        left join housekeeping_records h on h.room_id=ro.id and h.service_date=${day.date}::date
        left join employees e on e.id=h.housekeeper_employee_id
        where ro.property_id=${propertyId}::uuid and ro.active
        order by ro.number
      `;
      const zone = (roomNumber: string) => `Zone ${configuredRooms.get(roomNumber)?.floor ?? 1}`;
      const status = (row: (typeof rooms)[number]) => row.outOfOrder ? `Out of Order and ${row.dirty ? "Dirty" : "Clean"}` : `${row.occupied ? "Occupied" : "Vacant"} and ${row.dirty ? "Dirty" : "Clean"}`;
      if (view === "housekeeping-board") {
        // HotelKey Housekeeping Board: rooms to service, by housekeeper.
        const nightsInto = (arrival: string) => arrival ? Math.round((new Date(`${day.date}T12:00:00Z`).getTime() - new Date(`${arrival}T12:00:00Z`).getTime()) / 86_400_000) : 0;
        const board = rooms
          .filter((row) => row.dirty || row.housekeeper !== "Unassigned" || row.stayStatus === "Stay Over" || row.stayStatus === "Pending Depart")
          .filter((row) => !input.data.housekeeper || row.housekeeper === input.data.housekeeper)
          .map((row) => {
            const service = row.outOfOrder ? "OOO" : row.stayStatus === "Pending Depart" || row.stayStatus === "Departed" ? "NCO" : row.stayStatus === "Stay Over" ? "SO" : row.dirty ? "VD" : "PU";
            const changeLinen = service === "NCO" || service === "VD" || (service === "SO" && nightsInto(row.arrival) > 0 && nightsInto(row.arrival) % 3 === 0);
            return {
              id: row.id, housekeeper: row.housekeeper, zone: zone(row.room), room: row.room, status: status(row), stayStatus: row.stayStatus,
              roomType: typeCode(row.room, row.roomType), service, adults: row.adults, children: row.children,
              pets: row.guest ? (row.pets > 0 ? `YES (${row.pets})` : "NO") : "", remarks: row.remarks, comments: "",
              options: changeLinen ? "✓ CHANGE LINEN" : service === "SO" ? "TIDY" : "",
            };
          })
          .sort((left, right) => (left.housekeeper === "Unassigned" ? 1 : right.housekeeper === "Unassigned" ? -1 : left.housekeeper.localeCompare(right.housekeeper)) || left.room.localeCompare(right.room, undefined, { numeric: true }));
        return respond(
          [{ label: "Dirty Rooms", value: board.filter((row) => row.status.endsWith("Dirty")).length, format: "number" }, { label: "Out Of Order", value: board.filter((row) => row.service === "OOO").length, format: "number" }, { label: "Stay Overs", value: board.filter((row) => row.stayStatus === "Stay Over").length, format: "number" }, { label: "Due Outs", value: board.filter((row) => row.stayStatus === "Pending Depart" || row.stayStatus === "Departed").length, format: "number" }],
          [{ key: "housekeeper", label: "Housekeeper" }, { key: "zone", label: "Zone" }, { key: "room", label: "Room Number" }, { key: "status", label: "Status" }, { key: "stayStatus", label: "Stay Status" }, { key: "roomType", label: "Room Type" }, { key: "service", label: "Service" }, count("adults", "Adults"), count("children", "Children"), { key: "pets", label: "Pets" }, { key: "remarks", label: "Remarks" }, { key: "comments", label: "Comments" }, { key: "options", label: "Options" }],
          board,
          `Business day ${day.date}. Service: NCO check-out clean, SO stayover, VD vacant dirty, PU pick-up, OOO out of order. Stayovers change linen every 3rd night.`,
        );
      }
      if (view === "room-reconciliation") {
        // HotelKey Room Reconciliation: available-dirty and out-of-order-dirty rooms to research.
        const list = rooms.filter((row) => !row.occupied && row.dirty).map((row) => ({
          id: row.id, room: row.room, status: row.outOfOrder ? "O.O.O-Dirty" : "AV-Dirty",
          roomMove: row.movedOut ? "✓" : "", returnFromMaint: row.returnedFromMaint ? "✓" : "", fullRefund: row.refunded ? "✓" : "",
          earlyCheckOut: row.earlyCheckout ? "✓" : "", carryOver: row.carryOver ? "✓" : "",
          other: !row.movedOut && !row.returnedFromMaint && !row.refunded && !row.earlyCheckout && !row.carryOver && row.stayStatus !== "Departed" ? "✓" : "",
          keyMade: "", explanation: row.stayStatus === "Departed" ? `Departed: ${row.guest}` : row.maintenance,
        }));
        return respond(
          [{ label: "AV-Dirty", value: list.filter((row) => row.status === "AV-Dirty").length, format: "number" }, { label: "O.O.O-Dirty", value: list.filter((row) => row.status === "O.O.O-Dirty").length, format: "number" }],
          [{ key: "room", label: "Number" }, { key: "status", label: "Status" }, { key: "roomMove", label: "Room Move" }, { key: "returnFromMaint", label: "Return From Maint ?" }, { key: "fullRefund", label: "Full Refund ?" }, { key: "earlyCheckOut", label: "Early Check Out ?" }, { key: "carryOver", label: "Carry Over From Prev Date ?" }, { key: "other", label: "Other" }, { key: "keyMade", label: "Key Made ? Y or N" }, { key: "explanation", label: "Explanation" }],
          list,
          `Business day ${day.date}. Ticks are what the PMS found; research every room, mark Key Made, and explain "Other".`,
        );
      }
      const vacant = rooms.filter((row) => !row.occupied).map((row) => ({ id: row.id, room: row.room, roomType: typeCode(row.room, row.roomType), zone: zone(row.room), status: status(row), stayStatus: row.stayStatus, nextArrival: row.nextArrival || "—", housekeeper: row.housekeeper, maintenance: row.maintenance }));
      return respond(
        [{ label: "Vacant Rooms", value: vacant.length, format: "number" }, { label: "Vacant Clean (ready)", value: vacant.filter((row) => row.status === "Vacant and Clean").length, format: "number" }, { label: "Vacant Dirty", value: vacant.filter((row) => row.status === "Vacant and Dirty").length, format: "number" }, { label: "Out of Order", value: vacant.filter((row) => row.status.startsWith("Out of Order")).length, format: "number" }],
        [{ key: "zone", label: "Zone" }, { key: "room", label: "Room" }, { key: "roomType", label: "Room Type" }, { key: "status", label: "Status" }, { key: "stayStatus", label: "Stay Status" }, { key: "nextArrival", label: "Next Arrival" }, { key: "housekeeper", label: "Housekeeper" }, { key: "maintenance", label: "Open Maintenance" }],
        vacant, `Rooms without a guest on business day ${day.date}.`,
      );
    }

    if (view === "room-move") {
      // HotelKey Room Move report.
      const moves = await sql<Array<{ id: string; from: string; to: string; category: string; moveDate: string; moveTime: string; username: string; reason: string }>>`
        select rm.id, fr.number as "from", tr.number as "to", 'FRONT OFFICE' as category,
          to_char(rm.moved_at at time zone p.timezone,'YYYY-MM-DD') as "moveDate",
          to_char(rm.moved_at at time zone p.timezone,'HH12:MI AM') as "moveTime",
          coalesce(e.name,'—') as username, coalesce(rm.remark,'') as reason
        from room_moves rm
        join rooms fr on fr.id=rm.from_room_id join rooms tr on tr.id=rm.to_room_id
        join properties p on p.id=rm.property_id
        left join employees e on e.id=rm.moved_by_employee_id
        where rm.property_id=${propertyId}::uuid and (rm.moved_at at time zone p.timezone)::date between ${startDate}::date and ${endDate}::date
        order by rm.moved_at
      `;
      return respond(
        [{ label: "Total Rooms Moved", value: moves.length, format: "number" }],
        [{ key: "from", label: "From" }, { key: "to", label: "To" }, { key: "category", label: "Category" }, { key: "moveDate", label: "Move Date", format: "date" }, { key: "moveTime", label: "Move Time" }, { key: "username", label: "Username" }, { key: "reason", label: "Reason" }],
        moves,
      );
    }

    if (view === "housekeeping-forecast") {
      const days = await sql<Array<{ date: string; occupied: number; arrivals: number; departures: number; stayovers: number }>>`
        select d::date::text as date,
          (select count(*) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${propertyId}::uuid and r.status in ('reserved','checked_in') and rr.status in ('reserved','checked_in') and r.arrival_date <= d and r.departure_date > d)::int as occupied,
          (select count(*) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${propertyId}::uuid and r.status in ('reserved','checked_in') and rr.status in ('reserved','checked_in') and r.arrival_date = d)::int as arrivals,
          (select count(*) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${propertyId}::uuid and r.status in ('reserved','checked_in','checked_out') and rr.status in ('reserved','checked_in','checked_out') and r.departure_date = d)::int as departures,
          (select count(*) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${propertyId}::uuid and r.status in ('reserved','checked_in') and rr.status in ('reserved','checked_in') and r.arrival_date < d and r.departure_date > d)::int as stayovers
        from generate_series(${startDate}::date, ${endDate}::date, interval '1 day') d
        order by d
      `;
      const rows = days.map((day) => {
        const creditsNeeded = day.departures * 1 + day.stayovers * 0.5 + day.arrivals * 0.25;
        return { id: day.date, ...day, cleanings: day.departures + day.stayovers, credits: Math.round(creditsNeeded * 100) / 100, housekeepersNeeded: Math.max(day.departures + day.stayovers > 0 ? 1 : 0, Math.ceil(creditsNeeded / 14)) };
      });
      return respond(
        [{ label: "Departure Cleans", value: sum(rows, (row) => row.departures), format: "number" }, { label: "Stayover Services", value: sum(rows, (row) => row.stayovers), format: "number" }, { label: "Peak Housekeepers", value: Math.max(0, ...rows.map((row) => row.housekeepersNeeded)), format: "number" }],
        [{ key: "date", label: "Date", format: "date" }, count("occupied", "Occupied"), count("arrivals", "Arrivals"), count("departures", "Departures"), count("stayovers", "Stayovers"), count("cleanings", "Rooms to Clean"), count("credits", "Credits"), count("housekeepersNeeded", "Housekeepers Needed")],
        rows,
        "Expected workload from current reservations. Housekeepers needed assumes 14 credits per housekeeper per day (departure 1.0, stayover 0.5, arrival prep 0.25).",
      );
    }

    // Room status: one row per room, as it is right now.
    const records = await sql<Array<{ id: string; room: string; roomType: string; housekeeping: string; service: string; occupancy: string; guest: string; departure: string; maintenance: string }>>`
      select ro.id, ro.number as room, rt.name as "roomType", initcap(ro.cleanliness_status) as housekeeping,
        case when ro.service_status='non-rentable' then 'Non-Rentable' else 'Rentable' end as service,
        case when stay.status='checked_in' and stay.departure <= coalesce((select business_date from business_days where property_id=${propertyId}::uuid and status='open' order by business_date limit 1), current_date) then 'Due Out'
          when stay.status='checked_in' then 'Occupied' when stay.status='reserved' then 'Arrival' else 'Vacant' end as occupancy,
        coalesce(stay.guest,'—') as guest, coalesce(stay.departure::text,'') as departure,
        coalesce((select string_agg(m.problem, '; ') from maintenance_orders m where m.room_id=ro.id and m.status='open'),'—') as maintenance
      from rooms ro join room_types rt on rt.id=ro.room_type_id
      left join lateral (
        select rr.status, r.departure_date as departure, g.first_name||' '||g.last_name as guest
        from reservation_rooms rr join reservations r on r.id=rr.reservation_id join guests g on g.id=r.main_guest_id
        where rr.room_id=ro.id and rr.status in ('checked_in','reserved') and r.status in ('checked_in','reserved')
          and r.arrival_date <= coalesce((select business_date from business_days where property_id=${propertyId}::uuid and status='open' order by business_date limit 1), current_date)
        order by (rr.status='checked_in') desc, r.arrival_date limit 1
      ) stay on true
      where ro.property_id=${propertyId}::uuid and ro.active
      order by ro.number
    `;
    return respond(
      [{ label: "Rooms", value: records.length, format: "number" }, { label: "Occupied", value: records.filter((row) => row.occupancy === "Occupied" || row.occupancy === "Due Out").length, format: "number" }, { label: "Dirty", value: records.filter((row) => row.housekeeping === "Dirty").length, format: "number" }, { label: "Non-Rentable", value: records.filter((row) => row.service === "Non-Rentable").length, format: "number" }],
      [{ key: "room", label: "Room" }, { key: "roomType", label: "Room Type" }, { key: "occupancy", label: "Occupancy", format: "status" }, { key: "housekeeping", label: "Housekeeping", format: "status" }, { key: "service", label: "Service", format: "status" }, { key: "guest", label: "Guest" }, { key: "departure", label: "Departure", format: "date" }, { key: "maintenance", label: "Open Maintenance" }],
      records,
      "Current snapshot of every room for the business day, whatever the date range.",
    );
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
