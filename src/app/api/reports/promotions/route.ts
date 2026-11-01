import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Promotions given, per booking: the nights in the range, the full rate,
 * the promotion discount, the promotions applied, and the booking's OTA
 * commission, so promotions and commission can be tracked together.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const params = new URL(request.url).searchParams;
    const range = z.object({ start: isoDate, end: isoDate }).safeParse({ start: params.get("start"), end: params.get("end") });
    if (!range.success || range.data.end < range.data.start) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ rows: [] });
    const rows = await productionSql()<Array<{ reservationId: string; confirmationNumber: string; guest: string; source: string; status: string; firstNight: string; lastNight: string; nights: number; rateCents: number; promotionCents: number; roomCents: number; promotions: string | null; commissionCents: number }>>`
      select r.id as "reservationId",r.confirmation_number as "confirmationNumber",trim(coalesce(g.first_name,'')||' '||coalesce(g.last_name,'')) as guest,
        coalesce(bs.name,'Direct') as source,r.status,min(nr.stay_date)::text as "firstNight",max(nr.stay_date)::text as "lastNight",count(*)::int as nights,
        sum(nr.base_rate_cents)::int as "rateCents",sum(nr.discount_cents)::int as "promotionCents",sum(nr.final_rate_cents)::int as "roomCents",
        (select string_agg(p.name,', ' order by rp.applied_order) from reservation_promotions rp join promotions p on p.id=rp.promotion_id where rp.reservation_id=r.id) as promotions,
        coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id and le.account='OTA Commission Expense'),0)::int as "commissionCents"
      from nightly_rates nr
      join reservation_rooms rr on rr.id=nr.reservation_room_id
      join reservations r on r.id=rr.reservation_id
      left join guests g on g.id=r.main_guest_id
      left join booking_sources bs on bs.id=r.booking_source_id
      where nr.property_id=${session.propertyId}::uuid and nr.stay_date between ${range.data.start}::date and ${range.data.end}::date
        and r.status not in ('cancelled')
      group by r.id,g.first_name,g.last_name,bs.name
      having sum(nr.discount_cents) > 0
      order by min(nr.stay_date) desc
    `;
    return Response.json({ rows });
  } catch (error) { return propertyAccessResponse(error); }
}
