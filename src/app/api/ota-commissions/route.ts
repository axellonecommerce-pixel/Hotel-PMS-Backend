import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { OTA_COMMISSION_CATEGORY } from "@/server/finance/ota-commission";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type OtaCommissionRow = {
  reservationId: string; confirmationNumber: string; guestName: string; source: string; otaPaymentStatus: string | null;
  reservationStatus: string; arrivalDate: string; departureDate: string; roomRentCents: number; taxCents: number;
  grossCents: number; commissionPercent: number; commissionCents: number; netCents: number; deducted: boolean;
  paidCents: number; outstandingCents: number; settlement: "Deducted by OTA" | "Paid" | "Payable" | "None";
  paidOn: string | null; paymentMethod: string | null;
};

/**
 * Per-reservation OTA commission breakdown (FR-RAT-004) used by Expenses and
 * the OTA Commission report. Filters by arrival date when a range is given.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (!hasProductionDatabase()) return Response.json({ rows: [] });
    const url = new URL(request.url);
    const input = querySchema.safeParse({ startDate: url.searchParams.get("startDate") ?? undefined, endDate: url.searchParams.get("endDate") ?? undefined });
    if (!input.success) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    const { startDate, endDate } = input.data;
    const records = await productionSql()<Array<Omit<OtaCommissionRow, "netCents" | "deducted" | "outstandingCents" | "settlement" | "grossCents">>>`
      select r.id as "reservationId",r.confirmation_number as "confirmationNumber",concat(g.first_name,' ',g.last_name) as "guestName",
        coalesce(bs.name,'Direct') as source,r.ota_payment_status as "otaPaymentStatus",r.status as "reservationStatus",
        r.arrival_date::text as "arrivalDate",r.departure_date::text as "departureDate",
        coalesce(rent.rent,0)::int as "roomRentCents",coalesce(rent.tax,0)::int as "taxCents",
        coalesce(bs.commission_basis_points,0)/100.0 as "commissionPercent",
        coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id and le.account='OTA Commission Expense'),0)::int as "commissionCents",
        coalesce((select sum(le.debit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission-paid' and le.resource_id=r.id and le.account='Commission Payable'),0)::int as "paidCents",
        e.expense_date::text as "paidOn",e.payment_method as "paymentMethod"
      from reservations r
      join guests g on g.id=r.main_guest_id
      left join booking_sources bs on bs.id=r.booking_source_id
      left join expenses e on e.id=r.id and e.category=${OTA_COMMISSION_CATEGORY}
      left join lateral (
        select sum(c.amount_cents) as rent,sum(coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) as tax
        from charges c join folios f on f.id=c.folio_id
        where f.reservation_id=r.id and c.type='Room Rent' and c.status='posted'
      ) rent on true
      where r.property_id=${session.propertyId}::uuid
        and (lower(coalesce(bs.type,''))='ota' or coalesce(bs.commission_basis_points,0)>0
          or exists (select 1 from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id))
        and (${startDate ?? null}::date is null or r.arrival_date>=${startDate ?? null}::date)
        and (${endDate ?? null}::date is null or r.arrival_date<=${endDate ?? null}::date)
      order by r.arrival_date desc,r.created_at desc
    `;
    const rows: OtaCommissionRow[] = records.map((record) => {
      const deducted = record.otaPaymentStatus === "Paid Online" || record.otaPaymentStatus === "Virtual Card Pending";
      const grossCents = record.roomRentCents + record.taxCents;
      const outstandingCents = deducted ? 0 : Math.max(0, record.commissionCents - record.paidCents);
      return {
        ...record,
        commissionPercent: Number(record.commissionPercent),
        grossCents,
        netCents: grossCents - record.commissionCents,
        deducted,
        outstandingCents,
        settlement: record.commissionCents <= 0 ? "None" : deducted ? "Deducted by OTA" : outstandingCents > 0 ? "Payable" : "Paid",
        paidOn: deducted || record.paidCents > 0 ? record.paidOn : null,
        paymentMethod: deducted || record.paidCents > 0 ? record.paymentMethod : null,
      };
    });
    return Response.json({ rows });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
