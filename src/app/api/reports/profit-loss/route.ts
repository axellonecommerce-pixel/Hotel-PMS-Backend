import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { OTA_COMMISSION_CATEGORY } from "@/server/finance/ota-commission";

type Row = { source: "room" | "folio" | "misc" | "tax" | "ota" | "expense" | "paidOut" | "payroll" | "promotion"; category: string; month: string; cents: number };

const CARD_FEES_CATEGORY = "Commissions and Fees › Credit Card Processing Fees";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Raw figures for the Profit & Loss / Schedule C worksheet, by month. Cash
 * basis, the same for every property:
 * - Revenue is what the ledger has posted up to the business date. Future
 *   room nights are posted when a stay is booked, so they are left out until
 *   the night happens (this matches the Revenue screen).
 * - OTA commission counts once it is paid to the OTA or deducted by it, on
 *   the date it was paid; commission still payable is not an expense yet.
 * - Expenses and cash paid outs are recorded when paid.
 * - Wages count when a payroll entry is marked Paid, on its paid date.
 * - Promotions: the discount on each posted room night, so the statement can
 *   show room revenue at the full rate and the promotions as a cost (the
 *   net is unchanged).
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, ["profit_loss.view", "reports.view"]);
    const params = new URL(request.url).searchParams;
    const range = z.object({ start: isoDate, end: isoDate }).safeParse({ start: params.get("start"), end: params.get("end") });
    if (!range.success || range.data.end < range.data.start) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ rows: [] });
    const { start } = range.data;
    const sql = productionSql();
    const businessDate = await propertyBusinessDate(sql, session.propertyId);
    const end = range.data.end > businessDate ? businessDate : range.data.end;
    if (end < start) return Response.json({ start, end: range.data.end, postedThrough: businessDate, rows: [] });
    const [ledger, expenses, paidOuts, payroll, promotions, cardFees] = await Promise.all([
      sql<Row[]>`
        select case
            when account='Room Revenue' then 'room'
            when account='Tax Payable' then 'tax'
            when resource_type like 'misc-revenue%' then 'misc'
            else 'folio' end as source,
          case when account like 'Revenue:%' then substring(account from 9) else account end as category,
          to_char(business_date,'YYYY-MM') as month,
          sum(credit_cents-debit_cents)::int as cents
        from ledger_entries
        where property_id=${session.propertyId}::uuid and business_date between ${start}::date and ${end}::date
          and (account in ('Room Revenue','Tax Payable') or account like 'Revenue:%')
        group by 1,2,3
      `,
      sql<Row[]>`
        select case when category=${OTA_COMMISSION_CATEGORY} then 'ota' else 'expense' end as source,
          case when category=${OTA_COMMISSION_CATEGORY} then 'OTA Commission' else category end as category,
          to_char(expense_date,'YYYY-MM') as month, sum(amount_cents)::int as cents
        from expenses where property_id=${session.propertyId}::uuid and expense_date between ${start}::date and ${end}::date
        group by 1,2,3
      `,
      sql<Row[]>`
        select 'paidOut' as source, coalesce(nullif(trim(reason),''),'Paid out') as category, to_char(business_date,'YYYY-MM') as month, sum(amount_cents)::int as cents
        from paid_outs where property_id=${session.propertyId}::uuid and business_date between ${start}::date and ${end}::date
          and source_type is null
        group by 2,3
      `,
      sql<Row[]>`
        select 'payroll' as source, 'Wages (paid payroll)' as category, to_char(paid_on,'YYYY-MM') as month,
          sum(gross_pay_cents + coalesce(case when description ~ '^\s*\{' then (description::jsonb->>'adjustmentCents')::int end,0))::int as cents
        from payroll_entries
        where property_id=${session.propertyId}::uuid and paid and paid_on between ${start}::date and ${end}::date
        group by 3
      `,
      sql<Row[]>`
        select 'promotion' as source, 'Promotions' as category, to_char(nr.stay_date,'YYYY-MM') as month, sum(nr.discount_cents)::int as cents
        from nightly_rates nr
        where nr.property_id=${session.propertyId}::uuid and nr.discount_cents > 0 and nr.stay_date between ${start}::date and ${end}::date
          and exists (select 1 from charges c where c.reservation_room_id=nr.reservation_room_id and c.service_date=nr.stay_date and c.type='Room Rent' and c.status='posted')
        group by 3
      `,
      // What the card processor kept when card payments were deposited
      // (Schedule C line 10, Commissions and fees).
      sql<Row[]>`
        select 'expense' as source, ${CARD_FEES_CATEGORY} as category, to_char(deposit_date,'YYYY-MM') as month, sum(fee_cents)::int as cents
        from card_settlements where property_id=${session.propertyId}::uuid and fee_cents > 0 and deposit_date between ${start}::date and ${end}::date
        group by 3
      `,
    ]);
    const rows = [...ledger, ...expenses, ...paidOuts, ...payroll, ...promotions, ...cardFees].filter((row) => row.cents !== 0);
    return Response.json({ start, end: range.data.end, postedThrough: end, rows });
  } catch (error) { return propertyAccessResponse(error); }
}
