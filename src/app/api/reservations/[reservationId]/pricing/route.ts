import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { readReservationCommission } from "@/server/finance/ota-commission";

/**
 * The booking's price breakdown, in the order an OTA extranet shows it:
 * nightly rates, each promotion, the room after promotions, tax on that,
 * the total guest payment, the source's commission (a share of the room
 * after promotions, never of the tax) and the hotel's payout. Also per night.
 */
export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const { reservationId } = await context.params;
    if (!z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A valid reservation is required." }, { status: 400 });
    const sql = productionSql();
    const [reservation] = await sql<Array<{ taxBasisPoints: number; taxExempt: boolean; source: string; commissionBasisPoints: number; otaPaymentStatus: string | null }>>`
      select r.tax_rate_basis_points as "taxBasisPoints",r.tax_exempt as "taxExempt",
        coalesce(bs.name,case when r.notes like '{%' then r.notes::jsonb->>'source' end,'Direct') as source,
        coalesce(bs.commission_basis_points,0)::int as "commissionBasisPoints",r.ota_payment_status as "otaPaymentStatus"
      from reservations r left join booking_sources bs on bs.id=r.booking_source_id
      where r.id=${reservationId}::uuid and r.property_id=${session.propertyId}::uuid
    `;
    if (!reservation) return Response.json({ error: "Reservation not found." }, { status: 404 });
    const [nights, promotions, commission] = await Promise.all([
      sql<Array<{ date: string; rooms: number; baseCents: number; discountCents: number; finalCents: number; baseRates: number[]; finalRates: number[] }>>`
        select nr.stay_date::text as date,count(*)::int as rooms,sum(nr.base_rate_cents)::int as "baseCents",sum(nr.discount_cents)::int as "discountCents",
          sum(nr.final_rate_cents)::int as "finalCents",array_agg(nr.base_rate_cents order by rr.id) as "baseRates",array_agg(nr.final_rate_cents order by rr.id) as "finalRates"
        from nightly_rates nr join reservation_rooms rr on rr.id=nr.reservation_room_id
        where rr.reservation_id=${reservationId}::uuid and rr.property_id=${session.propertyId}::uuid
        group by 1 order by 1
      `,
      sql<Array<{ name: string; discountType: string; discountValue: number }>>`
        select p.name,p.discount_type as "discountType",p.discount_value as "discountValue"
        from reservation_promotions rp join promotions p on p.id=rp.promotion_id
        where rp.reservation_id=${reservationId}::uuid and rp.property_id=${session.propertyId}::uuid
        order by rp.applied_order
      `,
      readReservationCommission(sql as never, session.propertyId, reservationId),
    ]);
    // Each promotion's share: applied in order to every room-night's rate.
    const promotionCents = promotions.map(() => 0);
    for (const night of nights) for (const base of night.baseRates) {
      let amount = base;
      promotions.forEach((promotion, index) => {
        const off = promotion.discountType === "fixed" ? Math.min(amount, promotion.discountValue) : Math.round((amount * promotion.discountValue) / 10_000);
        promotionCents[index] += off;
        amount -= off;
      });
    }
    const totalDiscount = nights.reduce((sum, night) => sum + night.discountCents, 0);
    // Rates edited by hand after booking carry no discount; keep the split consistent with what is stored.
    const splitTotal = promotionCents.reduce((sum, cents) => sum + cents, 0);
    if (splitTotal !== totalDiscount && promotionCents.length) promotionCents[promotionCents.length - 1] += totalDiscount - splitTotal;
    const taxFor = (cents: number) => (reservation.taxExempt ? 0 : Math.round((cents * reservation.taxBasisPoints) / 10_000));
    const commissionPercent = reservation.commissionBasisPoints / 100;
    // The recorded commission (it may have been typed in from the extranet),
    // shared over the nights by room amount; the last night takes the rounding.
    const roomTotal = nights.reduce((total, night) => total + night.finalCents, 0);
    let commissionLeft = commission.commissionCents;
    const nightly = nights.map((night, index) => {
      // Taxed per room, per night, as the folio posts it.
      const taxCents = night.finalRates.reduce((total, rate) => total + taxFor(rate), 0);
      const guestCents = night.finalCents + taxCents;
      const share = index === nights.length - 1 ? commissionLeft : roomTotal ? Math.round((commission.commissionCents * night.finalCents) / roomTotal) : 0;
      commissionLeft -= share;
      const nightCommission = share;
      return { date: night.date, rooms: night.rooms, rateCents: night.baseCents, promotionCents: -night.discountCents, roomCents: night.finalCents, taxCents, guestCents, commissionCents: -nightCommission, payoutCents: guestCents - nightCommission };
    });
    const sum = (key: keyof (typeof nightly)[number]) => nightly.reduce((total, night) => total + (night[key] as number), 0);
    const guestCents = sum("guestCents");
    // The booking's recorded commission (it may have been entered from the extranet).
    const commissionCents = commission.commissionCents;
    return Response.json({
      source: reservation.source,
      otaPaymentStatus: reservation.otaPaymentStatus,
      commissionPercent,
      taxPercent: reservation.taxExempt ? 0 : reservation.taxBasisPoints / 100,
      rateCents: sum("rateCents"),
      promotions: promotions.map((promotion, index) => ({ name: promotion.name, label: promotion.discountType === "fixed" ? `$${(promotion.discountValue / 100).toFixed(2)} off` : `${promotion.discountValue / 100}% off`, cents: -promotionCents[index] })),
      promotionCents: -totalDiscount,
      roomCents: sum("roomCents"),
      taxCents: sum("taxCents"),
      guestCents,
      commissionCents: -commissionCents,
      commissionDeducted: commission.deducted,
      commissionPaidCents: commission.paidCents,
      payoutCents: guestCents - commissionCents,
      nights: nightly,
    });
  } catch (error) { return propertyAccessResponse(error); }
}
