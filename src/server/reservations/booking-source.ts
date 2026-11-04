import type { TransactionSql } from "postgres";

import { calculateOtaBreakdown, otaCommissionRules, type OtaPaymentStatus } from "@/domain/rules/commission";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";
import type { PropertySession } from "@/server/auth/authorization";
import { setReservationCommission } from "@/server/finance/ota-commission";
import { propertyBusinessDate } from "@/server/finance/production-finance";

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export type BookingSourceChange = { source?: string; otaPaymentStatus?: OtaPaymentStatus; roomTypeConfirmed?: true };

/**
 * Change who a reservation was booked through and how it is paid. The OTA
 * commission follows: it is recalculated for the new source (or the online
 * booking's own commission is kept), and settled on the folio when the OTA
 * collected the stay. Also confirms an online booking's room type.
 */
export async function changeBookingSource(tx: TransactionSql, session: PropertySession, reservationId: string, change: BookingSourceChange) {
    const [reservation] = await tx<Array<{ status: string; notes: string | null; sourceName: string | null; sourceType: string | null; otaPaymentStatus: string | null; version: number }>>`
      select r.status,r.notes,bs.name as "sourceName",bs.type as "sourceType",r.ota_payment_status as "otaPaymentStatus",r.version
      from reservations r left join booking_sources bs on bs.id=r.booking_source_id
      where r.id=${reservationId}::uuid and r.property_id=${session.propertyId}::uuid for update of r`;
    if (!reservation) return { error: "Reservation not found.", status: 404 } as const;
    let notes: Record<string, unknown> = {};
    try { notes = reservation.notes?.startsWith("{") ? JSON.parse(reservation.notes) : {}; } catch { notes = {}; }
    const online = notes.online && typeof notes.online === "object" ? notes.online as Record<string, unknown> : undefined;
    if (change.roomTypeConfirmed && online) {
      notes = { ...notes, online: { ...online, roomTypeConfirmed: true } };
      await logReservationActivity(tx, session, reservationId, "Room", `Room type confirmed for the online booking ("${String(online.roomTypeName ?? "room")}")`);
    }
    if (change.source || change.otaPaymentStatus) {
      if (["cancelled", "no_show", "checked_out"].includes(reservation.status)) return { error: "The source of a closed reservation cannot be changed.", status: 409 } as const;
      const sources = await tx<Array<{ id: string; name: string; type: string; commissionBasisPoints: number }>>`
        select id,name,type,commission_basis_points as "commissionBasisPoints" from booking_sources where property_id=${session.propertyId}::uuid and active=true`;
      const source = sources.find((item) => compact(item.name) === compact(change.source ?? reservation.sourceName ?? ""));
      if (!source) return { error: "Select an active reservation source configured in Settings.", status: 409 } as const;
      const isOta = source.type.toLowerCase() === "ota";
      const stored = reservation.otaPaymentStatus;
      const current: OtaPaymentStatus = stored === "Paid Online" || stored === "Virtual Card Pending" ? stored : "Guest Pays Hotel";
      const paymentStatus: OtaPaymentStatus | null = isOta ? change.otaPaymentStatus ?? current : null;
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      // Clear the commission under the old source and payment type, then set it under the new ones.
      await setReservationCommission(tx, { propertyId: session.propertyId, reservationId, targetCents: 0, businessDate, reason: "Source or payment changed" });
      await tx`update reservations set booking_source_id=${source.id}::uuid,ota_payment_status=${paymentStatus},updated_at=now() where id=${reservationId}::uuid`;
      notes = { ...notes, source: source.name };
      const [totals] = await tx<Array<{ rentCents: number; taxCents: number }>>`
        select coalesce(sum(c.amount_cents),0)::int as "rentCents",coalesce(sum((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id)),0)::int as "taxCents"
        from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservationId}::uuid and c.type='Room Rent' and c.status='posted'`;
      const [ruleSettings] = await tx<Array<{ rules: unknown }>>`
        select (case when jsonb_typeof(value)='object' then value else (value#>>'{}')::jsonb end)->'otaCommissionRules' as rules
        from property_settings where property_id=${session.propertyId}::uuid and key='application_settings'`;
      const ota = calculateOtaBreakdown({ roomRentCents: totals.rentCents, taxCents: totals.taxCents, commissionPercent: source.commissionBasisPoints / 100, paymentStatus, rules: otaCommissionRules(ruleSettings?.rules) });
      // An online booking from the same channel keeps the commission its email stated.
      const emailCommission = online && typeof online.commissionCents === "number" && compact(String(online.channel ?? "")) === compact(source.name) ? online.commissionCents : undefined;
      const commissionCents = isOta ? Math.min(ota.grossCents, emailCommission ?? ota.commissionCents) : 0;
      await setReservationCommission(tx, { propertyId: session.propertyId, reservationId, targetCents: commissionCents, businessDate, reason: `Booking commission · ${source.name}` });
      await logReservationActivity(tx, session, reservationId, "Billing", `Source ${reservation.sourceName ?? "Direct"} → ${source.name}${paymentStatus ? ` · ${paymentStatus}` : ""}${isOta ? ` · commission ${money(commissionCents)}` : ""}`);
    }
    await tx`update reservations set notes=${JSON.stringify(notes)},version=version+1,updated_at=now() where id=${reservationId}::uuid`;
    return { ok: true, version: reservation.version + 1 } as const;
}
