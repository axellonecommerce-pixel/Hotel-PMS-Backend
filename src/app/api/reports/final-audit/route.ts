import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type DailyAudit = {
  date: string; roomRevenue: number; otherRevenue: number; taxes: number; ledgerVariance: number;
  payments: number; cashDrop: number; soldRooms: number; rentableRooms: number; auditStatus: string | null;
  openingGuest: number; guestCharges: number; guestPayments: number; transfers: number;
};

/** Consolidated read-only control report; a completed Night Audit remains the only close certification. */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const [inventory] = await productionSql()<Array<{ rentableRooms: number }>>`
      select count(*) filter (where active=true and service_status='rentable')::int as "rentableRooms"
      from rooms where property_id=${session.propertyId}::uuid
    `;
    const records = await productionSql()<DailyAudit[]>`
      select day::date::text as date,
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account='Room Revenue'),0)::int as "roomRevenue",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account like 'Revenue:%'),0)::int as "otherRevenue",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date and le.account='Tax Payable'),0)::int as taxes,
        coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.business_date=day::date),0)::int as "ledgerVariance",
        coalesce((select sum(p.amount_cents-coalesce((select sum(ref.amount_cents) from refunds ref where ref.payment_id=p.id),0)) from payments p where p.property_id=${session.propertyId}::uuid and p.effective_date=day::date and p.method not in ('BAD DEBT','OTA COMMISSION','DIRECT BILL')),0)::int as payments,
        coalesce((select sum(cd.amount_cents) from cash_drops cd join cash_shifts cs on cs.id=cd.cash_shift_id join business_days bd on bd.id=cs.business_day_id where cd.property_id=${session.propertyId}::uuid and bd.business_date=day::date),0)::int as "cashDrop",
        coalesce((select count(distinct rr.room_id) from reservation_rooms rr join reservations r on r.id=rr.reservation_id where r.property_id=${session.propertyId}::uuid and rr.room_id is not null and rr.status in ('reserved','checked_in','checked_out') and r.status not in ('cancelled','no_show') and ((r.arrival_date <= day::date and r.departure_date > day::date) or (r.arrival_date=day::date and r.departure_date=day::date))
          -- A guest who checked out early did not use the room on the nights after.
          and (rr.checked_out_at is null or (rr.checked_out_at at time zone coalesce((select timezone from properties where id=${session.propertyId}::uuid),'UTC'))::date > day::date or r.arrival_date=r.departure_date)),0)::int as "soldRooms",
        ${inventory?.rentableRooms ?? 0}::int as "rentableRooms",
        -- Guest ledger (what in-house and departed guests owe; negative = paid
        -- in advance). Opening + charges - payments - transfers = closing.
        coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.account='Guest Receivable' and le.business_date < day::date),0)::int as "openingGuest",
        coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.account='Guest Receivable' and le.business_date=day::date
          and le.resource_type not in ('payment','refund','ota-commission','bad-debt')),0)::int as "guestCharges",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.account='Guest Receivable' and le.business_date=day::date
          and (le.resource_type='refund' or (le.resource_type='payment' and not exists (select 1 from payments px where px.id=le.resource_id and upper(px.method)='DIRECT BILL')))),0)::int as "guestPayments",
        coalesce((select sum(le.credit_cents-le.debit_cents) from ledger_entries le where le.property_id=${session.propertyId}::uuid and le.account='Guest Receivable' and le.business_date=day::date
          and (le.resource_type in ('ota-commission','bad-debt') or (le.resource_type='payment' and exists (select 1 from payments px where px.id=le.resource_id and upper(px.method)='DIRECT BILL')))),0)::int as transfers,
        (select nar.status from night_audit_runs nar join business_days bd on bd.id=nar.business_day_id where nar.property_id=${session.propertyId}::uuid and bd.business_date=day::date order by nar.started_at desc limit 1) as "auditStatus"
      from generate_series(${input.data.startDate}::date,${input.data.endDate}::date,'1 day'::interval) as days(day)
      order by day desc
    `;
    const total = (field: "roomRevenue" | "otherRevenue" | "taxes" | "payments" | "guestPayments" | "transfers" | "cashDrop") => records.reduce((sum, record) => sum + record[field], 0);
    // Rows are newest first: the period opens with the oldest day and closes with the newest.
    const oldest = records[records.length - 1];
    const newest = records[0];
    const closing = (record: DailyAudit) => record.openingGuest + record.guestCharges - record.guestPayments - record.transfers;
    return Response.json({ report: {
      metrics: [
        { label: "Room Revenue", value: total("roomRevenue"), format: "money" },
        { label: "Taxes", value: total("taxes"), format: "money" },
        { label: "Guest Payments", value: total("guestPayments"), format: "money" },
        { label: "Guest Balance at Start", value: oldest?.openingGuest ?? 0, format: "money" },
        { label: "Guest Balance at End", value: newest ? closing(newest) : 0, format: "money" },
        { label: "All Payments", value: total("payments"), format: "money" },
        { label: "Ledger Variance", value: records.reduce((sum, record) => sum + record.ledgerVariance, 0), format: "money" },
      ],
      columns: [
        { key: "date", label: "Business Date", format: "date" }, { key: "audit", label: "Night Audit", format: "status" },
        { key: "openingGuest", label: "Guest Balance Open", format: "money", align: "right" },
        { key: "roomRevenue", label: "Room Revenue", format: "money", align: "right" }, { key: "otherRevenue", label: "Other Revenue", format: "money", align: "right" },
        { key: "taxes", label: "Taxes", format: "money", align: "right" }, { key: "guestPayments", label: "Guest Payments", format: "money", align: "right" },
        { key: "transfers", label: "Transfers & Write-offs", format: "money", align: "right" },
        { key: "closingGuest", label: "Guest Balance Close", format: "money", align: "right" },
        { key: "cashDrop", label: "Cash Drop", format: "money", align: "right" }, { key: "soldRooms", label: "Rooms Sold", format: "number", align: "right" },
        { key: "occupancy", label: "Occupancy", format: "percent", align: "right" }, { key: "variance", label: "Ledger Variance", format: "money", align: "right" },
      ],
      rows: records.map((record) => ({
        id: record.date, date: record.date, audit: record.auditStatus === "completed" ? "Completed" : record.auditStatus === "failed" ? "Blocked" : "Not Run",
        openingGuest: record.openingGuest, roomRevenue: record.roomRevenue, otherRevenue: record.otherRevenue, taxes: record.taxes,
        guestPayments: record.guestPayments, transfers: record.transfers, closingGuest: closing(record), cashDrop: record.cashDrop,
        soldRooms: record.soldRooms, occupancy: record.rentableRooms ? record.soldRooms / record.rentableRooms * 100 : 0, variance: record.ledgerVariance,
      })),
      note: "Revenue and tax count on the night of the stay; payments count on the day they are received, so they differ day by day (prepaid stays, pay-at-checkout, OTA prepayments). The guest balance ties them together: Guest Balance Open + room, guest extras and tax charged to guests − Guest Payments − Transfers & Write-offs (company billing, OTA commission deductions, bad debt) = Guest Balance Close. A negative balance is money guests paid in advance. Other Revenue also includes sales not charged to a guest (laundry, house accounts). All Payments also counts house-account and company payments.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
