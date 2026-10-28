import { z } from "zod";

import { summarizeRevenueLedger } from "@/server/finance/revenue-summary";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((value) => value.start <= value.end, { message: "Date range is invalid." });

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "A valid revenue date range is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ records: [] });
    const sql = productionSql();
    const [rows, paymentBreakdown, reservationSources, dailyPayments] = await Promise.all([
      sql<Array<{ date: string; roomRevenueCents: number; taxCents: number; miscellaneousRevenueCents: number }>>`
      select business_date::text as date,
        coalesce(sum(credit_cents-debit_cents) filter (where account='Room Revenue'),0)::int as "roomRevenueCents",
        coalesce(sum(credit_cents-debit_cents) filter (where account='Tax Payable'),0)::int as "taxCents",
        coalesce(sum(credit_cents-debit_cents) filter (where account like 'Revenue:%'),0)::int as "miscellaneousRevenueCents"
      from ledger_entries
      where property_id=${session.propertyId}::uuid
        and business_date between ${parsed.data.start}::date and ${parsed.data.end}::date
      group by business_date order by business_date desc
      `,
      sql<Array<{ label: string; cents: number; count: number }>>`
        select initcap(coalesce(nullif(replace(p.method,'_',' '),''),'Other')) as label,
          coalesce(sum(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id),0)),0)::int as cents,
          count(*)::int as count
        from payments p
        where p.property_id=${session.propertyId}::uuid and p.method not in ('BAD DEBT','OTA COMMISSION','DIRECT BILL')
          and p.effective_date between ${parsed.data.start}::date and ${parsed.data.end}::date
        group by p.method order by cents desc,label
      `,
      sql<Array<{ label: string; cents: number; count: number }>>`
        select coalesce(nullif(bs.name,''),'Direct') as label,
          coalesce(sum(nr.final_rate_cents),0)::int as cents,
          count(distinct r.id)::int as count
        from reservations r
        left join booking_sources bs on bs.id=r.booking_source_id
        left join reservation_rooms rr on rr.reservation_id=r.id
        left join nightly_rates nr on nr.reservation_room_id=rr.id and nr.stay_date >= ${parsed.data.start}::date and nr.stay_date <= ${parsed.data.end}::date
        where r.property_id=${session.propertyId}::uuid
          and r.arrival_date between ${parsed.data.start}::date and ${parsed.data.end}::date
          and r.status not in ('cancelled','no_show')
        group by coalesce(nullif(bs.name,''),'Direct') order by cents desc,label
      `,
      // Money taken each day by kind (net of refunds), for the Daily Revenue table.
      sql<Array<{ date: string; cashCents: number; creditCents: number; directBillCents: number; otherPaymentCents: number }>>`
        select x.date,
          coalesce(sum(x.cents) filter (where x.kind='cash'),0)::int as "cashCents",
          coalesce(sum(x.cents) filter (where x.kind='credit'),0)::int as "creditCents",
          coalesce(sum(x.cents) filter (where x.kind='direct'),0)::int as "directBillCents",
          coalesce(sum(x.cents) filter (where x.kind='other'),0)::int as "otherPaymentCents"
        from (
          select p.effective_date::text as date,
            p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id),0) as cents,
            case when upper(p.method) like 'CASH%' then 'cash'
              when upper(p.method) like '%DIRECT%' or p.company_id is not null then 'direct'
              when upper(p.method) ~ '(CREDIT|DEBIT|CARD|VISA|MASTER|AMEX|DISCOVER)' then 'credit'
              else 'other' end as kind
          from payments p
          where p.property_id=${session.propertyId}::uuid and upper(p.method) not in ('BAD DEBT','OTA COMMISSION')
            and p.effective_date between ${parsed.data.start}::date and ${parsed.data.end}::date
        ) x group by x.date
      `,
    ]);
    // Days with payments but no posted revenue still get a row.
    const byDate = new Map(dailyPayments.map((day) => [day.date, day]));
    const ledgerDates = new Set(rows.map((row) => row.date));
    const allRows = [...rows, ...dailyPayments.filter((day) => !ledgerDates.has(day.date)).map((day) => ({ date: day.date, roomRevenueCents: 0, taxCents: 0, miscellaneousRevenueCents: 0 }))]
      .sort((left, right) => right.date.localeCompare(left.date));
    const records = summarizeRevenueLedger(allRows).map((record) => {
      const day = byDate.get(record.date);
      return { ...record, cashCents: day?.cashCents ?? 0, creditCents: day?.creditCents ?? 0, directBillCents: day?.directBillCents ?? 0, otherPaymentCents: day?.otherPaymentCents ?? 0 };
    });
    return Response.json({ records, paymentBreakdown, reservationSources });
  } catch (error) { return propertyAccessResponse(error); }
}
