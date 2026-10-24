import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { TransactionSql } from "postgres";

import { db } from "@/server/db/client";
import { calculateCommissionCents, calculateOtaBreakdown } from "@/domain/rules/commission";
import { applyStackedPromotions, type Promotion } from "@/domain/rules/reservation-lifecycle";
import { canUseRateCode } from "@/domain/rules/rate-code";
import { calculateTaxCents } from "@/domain/rules/tax";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { bookingChannels, companies, guests, reservationCharges, reservationRooms, reservations, rooms, roomTypes } from "@/server/db/schema";
import { recordChange } from "@/server/realtime/change-events";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import type { PropertySession } from "@/server/auth/authorization";
import { allocateProductionDocumentNumber, postProductionLedger, propertyBusinessDate, reversalBusinessDate } from "@/server/finance/production-finance";
import { readReservationCommission, setReservationCommission } from "@/server/finance/ota-commission";
import { addDays, rateCalendarDays, rateCalendarRestriction } from "@/server/rates/rate-calendar";
import { describeNoteChanges, logReservationActivity, money } from "@/server/activity/reservation-activity";

/**
 * The operational UI needs a real property-scoped read model after refresh.
 * This intentionally returns the compact list shape used by the front desk;
 * details remain loaded by the reservation workspace as that API expands.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    if (hasProductionDatabase()) {
      const records = await productionSql()<Array<{
        id: string; version: number; confirmationNumber: string; firstName: string; lastName: string; phone: string | null; room: string | null; companyId: string | null; companyName: string | null;
        checkInDate: string; checkoutDate: string; source: string | null; status: string; rateCode: string | null; otaPaymentStatus: string | null;
        taxRateBasisPoints: number; taxExempt: boolean; adults: number; children: number; petCount: number; servicePetCount: number; roomRentCents: number; balanceCents: number; checkedOutDate: string | null; bookedDate: string; rawNotes: string | null; commissionBasisPoints: number; commissionCents: number; commissionPaidCents: number;
        reservationRooms: Array<{ id: string; roomNumber: string | null; roomTypeId: string; roomTypeName: string | null; status: string }>;
        extraGuests: Array<{ id: string; name: string; driverLicenseNumber: string | null }>;
      }>>`
        select r.id,r.version,r.confirmation_number as "confirmationNumber",r.company_id as "companyId",(select c.name from companies c where c.id=r.company_id) as "companyName",g.first_name as "firstName",g.last_name as "lastName",g.phone,
          rr.room_number as room,r.arrival_date::text as "checkInDate",r.departure_date::text as "checkoutDate",
          (select to_char(max(rrx.checked_out_at at time zone p.timezone),'YYYY-MM-DD') from reservation_rooms rrx join properties p on p.id=r.property_id where rrx.reservation_id=r.id) as "checkedOutDate",
          (select to_char(r.created_at at time zone p.timezone,'YYYY-MM-DD') from properties p where p.id=r.property_id) as "bookedDate",
          r.notes as "rawNotes",
          coalesce(bs.name,case when r.notes like '{%' then r.notes::jsonb->>'source' end,'Direct') as source,
          case when r.notes like '{%' then r.notes::jsonb->>'rateCode' end as "rateCode",
          r.status,r.ota_payment_status as "otaPaymentStatus",r.tax_rate_basis_points as "taxRateBasisPoints",r.tax_exempt as "taxExempt",coalesce(bs.commission_basis_points,0)::int as "commissionBasisPoints",
          coalesce((case when r.notes like '{%' then r.notes::jsonb->>'adults' end)::int,1) as adults,coalesce((case when r.notes like '{%' then r.notes::jsonb->>'children' end)::int,0) as children,
          coalesce((case when r.notes like '{%' then r.notes::jsonb->>'petCount' end)::int,0) as "petCount",coalesce((case when r.notes like '{%' then r.notes::jsonb->>'servicePetCount' end)::int,0) as "servicePetCount",
          coalesce((select sum(nr.final_rate_cents) from nightly_rates nr join reservation_rooms rrx on rrx.id=nr.reservation_room_id where rrx.reservation_id=r.id),0)::int as "roomRentCents",
          coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id and le.account='OTA Commission Expense'),0)::int as "commissionCents",
          coalesce((select sum(le.debit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission-paid' and le.resource_id=r.id and le.account='Commission Payable'),0)::int as "commissionPaidCents",
          (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)
            - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=r.id),0))::int as "balanceCents",
          coalesce((select json_agg(json_build_object('id',rrx.id,'roomNumber',room.number,'roomTypeId',rrx.room_type_id,'roomTypeName',rt.name,'status',rrx.status) order by rrx.created_at)
            from reservation_rooms rrx left join rooms room on room.id=rrx.room_id left join room_types rt on rt.id=rrx.room_type_id where rrx.reservation_id=r.id),'[]'::json) as "reservationRooms"
          ,coalesce((select json_agg(json_build_object('id',extra_guest.id,'name',concat(extra_guest.first_name,' ',extra_guest.last_name),'driverLicenseNumber',identity.id_number) order by reservation_guest.id)
            from reservation_guests reservation_guest
            join guests extra_guest on extra_guest.id=reservation_guest.guest_id
            left join guest_identities identity on identity.guest_id=extra_guest.id and identity.deleted_at is null
            where reservation_guest.reservation_id=r.id and reservation_guest."primary"=false),'[]'::json) as "extraGuests"
        from reservations r
        join guests g on g.id=r.main_guest_id
        left join booking_sources bs on bs.id=r.booking_source_id
        left join lateral (select coalesce(room.number,'Unassigned') as room_number from reservation_rooms rrx left join rooms room on room.id=rrx.room_id where rrx.reservation_id=r.id order by rrx.created_at limit 1) rr on true
        where r.property_id=${session.propertyId}::uuid order by r.created_at desc
      `;
      // The client compares room types with Settings ids ("room-type-…"), not
      // database uuids. Map each room through its configured room (exact,
      // including smoking variants) and fall back to the type name.
      const [settingsRecord] = await productionSql()<Array<{ value: StoredApplicationSettings | string }>>`
        select value from property_settings where property_id=${session.propertyId}::uuid and key='application_settings'
      `;
      const configured = storedSettings(settingsRecord?.value);
      const settingsRoomTypeId = (room: { roomNumber: string | null; roomTypeId: string; roomTypeName: string | null }) =>
        configured?.rooms?.find((item) => item.number === room.roomNumber)?.roomTypeId
        ?? configured?.roomTypes?.find((type) => type.name === room.roomTypeName)?.id
        ?? room.roomTypeId;
      return Response.json({ reservations: records.map((record) => {
        const nights = Math.max(0, Math.round((new Date(`${record.checkoutDate}T12:00:00Z`).getTime() - new Date(`${record.checkInDate}T12:00:00Z`).getTime()) / 86_400_000));
        const taxCents = record.taxExempt ? 0 : Math.round(record.roomRentCents * record.taxRateBasisPoints / 10_000);
        const status = record.status === "reserved" ? "Reserved" : record.status === "checked_in" ? "Checked In" : record.status === "checked_out" ? "Checked Out" : record.status === "no_show" ? "No Show" : record.status === "cancelled" ? "Cancelled" : record.status;
        const roomStatus = (value: string) => value === "reserved" ? "Reserved" : value === "checked_in" ? "Checked In" : value === "checked_out" ? "Checked Out" : value === "no_show" ? "No Show" : "Cancelled";
        const reservationRooms = (record.reservationRooms ?? []).map((room) => ({ id: room.id, roomNumber: room.roomNumber ?? undefined, roomTypeId: settingsRoomTypeId(room), status: roomStatus(room.status), nightlyRatesCents: [] }));
        const extraGuests = (record.extraGuests ?? []).map((guest) => ({
          id: guest.id,
          name: guest.name,
          driverLicenseNumber: guest.driverLicenseNumber ?? undefined,
        }));
        const otaPaymentStatus = record.otaPaymentStatus === "Guest Pays Hotel" || record.otaPaymentStatus === "Paid Online" || record.otaPaymentStatus === "Virtual Card Pending"
          ? record.otaPaymentStatus
          : undefined;
        const commissionCents = record.commissionCents;
        // Department remarks saved through PATCH { remark } live in notes.
        let remarks: Record<string, Array<{ id: string; text: string; createdAt: string }>> = {};
        try {
          const parsedNotes = record.rawNotes ? JSON.parse(record.rawNotes) : null;
          if (parsedNotes?.remarks && typeof parsedNotes.remarks === "object") remarks = parsedNotes.remarks;
        } catch {
          // Legacy plain-text notes have no structured remarks.
        }
        return {
          bookingRemarkEntries: remarks.booking ?? [], stayRemarkEntries: remarks.stay ?? [],
          housekeepingRemarkEntries: remarks.housekeeping ?? [], otherRemarkEntries: remarks.other ?? [], id: record.id, version: record.version, confirmationNumber: record.confirmationNumber, firstName: record.firstName, lastName: record.lastName, phone: record.phone ?? "", room: record.room ?? "Unassigned", groupReservation: reservationRooms.length > 1, reservationRooms, extraGuests, checkInDate: record.checkInDate, checkoutDate: record.checkoutDate, checkedOutDate: record.checkedOutDate ?? undefined, bookedDate: record.bookedDate, checkInTime: "3:00 PM", nights, source: record.source ?? "Direct", paymentType: record.companyId ? "Direct Bill" : "Not entered", companyId: record.companyId ?? undefined, company: record.companyName ?? undefined, roomRentCents: record.roomRentCents, taxCents, totalCents: record.roomRentCents + taxCents, balanceCents: record.balanceCents, status, rateCode: record.rateCode ?? undefined, otaPaymentStatus, commissionPercent: record.commissionBasisPoints / 100, commissionCents, commissionPaidCents: record.commissionPaidCents, taxRatePercentage: record.taxRateBasisPoints / 100, taxExempt: record.taxExempt, adults: record.adults, children: record.children, petCount: record.petCount, servicePetCount: record.servicePetCount };
      }) });
    }
    const records = await db.query.reservations.findMany({
      where: eq(reservations.propertyId, session.propertyId),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    const guestIds = records.map((record) => record.guestId);
    const roomIds = records.flatMap((record) => (record.roomId ? [record.roomId] : []));
    const [reservationGuests, reservationRooms] = await Promise.all([
      guestIds.length
        ? db.query.guests.findMany({ where: inArray(guests.id, guestIds) })
        : Promise.resolve([]),
      roomIds.length
        ? db.query.rooms.findMany({ where: inArray(rooms.id, roomIds) })
        : Promise.resolve([]),
    ]);
    const guestsById = new Map(reservationGuests.map((guest) => [guest.id, guest]));
    const roomsById = new Map(reservationRooms.map((room) => [room.id, room]));
    return Response.json({
      reservations: records.map((record) => {
        const guest = guestsById.get(record.guestId);
        const room = record.roomId ? roomsById.get(record.roomId) : undefined;
        const nights = Math.max(0, Math.round((new Date(`${record.departureDate}T12:00:00Z`).getTime() - new Date(`${record.arrivalDate}T12:00:00Z`).getTime()) / 86_400_000));
        const roomRentCents = record.roomRateCents * nights;
        const taxCents = Math.round(roomRentCents * record.taxRateBasisPoints / 10_000);
        return {
          id: record.id,
          version: record.version,
          firstName: guest?.firstName ?? "Unknown",
          lastName: guest?.lastName ?? "Guest",
          phone: guest?.phone ?? "",
          room: room?.number ?? "Unassigned",
          groupReservation: false,
          checkInDate: record.arrivalDate,
          checkoutDate: record.departureDate,
          checkInTime: "3:00 PM",
          nights,
          source: record.source,
          paymentType: record.paymentArrangement === "Credit" ? "Not entered" : record.paymentArrangement,
          roomRentCents,
          taxCents: record.taxExempt ? 0 : taxCents,
          totalCents: roomRentCents + (record.taxExempt ? 0 : taxCents),
          balanceCents: roomRentCents + (record.taxExempt ? 0 : taxCents),
          status: record.status,
          rateCode: record.rateCode ?? undefined,
          taxRatePercentage: record.taxRateBasisPoints / 100,
          taxExempt: record.taxExempt,
          notes: record.notes ?? undefined,
          adults: record.adultCount,
          children: record.childCount,
          petCount: record.petCount,
          servicePetCount: record.servicePetCount,
        };
      }),
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

const payloadSchema = z.object({
  idType: z.enum(["US Driver License", "Passport", "Other"]),
  idNumber: z.string().trim().min(1),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dateOfBirth: z.string().min(1),
  idExpires: z.string().min(1),
  addressLine1: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().default("+1"),
  phone: z.string().trim().min(1),
  secondaryPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  secondaryEmail: z.string().email().optional().or(z.literal("")),
  companyId: z.string().optional(),
  roomTypeId: z.string().trim().min(1),
  roomCount: z.number().int().positive(),
  roomNumbers: z.array(z.string().trim().min(1)).default([]),
  dnrOverrideReason: z.string().trim().optional(),
  checkInDate: z.string().min(1),
  checkoutDate: z.string().min(1),
  adults: z.number().int().positive(),
  children: z.number().int().nonnegative(),
  petCount: z.number().int().nonnegative().default(0),
  servicePetCount: z.number().int().nonnegative().default(0),
  rateCode: z.string().trim().min(1),
  baseNightlyRatesCents: z.array(z.number().int().nonnegative()).min(1),
  nightlyRatesCents: z.array(z.number().int().nonnegative()).min(1),
  fixedRateCents: z.number().int().nonnegative().optional(),
  promotionIds: z.array(z.string().trim().min(1)).default([]),
  taxRatePercentage: z.number().nonnegative().max(100),
  taxExempt: z.boolean().default(false),
  taxExemptionReason: z.string().trim().optional(),
  taxExemptionCertificate: z.string().trim().optional(),
  otaPaymentStatus: z.enum(["Guest Pays Hotel", "Paid Online", "Virtual Card Pending"]).optional(),
  source: z.string().trim().min(1),
});

function normalizeId(idNumber: string) {
  return idNumber.replace(/\s/g, "").toUpperCase();
}

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

/**
 * Settings created by older versions used names such as "Walk Inn", while
 * the reservation UI has always used "Walk-In" (and "Motel Website" for
 * Website).  A booking source is a user-facing label, so punctuation or the
 * legacy alias must never make an otherwise valid reservation fail.
 */
function bookingSourceKey(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "walkin" || compact === "walkinn") return "walkin";
  if (compact === "website" || compact === "motelwebsite") return "website";
  return compact;
}

class ReservationRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type ReservationPayload = z.infer<typeof payloadSchema>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredRoomType = { id: string; name: string; shortLabel?: string; maxOccupancy?: number; baseRateCents?: number; active?: boolean };
type StoredRoom = { number: string; roomTypeId: string; floor?: number; buildingId?: string; smokingAllowed?: boolean; serviceStatus?: string; housekeepingStatus?: string; mapColumn?: number; mapRow?: number; mapWidth?: number; mapHeight?: number };
type StoredRateCode = { name: string; active?: boolean; roomTypeRates?: Record<string, { nightlyRateCents?: number; additionalAdultCents?: number; childCents?: number }> };
type StoredApplicationSettings = { roomTypes?: StoredRoomType[]; rooms?: StoredRoom[]; rateCodes?: StoredRateCode[] };

function storedSettings(value: StoredApplicationSettings | string | undefined) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as StoredApplicationSettings; }
  catch { return undefined; }
}

async function productionRoomTypeForSettingsId(tx: TransactionSql, propertyId: string, roomTypeId: string) {
  if (uuidPattern.test(roomTypeId)) {
    const [existing] = await tx<Array<{ id: string; baseRateCents: number; active: boolean }>>`select id,base_rate_cents as "baseRateCents",active from room_types where id=${roomTypeId}::uuid and property_id=${propertyId}::uuid for update`;
    if (existing) return existing;
  }
  const [settingsRecord] = await tx<Array<{ value: StoredApplicationSettings | string }>>`select value from property_settings where property_id=${propertyId}::uuid and key='application_settings' for update`;
  const settings = storedSettings(settingsRecord?.value);
  const configuredType = settings?.roomTypes?.find((type) => type.id === roomTypeId);
  if (!configuredType) throw new ReservationRequestError("The selected room type is no longer configured.", 409);
  let [roomType] = await tx<Array<{ id: string; baseRateCents: number; active: boolean }>>`select id,base_rate_cents as "baseRateCents",active from room_types where property_id=${propertyId}::uuid and name=${configuredType.name} for update`;
  if (!roomType) {
    [roomType] = await tx<Array<{ id: string; baseRateCents: number; active: boolean }>>`insert into room_types (property_id,name,short_label,max_occupancy,base_rate_cents,active,sort_order) values (${propertyId}::uuid,${configuredType.name},${configuredType.shortLabel || configuredType.name},${configuredType.maxOccupancy ?? 1},${configuredType.baseRateCents ?? 0},${configuredType.active !== false},0) returning id,base_rate_cents as "baseRateCents",active`;
  }
  const configuredRooms = settings?.rooms?.filter((room) => room.roomTypeId === configuredType.id) ?? [];
  for (const room of configuredRooms) {
    await tx`insert into rooms (property_id,room_type_id,number,floor,section,cleanliness_status,service_status,smoking_allowed,active,map_data) values (${propertyId}::uuid,${roomType.id}::uuid,${room.number},${String(room.floor ?? 1)},${room.buildingId || null},${room.housekeepingStatus || 'clean'},${room.serviceStatus === 'non-rentable' ? 'non-rentable' : 'rentable'},${Boolean(room.smokingAllowed)},true,${tx.json({ mapColumn: room.mapColumn, mapRow: room.mapRow, mapWidth: room.mapWidth, mapHeight: room.mapHeight })}) on conflict (property_id,number) do update set room_type_id=excluded.room_type_id,floor=excluded.floor,section=excluded.section,cleanliness_status=excluded.cleanliness_status,service_status=excluded.service_status,smoking_allowed=excluded.smoking_allowed,map_data=excluded.map_data,updated_at=now()`;
  }
  return roomType;
}

async function validateProductionRateCode(tx: TransactionSql, propertyId: string, rateCodeName: string) {
  const [settingsRecord] = await tx<Array<{ value: StoredApplicationSettings | string }>>`
    select value from property_settings where property_id=${propertyId}::uuid and key='application_settings' for update
  `;
  const rateCodes = storedSettings(settingsRecord?.value)?.rateCodes ?? [];
  // Legacy properties may not have created configurable rate codes yet. RACK
  // is the only safe fallback in that state; every configured rate code must
  // be active and must belong to this property.
  if (!canUseRateCode(rateCodeName, rateCodes)) {
    throw new ReservationRequestError(rateCodes.length ? "Select an active rate code." : "The selected rate code is no longer configured.", 409);
  }
}

async function validatedPromotions(
  tx: TransactionSql,
  propertyId: string,
  roomTypeId: string,
  checkInDate: string,
  checkoutDate: string,
  promotionIds: string[],
): Promise<Promotion[]> {
  if (new Set(promotionIds).size !== promotionIds.length) {
    throw new ReservationRequestError("Select each promotion only once.", 409);
  }
  const selected: Promotion[] = [];
  for (const promotionId of promotionIds) {
    if (!uuidPattern.test(promotionId)) throw new ReservationRequestError("A selected promotion is no longer configured.", 409);
    const [promotion] = await tx<Array<{ id: string; discountType: string; discountValue: number }>>`
      select p.id,p.discount_type as "discountType",p.discount_value as "discountValue"
      from promotions p
      where p.id=${promotionId}::uuid and p.property_id=${propertyId}::uuid and p.active=true
        and p.starts_on <= ${checkInDate}::date and p.ends_on >= ${checkoutDate}::date
        and (
          not exists (select 1 from promotion_room_types prt where prt.property_id=${propertyId}::uuid and prt.promotion_id=p.id)
          or exists (select 1 from promotion_room_types prt where prt.property_id=${propertyId}::uuid and prt.promotion_id=p.id and prt.room_type_id=${roomTypeId}::uuid)
        )
      for update
    `;
    if (!promotion) throw new ReservationRequestError("A selected promotion is no longer eligible for this stay.", 409);
    if (promotion.discountType === "fixed") selected.push({ type: "fixed", valueCents: promotion.discountValue });
    else if (promotion.discountType === "percentage") selected.push({ type: "percentage", valueBasisPoints: promotion.discountValue });
    else throw new ReservationRequestError("A selected promotion has an invalid discount type.", 409);
  }
  return selected;
}

async function createProductionReservation(request: Request, session: PropertySession) {
  const parsed = payloadSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Required guest and stay details are missing." }, { status: 400 });
  const payload = parsed.data;
  if (payload.checkoutDate < payload.checkInDate) return Response.json({ error: "Check-out cannot be before check-in." }, { status: 400 });
  if (payload.taxExempt && (!payload.taxExemptionReason || !payload.taxExemptionCertificate)) {
    return Response.json({ error: "Tax-exempt stays require a reason and certificate number." }, { status: 400 });
  }
  try {
    const result = await productionSql().begin(async (tx) => createProductionReservationTransaction(tx, session, payload));
    // A reservation is already durable once the transaction commits. Realtime
    // refresh is a best-effort notification and must never make the client
    // believe that a successfully-created reservation failed.
    try {
      await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: result.reservationId, action: "created", entityVersion: result.version, payload: {} });
    } catch (error) {
      console.error("Reservation change event failed", { propertyId: session.propertyId, reservationId: result.reservationId, error });
    }
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ReservationRequestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Production reservation creation failed", { propertyId: session.propertyId, error });
    return Response.json({ error: "Reservation could not be created. Please verify the room and guest details, then try again." }, { status: 500 });
  }
}

export async function createProductionReservationTransaction(tx: TransactionSql, session: PropertySession, payload: ReservationPayload) {
  const roomType = await productionRoomTypeForSettingsId(tx, session.propertyId, payload.roomTypeId);
  if (!roomType?.active) throw new ReservationRequestError("Select an active room type.", 409);
  await validateProductionRateCode(tx, session.propertyId, payload.rateCode);
  // Equal dates are a day-use stay: one room charge, and the room is held for
  // its arrival date. Overlap checks treat every day-use stay the same way.
  const dayUse = payload.checkoutDate === payload.checkInDate;
  const occupiedUntil = dayUse ? addDays(payload.checkInDate, 1) : payload.checkoutDate;
  const stayNights = Math.round((new Date(`${payload.checkoutDate}T12:00:00Z`).getTime() - new Date(`${payload.checkInDate}T12:00:00Z`).getTime()) / 86_400_000);
  const restriction = rateCalendarRestriction(await rateCalendarDays(tx, session.propertyId, payload.roomTypeId, payload.checkInDate, occupiedUntil), payload.checkInDate, stayNights);
  if (restriction) throw new ReservationRequestError(restriction, 409);
  const selectedPromotions = await validatedPromotions(tx, session.propertyId, roomType.id, payload.checkInDate, payload.checkoutDate, payload.promotionIds);
  const roomsForType = await tx<Array<{ id: string; number: string }>>`
    select r.id, r.number from rooms r
    where r.property_id=${session.propertyId}::uuid and r.room_type_id=${roomType.id}::uuid
      and r.active=true and r.service_status='rentable'
      and not exists (
        select 1 from reservation_rooms rr join reservations rs on rs.id=rr.reservation_id
        where rr.room_id=r.id and rr.status in ('reserved','checked_in') and rs.status in ('reserved','checked_in')
          and rs.arrival_date < ${occupiedUntil}::date and greatest(rs.departure_date, rs.arrival_date + 1) > ${payload.checkInDate}::date
      ) and not exists (
        select 1 from maintenance_orders mo
        where mo.room_id=r.id and mo.rentable=false and mo.status not in ('resolved','cancelled')
          and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockFrom')::date else null end < ${occupiedUntil}::date
          and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockTo')::date else null end >= ${payload.checkInDate}::date
      ) order by r.number for update
  `;
  const selectedRooms = payload.roomNumbers.length
    ? payload.roomNumbers.map((number) => roomsForType.find((room) => room.number === number))
    : [];
  // Rooms may be assigned later (FR-RES-001), so 0..roomCount numbers are valid.
  if (payload.roomNumbers.length > payload.roomCount || new Set(payload.roomNumbers).size !== payload.roomNumbers.length || selectedRooms.some((room) => !room)) throw new ReservationRequestError("Select unique rentable room numbers, no more than the rooms requested.", 409);
  // Unassigned bookings hold room-type inventory without a room, so they must
  // be subtracted from the free rooms or the type could be overbooked.
  const [unassigned] = await tx<Array<{ count: number }>>`
    select count(*)::int as count from reservation_rooms rr join reservations rs on rs.id=rr.reservation_id
    where rr.property_id=${session.propertyId}::uuid and rr.room_type_id=${roomType.id}::uuid and rr.room_id is null
      and rr.status in ('reserved','checked_in') and rs.status in ('reserved','checked_in')
      and rs.arrival_date < ${occupiedUntil}::date and greatest(rs.departure_date, rs.arrival_date + 1) > ${payload.checkInDate}::date
  `;
  if (roomsForType.length - unassigned.count < payload.roomCount) throw new ReservationRequestError("That room type no longer has enough inventory for those dates.", 409);
  if (payload.companyId) {
    const [company] = await tx<Array<{ id: string; status: string }>>`select id,status from companies where id=${payload.companyId}::uuid and property_id=${session.propertyId}::uuid`;
    if (!company || company.status !== "active") throw new ReservationRequestError("Select an active company for Direct Bill.");
  }
  const normalizedId = normalizeId(payload.idNumber);
  const [identity] = await tx<Array<{ guestId: string; guestStatus: string; roomPreferences: unknown }>>`
    select gi.guest_id as "guestId",g.guest_status as "guestStatus",g.room_preferences as "roomPreferences" from guest_identities gi join guests g on g.id=gi.guest_id
    where gi.property_id=${session.propertyId}::uuid and gi.normalized_id_number=${normalizedId} and gi.deleted_at is null for update
  `;
  if (identity?.guestStatus === "do_not_rent" && !payload.dnrOverrideReason) throw new ReservationRequestError("Enter a reason to override the Do Not Rent warning.", 403);
  let guestId = identity?.guestId;
  const address = { addressLine1: payload.addressLine1 ?? "", city: payload.city ?? "", state: payload.state ?? "", postalCode: payload.postalCode ?? "", country: payload.country ?? "", countryCode: payload.countryCode };
  const existingPreferences = identity?.roomPreferences && typeof identity.roomPreferences === "object" && !Array.isArray(identity.roomPreferences)
    ? identity.roomPreferences as Record<string, unknown>
    : {};
  const guestPreferences = {
    ...existingPreferences,
    dateOfBirth: payload.dateOfBirth,
    idExpires: payload.idExpires,
    ...(payload.fixedRateCents !== undefined ? { fixedRateCents: payload.fixedRateCents } : {}),
  };
  if (guestId) await tx`update guests set first_name=${payload.firstName},last_name=${payload.lastName},phone=${normalizePhone(payload.phone)},email=${payload.email || null},address=${tx.json(address)},room_preferences=${tx.json(guestPreferences)},updated_at=now() where id=${guestId}::uuid`;
  else {
    const [guest] = await tx<Array<{ id: string }>>`insert into guests (property_id,first_name,last_name,phone,email,address,guest_status,room_preferences) values (${session.propertyId}::uuid,${payload.firstName},${payload.lastName},${normalizePhone(payload.phone)},${payload.email || null},${tx.json(address)},'active',${tx.json(guestPreferences)}) returning id`;
    guestId = guest.id;
    await tx`insert into guest_identities (property_id,guest_id,id_type,id_number,normalized_id_number,delete_after) values (${session.propertyId}::uuid,${guestId}::uuid,${payload.idType},${payload.idNumber},${normalizedId},now()+interval '1 year')`;
  }
  // A day-use stay is priced as one room charge for its arrival date.
  const nights = dayUse ? 1 : stayNights;
  if (payload.baseNightlyRatesCents.length !== nights || payload.nightlyRatesCents.length !== nights) throw new ReservationRequestError(dayUse ? "Enter the day-use room rate." : "Enter one nightly rate for every night of the stay.");
  const serverNightlyRatesCents = payload.baseNightlyRatesCents.map((rate) => applyStackedPromotions(rate, selectedPromotions));
  if (serverNightlyRatesCents.some((rate, index) => rate !== payload.nightlyRatesCents[index])) {
    throw new ReservationRequestError("Promotion pricing changed. Review the nightly rates and try again.", 409);
  }
  // Booking sources are configured in Settings. Resolve the active record
  // here rather than recreating it with a zero commission on every booking.
  const bookingSources = await tx<Array<{ id: string; name: string; type: string; commissionBasisPoints: number }>>`
    select id,name,type,commission_basis_points as "commissionBasisPoints"
    from booking_sources
    where property_id=${session.propertyId}::uuid and active=true
    for update
  `;
  const bookingSource = bookingSources.find((source) => bookingSourceKey(source.name) === bookingSourceKey(payload.source));
  if (!bookingSource) throw new ReservationRequestError("Select an active booking source configured in Settings.", 409);
  const otaPaymentStatus = bookingSource.type.toLowerCase() === "ota" ? payload.otaPaymentStatus ?? "Guest Pays Hotel" : null;
  const confirmationNumber = `PMS-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 900 + 100)}`;
  const [reservation] = await tx<Array<{ id: string }>>`insert into reservations (property_id,main_guest_id,company_id,confirmation_number,booking_source_id,status,arrival_date,departure_date,group_reservation,tax_rate_basis_points,tax_exempt,tax_exemption_reference,currency_code,ota_payment_status,notes) values (${session.propertyId}::uuid,${guestId}::uuid,${payload.companyId || null}::uuid,${confirmationNumber},${bookingSource.id}::uuid,'reserved',${payload.checkInDate}::date,${payload.checkoutDate}::date,${payload.roomCount > 1},${Math.round(payload.taxRatePercentage * 100)},${payload.taxExempt},${payload.taxExemptionCertificate || null},'USD',${otaPaymentStatus},${tx.json({ adults: payload.adults, children: payload.children, petCount: payload.petCount, servicePetCount: payload.servicePetCount, rateCode: payload.rateCode, source: bookingSource.name })}::text) returning id`;
  for (const [appliedOrder, promotionId] of payload.promotionIds.entries()) {
    await tx`insert into reservation_promotions (property_id,reservation_id,promotion_id,applied_order) values (${session.propertyId}::uuid,${reservation.id}::uuid,${promotionId}::uuid,${appliedOrder})`;
  }
  await tx`insert into reservation_guests (property_id,reservation_id,guest_id,"primary") values (${session.propertyId}::uuid,${reservation.id}::uuid,${guestId}::uuid,true) on conflict (reservation_id,guest_id) do update set "primary"=true`;
  if (identity?.guestStatus === "do_not_rent" && payload.dnrOverrideReason) {
    // Keep the reason with the specific stay. A guest profile may later be
    // changed, but the approval decision for this reservation must remain an
    // immutable operational record.
    await tx`insert into dnr_overrides (property_id,reservation_id,guest_id,reason)
      values (${session.propertyId}::uuid,${reservation.id}::uuid,${guestId}::uuid,${payload.dnrOverrideReason})`;
  }
  const reservationRoomsCreated: Array<{ id: string; roomNumber: number }> = [];
  for (let index = 0; index < payload.roomCount; index += 1) {
    const [reservationRoom] = await tx<Array<{ id: string }>>`insert into reservation_rooms (property_id,reservation_id,room_type_id,room_id,status) values (${session.propertyId}::uuid,${reservation.id}::uuid,${roomType.id}::uuid,${selectedRooms[index]?.id || null}::uuid,'reserved') returning id`;
    reservationRoomsCreated.push({ id: reservationRoom.id, roomNumber: index + 1 });
  }
  // A group starts with one shared folio. This is important: it lets the
  // front desk collect one payment for the complete stay, while checkout can
  // later split a departing room into its own folio. Single-room stays keep
  // their room-specific folio as before.
  let sharedGroupFolioId: string | null = null;
  let primaryFolioId: string | null = null;
  if (payload.roomCount > 1) {
    const folioNumber = await allocateProductionDocumentNumber(tx, session.propertyId);
    const [folio] = await tx<Array<{ id: string }>>`
      insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
      values (${session.propertyId}::uuid,${reservation.id}::uuid,null,${folioNumber},'Group Folio','open')
      returning id
    `;
    sharedGroupFolioId = folio.id;
  }
  for (const reservationRoom of reservationRoomsCreated) {
    let folioId = sharedGroupFolioId;
    if (!folioId) {
      const folioNumber = await allocateProductionDocumentNumber(tx, session.propertyId);
      const [folio] = await tx<Array<{ id: string }>>`
        insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
        values (${session.propertyId}::uuid,${reservation.id}::uuid,${reservationRoom.id}::uuid,${folioNumber},'Room & Tax Folio','open')
        returning id
      `;
      folioId = folio.id;
    }
    primaryFolioId ??= folioId;
    for (let night = 0; night < nights; night += 1) {
      const date = new Date(`${payload.checkInDate}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + night);
      const stayDate = date.toISOString().slice(0, 10);
      const baseRate = payload.baseNightlyRatesCents[night];
      const rate = payload.nightlyRatesCents[night];
      await tx`insert into nightly_rates (property_id,reservation_room_id,stay_date,base_rate_cents,discount_cents,final_rate_cents) values (${session.propertyId}::uuid,${reservationRoom.id}::uuid,${stayDate}::date,${baseRate},${baseRate - rate},${rate})`;
      const [charge] = await tx<Array<{ id: string }>>`
        insert into charges (property_id,folio_id,reservation_room_id,type,description,service_date,amount_cents,taxable,status)
        values (${session.propertyId}::uuid,${folioId}::uuid,${reservationRoom.id}::uuid,'Room Rent',${`Room ${selectedRooms[reservationRoom.roomNumber - 1]?.number ?? reservationRoom.roomNumber} · ${dayUse ? "Day use · " : ""}${stayDate}`},${stayDate}::date,${rate},${!payload.taxExempt},'posted')
        returning id
      `;
      // Initial room rent is a financial posting just like a manually added
      // folio charge. Keeping both entries in this transaction means a
      // created reservation is immediately represented in Revenue and can
      // never leave an unbalanced partial ledger behind.
      // A zero-dollar rate is a valid configured rate (for example, a
      // complimentary or rate-exempt stay).  Keep the charge as an auditable
      // stay record, but do not attempt a zero-value double-entry posting:
      // accounting correctly rejects those entries.
      if (rate > 0) await postProductionLedger(tx, {
        propertyId: session.propertyId,
        businessDate: stayDate,
        resourceType: "charge",
        resourceId: charge.id,
        description: `Room rent · ${stayDate}`,
        debitAccount: "Guest Receivable",
        creditAccount: "Room Revenue",
        amountCents: rate,
      });
      if (!payload.taxExempt) {
        const taxCents = calculateTaxCents(rate, payload.taxRatePercentage / 100);
        await tx`insert into charge_taxes (property_id,charge_id,name,rate_basis_points,amount_cents) values (${session.propertyId}::uuid,${charge.id}::uuid,'Room Tax',${Math.round(payload.taxRatePercentage * 100)},${taxCents})`;
        if (taxCents > 0) await postProductionLedger(tx, {
          propertyId: session.propertyId,
          businessDate: stayDate,
          resourceType: "charge-tax",
          resourceId: charge.id,
          description: `Room rent tax · ${stayDate}`,
          debitAccount: "Guest Receivable",
          creditAccount: "Tax Payable",
          amountCents: taxCents,
        });
      }
    }
  }
  const roomRentCents = payload.nightlyRatesCents.reduce((sum, rate) => sum + rate, 0) * payload.roomCount;
  const taxCents = payload.taxExempt ? 0 : calculateTaxCents(roomRentCents, payload.taxRatePercentage / 100);
  const ota = calculateOtaBreakdown({ roomRentCents, taxCents, commissionPercent: bookingSource.commissionBasisPoints / 100, paymentStatus: otaPaymentStatus });
  const commissionCents = ota.commissionCents;
  // Commission is an expense (FR-REV-001). When the OTA collected the stay it
  // keeps the commission, so the helper settles it on the folio and the guest
  // balance becomes the net the OTA remits.
  await setReservationCommission(tx, {
    propertyId: session.propertyId,
    reservationId: reservation.id,
    targetCents: commissionCents,
    businessDate: payload.checkInDate,
    reason: "Booking commission",
  });
  const totalCents = roomRentCents + taxCents;
  const [roomTypeName] = await tx<Array<{ name: string }>>`select name from room_types where id=${roomType.id}::uuid`;
  const roomLabel = selectedRooms.length ? `Room ${selectedRooms.map((room) => room!.number).join(", ")}` : "room unassigned";
  await logReservationActivity(tx, session, reservation.id, "Reservation", `Reservation created · ${confirmationNumber} · ${payload.firstName} ${payload.lastName} · ${payload.checkInDate} → ${payload.checkoutDate}${dayUse ? " (day use)" : ""} · ${payload.roomCount} × ${roomTypeName?.name ?? "room"}, ${roomLabel} · ${payload.rateCode} · ${bookingSource.name} · total ${money(totalCents)}${payload.companyId ? " · direct bill" : ""}${payload.taxExempt ? " · tax exempt" : ""}`);
  if (commissionCents > 0) await logReservationActivity(tx, session, reservation.id, "Commission", `OTA commission ${money(commissionCents)} (${bookingSource.commissionBasisPoints / 100}%) · ${otaPaymentStatus ?? "payable by hotel"}`);
  if (identity?.guestStatus === "do_not_rent" && payload.dnrOverrideReason) await logReservationActivity(tx, session, reservation.id, "Guest", `Do Not Rent override approved: ${payload.dnrOverrideReason}`);
  return { guestId, reservationId: reservation.id, groupReservation: payload.roomCount > 1, roomRateCents: payload.nightlyRatesCents[0] ?? roomType.baseRateCents, roomRentCents, taxCents, commissionCents, otaNetCents: ota.netCents, otaPaymentStatus, totalCents, balanceCents: ota.commissionDeducted ? ota.netCents : totalCents, version: 1 };
}

export async function POST(request: Request) {
  let session;
  try {
    session = await requirePropertySession(request, "reservations.manage");
  } catch (error) {
    return propertyAccessResponse(error);
  }
  if (hasProductionDatabase()) return createProductionReservation(request, session);
  const { propertyId } = session;
  try {
  const parsed = payloadSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Required guest and stay details are missing.", issues: parsed.error.flatten() }, { status: 400 });
  }
  const payload = parsed.data;
  if (payload.checkoutDate <= payload.checkInDate) {
    return NextResponse.json({ error: "Check-out must be after check-in." }, { status: 400 });
  }

  const candidateRooms = await db.query.rooms.findMany({
    where: and(eq(rooms.propertyId, propertyId), eq(rooms.roomTypeId, payload.roomTypeId)),
  });
  const rentableRooms = candidateRooms.filter((room) => room.active && room.serviceStatus === "in-service");
  const selectedRooms = payload.roomNumbers.map((number) => rentableRooms.find((room) => room.number === number));
  if (payload.roomNumbers.length !== payload.roomCount || new Set(payload.roomNumbers).size !== payload.roomNumbers.length || selectedRooms.some((room) => !room)) {
    return NextResponse.json({ error: "Select one unique rentable room number for every requested room." }, { status: 409 });
  }

  const license = normalizeId(payload.idNumber);
  const guest = await db.query.guests.findFirst({
    where: and(eq(guests.propertyId, propertyId), eq(guests.driverLicenseNormalized, license)),
  });
  if (guest?.guestStatus === "Do Not Rent" && !payload.dnrOverrideReason) {
    return NextResponse.json({ error: "Enter a reason to override the Do Not Rent warning." }, { status: 403 });
  }

  if (payload.companyId) {
    const company = await db.query.companies.findFirst({ where: and(eq(companies.id, payload.companyId), eq(companies.propertyId, propertyId)) });
    if (!company || company.status !== "Active") {
      return NextResponse.json({ error: "Select an active company for Direct Bill." }, { status: 400 });
    }
  }

  const existingRoomReservations = await db.query.reservations.findMany({
    where: and(eq(reservations.propertyId, propertyId), eq(reservations.roomTypeId, payload.roomTypeId), inArray(reservations.status, ["Reserved", "Checked In"])),
  });
  const overlappingReservations = existingRoomReservations.filter(
    (reservation) => reservation.arrivalDate < payload.checkoutDate && reservation.departureDate > payload.checkInDate,
  );
  const existingRoomStays = await db.query.reservationRooms.findMany({
    where: inArray(reservationRooms.reservationId, overlappingReservations.map((reservation) => reservation.id)),
  });
  if (payload.roomCount > rentableRooms.length - existingRoomStays.length) {
    return NextResponse.json({ error: "That room type no longer has enough inventory for those dates." }, { status: 409 });
  }
  const assignedRoomIds = new Set(selectedRooms.flatMap((room) => room ? [room.id] : []));
  if (existingRoomStays.some((stay) => stay.roomId && assignedRoomIds.has(stay.roomId))) {
    return NextResponse.json({ error: "One of the selected rooms is no longer available." }, { status: 409 });
  }

  const roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, payload.roomTypeId), eq(roomTypes.propertyId, propertyId)) });
  if (!roomType || !roomType.active) {
    return NextResponse.json({ error: "Select an active room type." }, { status: 409 });
  }
  const channel = await db.query.bookingChannels.findFirst({
    where: and(eq(bookingChannels.propertyId, propertyId), eq(bookingChannels.name, payload.source)),
  });
  const nights = Math.round((new Date(`${payload.checkoutDate}T12:00:00Z`).getTime() - new Date(`${payload.checkInDate}T12:00:00Z`).getTime()) / 86_400_000);
  if (payload.nightlyRatesCents.length !== nights) {
    return NextResponse.json({ error: "Enter one nightly rate for every night of the stay." }, { status: 400 });
  }
  if (payload.taxExempt && (!payload.taxExemptionReason || !payload.taxExemptionCertificate)) {
    return NextResponse.json({ error: "Tax-exempt stays require a reason and certificate number." }, { status: 400 });
  }
  const roomRateCents = payload.nightlyRatesCents[0] ?? roomType.baseRateCents;
  const roomRentCents = payload.nightlyRatesCents.reduce((sum, rateCents) => sum + rateCents, 0) * payload.roomCount;
  const taxRateBasisPoints = Math.round(payload.taxRatePercentage * 100);
  const taxCents = payload.taxExempt ? 0 : calculateTaxCents(roomRentCents, payload.taxRatePercentage / 100);
  const commissionCents = calculateCommissionCents(roomRentCents, (channel?.commissionBasisPoints ?? 0) / 100);
  const now = new Date().toISOString();
  const guestId = guest?.id ?? `guest-${crypto.randomUUID()}`;
  const reservationId = `reservation-${crypto.randomUUID()}`;

  db.transaction((tx) => {
    if (guest) {
      tx.update(guests).set({
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone: payload.phone,
        phoneNormalized: normalizePhone(payload.phone),
        idType: payload.idType,
        dateOfBirth: payload.dateOfBirth,
        idExpires: payload.idExpires,
        addressLine1: payload.addressLine1 || null,
        postalCode: payload.postalCode || null,
        city: payload.city || null,
        state: payload.state || null,
        country: payload.country || null,
        countryCode: payload.countryCode,
        secondaryPhone: payload.secondaryPhone || null,
        email: payload.email || null,
        secondaryEmail: payload.secondaryEmail || null,
        updatedAt: now,
      }).where(eq(guests.id, guest.id)).run();
    } else {
      tx.insert(guests).values({
        id: guestId,
        propertyId,
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone: payload.phone,
        phoneNormalized: normalizePhone(payload.phone),
        idType: payload.idType,
        driverLicenseNumber: payload.idNumber,
        driverLicenseNormalized: license,
        dateOfBirth: payload.dateOfBirth,
        idExpires: payload.idExpires,
        addressLine1: payload.addressLine1 || null,
        postalCode: payload.postalCode || null,
        city: payload.city || null,
        state: payload.state || null,
        country: payload.country || null,
        countryCode: payload.countryCode,
        secondaryPhone: payload.secondaryPhone || null,
        email: payload.email || null,
        secondaryEmail: payload.secondaryEmail || null,
        guestStatus: "New",
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    tx.insert(reservations).values({
      id: reservationId,
      propertyId,
      guestId,
      roomId: selectedRooms[0]?.id ?? null,
      roomTypeId: roomType.id,
      companyId: payload.companyId || null,
      confirmationNumber: `SSI-${Date.now().toString().slice(-8)}`,
      source: payload.source,
      status: "Reserved",
      arrivalDate: payload.checkInDate,
      departureDate: payload.checkoutDate,
      adultCount: payload.adults,
      childCount: payload.children,
      roomRateCents,
      nightlyRatesJson: JSON.stringify(payload.nightlyRatesCents),
      promotionIdsJson: JSON.stringify(payload.promotionIds),
      taxRateBasisPoints,
      taxExempt: payload.taxExempt,
      taxExemptionReason: payload.taxExemptionReason || null,
      taxExemptionCertificate: payload.taxExemptionCertificate || null,
      otaPaymentStatus: channel?.channelType === "OTA" ? payload.otaPaymentStatus ?? "Guest Pays Hotel" : null,
      paymentArrangement: payload.companyId ? "Direct Bill" : "Not entered",
      rateCode: payload.rateCode,
      petCount: payload.petCount,
      servicePetCount: payload.servicePetCount,
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(reservationRooms).values(Array.from({ length: payload.roomCount }, (_, index) => ({
      id: `reservation-room-${crypto.randomUUID()}`,
      propertyId,
      reservationId,
      roomTypeId: roomType.id,
      roomId: selectedRooms[index]?.id ?? null,
      status: "Reserved",
      createdAt: now,
      updatedAt: now,
    }))).run();
    tx.insert(reservationCharges).values(payload.nightlyRatesCents.flatMap((nightlyRateCents, nightIndex) => Array.from({ length: payload.roomCount }, (_, roomIndex) => {
      const nightlyTaxCents = payload.taxExempt ? 0 : calculateTaxCents(nightlyRateCents, payload.taxRatePercentage / 100);
      return {
        id: `charge-${crypto.randomUUID()}`,
        reservationId,
        type: "Room Rent",
        description: `Room ${roomIndex + 1} · Night ${nightIndex + 1}`,
        serviceDate: new Date(new Date(`${payload.checkInDate}T12:00:00Z`).getTime() + nightIndex * 86_400_000).toISOString().slice(0, 10),
        quantity: 1,
        unitAmountCents: nightlyRateCents,
        amountCents: nightlyRateCents,
        taxable: !payload.taxExempt,
        taxAmountCents: nightlyTaxCents,
        status: "Posted",
        createdAt: now,
      };
    }))).run();
  });

  // Change notifications must never turn a committed reservation into a
  // failed browser request. The reservation transaction above is authoritative.
  try {
    await recordChange({
      propertyId,
      actorAuthUserId: session.authUserId,
      entityType: "reservation",
      entityId: reservationId,
      action: "created",
      entityVersion: 1,
      payload: {
        reservation: {
          id: reservationId,
          version: 1,
          firstName: payload.firstName,
          lastName: payload.lastName,
          phone: payload.phone,
          room: payload.roomNumbers[0] ?? "Unassigned",
          groupReservation: payload.roomCount > 1,
          checkInDate: payload.checkInDate,
          checkoutDate: payload.checkoutDate,
          checkInTime: "3:00 PM",
          nights,
          source: payload.source,
          paymentType: payload.companyId ? "Direct Bill" : "Not entered",
          roomRentCents,
          taxCents,
          totalCents: roomRentCents + taxCents,
          balanceCents: roomRentCents + taxCents,
          status: "Reserved",
        },
      },
    });
  } catch (error) {
    console.error("Reservation change event failed", { propertyId, reservationId, error });
  }

  return NextResponse.json({
    guestId,
    reservationId,
    groupReservation: payload.roomCount > 1,
    roomRateCents,
    roomRentCents,
    taxCents,
    commissionCents,
    totalCents: roomRentCents + taxCents,
    version: 1,
  }, { status: 201 });
  } catch (error) {
    // Do not let an unhandled database or JSON parsing error become an empty
    // Vercel response. The client can now explain that the request failed.
    console.error("Reservation creation failed", { propertyId, error });
    return NextResponse.json({ error: "Reservation could not be created. Please verify the room and guest details, then try again." }, { status: 500 });
  }
}

const updateSchema = z.object({
  id: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  status: z.enum(["Reserved", "Checked In", "Checked Out", "Cancelled", "No Show"]).optional(),
  notes: z.string().nullable().optional(),
  arrivalDate: z.string().optional(),
  departureDate: z.string().optional(),
  extensionNightlyRateCents: z.number().int().nonnegative().optional(),
  // Occupancy and pets are stay details kept in the reservation notes.
  details: z.object({
    adults: z.number().int().min(1).max(20).optional(),
    children: z.number().int().min(0).max(20).optional(),
    petCount: z.number().int().min(0).max(10).optional(),
    servicePetCount: z.number().int().min(0).max(10).optional(),
  }).optional(),
  // One new dated remark for a department section.
  remark: z.object({ section: z.enum(["booking", "stay", "housekeeping", "other"]), text: z.string().trim().min(1).max(2_000) }).optional(),
  // Group check-in sends the rooms with their intended status so only the
  // selected rooms change.
  reservationRooms: z.array(z.object({ id: z.string().min(1), status: z.string() }).passthrough()).optional(),
});

function productionReservationStatus(status: NonNullable<z.infer<typeof updateSchema>["status"]>) {
  return status === "Reserved" ? "reserved" : status === "Checked In" ? "checked_in" : status === "Checked Out" ? "checked_out" : status === "No Show" ? "no_show" : "cancelled";
}

async function updateProductionReservation(
  session: PropertySession,
  id: string,
  expectedVersion: number,
  changes: Omit<z.infer<typeof updateSchema>, "id" | "expectedVersion">,
) {
  try {
    const outcome = await productionSql().begin(async (tx) => {
      const [current] = await tx<Array<{ id: string; version: number; status: string; arrivalDate: string; departureDate: string; taxExempt: boolean; taxRateBasisPoints: number; notes: string | null }>>`
        select id,version,status,arrival_date::text as "arrivalDate",departure_date::text as "departureDate",tax_exempt as "taxExempt",tax_rate_basis_points as "taxRateBasisPoints",notes
        from reservations where id=${id}::uuid and property_id=${session.propertyId}::uuid for update
      `;
      if (!current) return { kind: "not-found" as const };
      if (current.version !== expectedVersion) return { kind: "conflict" as const, currentVersion: current.version };
      // Lifecycle changes with financial effects have dedicated workflows
      // (checkout, cancel/no-show, reinstate). PATCH may only check guests in.
      if (changes.status && changes.status !== "Checked In" && productionReservationStatus(changes.status) !== current.status) {
        throw new ReservationRequestError(
          changes.status === "Checked Out" ? "Use Check Out so the balance and deposits are verified."
            : changes.status === "Reserved" ? "Use Reinstate to restore a cancelled or No Show reservation."
            : "Use Cancel Reservation or Mark No Show so room charges are reversed.",
          409,
        );
      }
      if (changes.status === "Checked In") {
        if (current.status !== "reserved" && current.status !== "checked_in") throw new ReservationRequestError("Only a reserved stay can be checked in.", 409);
        const [openDay] = await tx<Array<{ date: string }>>`select business_date::text as date from business_days where property_id=${session.propertyId}::uuid and status='open' order by business_date limit 1`;
        if (openDay && current.arrivalDate > openDay.date) throw new ReservationRequestError("This reservation cannot be checked in before its arrival date.", 409);
      }

      const nextArrival = changes.arrivalDate ?? current.arrivalDate;
      const nextDeparture = changes.departureDate ?? current.departureDate;
      if (nextDeparture < nextArrival) throw new ReservationRequestError("Check-out cannot be before check-in.");

      const postedRentCents = async () => {
        const [row] = await tx<Array<{ cents: number }>>`
          select coalesce(sum(c.amount_cents),0)::int as cents from charges c
          where c.reservation_room_id in (select id from reservation_rooms where reservation_id=${id}::uuid)
            and c.type='Room Rent' and c.status='posted'
        `;
        return row.cents;
      };
      const rentBeforeCents = changes.departureDate && changes.departureDate !== current.departureDate ? await postedRentCents() : 0;
      if (changes.departureDate && changes.departureDate !== current.departureDate) {
        const roomRows = await tx<Array<{ id: string; folioId: string | null }>>`
          -- A group shares one folio with no room link; extend onto it rather
          -- than opening a new folio per room.
          select rr.id, coalesce(f.id,(select gf.id from folios gf where gf.reservation_id=rr.reservation_id order by gf.created_at limit 1)) as "folioId"
          from reservation_rooms rr
          left join folios f on f.reservation_room_id=rr.id
          where rr.reservation_id=${id}::uuid and rr.property_id=${session.propertyId}::uuid for update of rr
        `;
        if (changes.departureDate > current.departureDate) {
          // The added nights must be free in every assigned room; otherwise
          // the extension would double-book a room another guest holds.
          const addedFrom = current.departureDate === current.arrivalDate ? addDays(current.arrivalDate, 1) : current.departureDate;
          if (addedFrom < changes.departureDate) {
            const [clash] = await tx<Array<{ number: string }>>`
              select room.number from reservation_rooms rr
              join rooms room on room.id=rr.room_id
              where rr.reservation_id=${id}::uuid and (
                exists (
                  select 1 from reservation_rooms other_rr join reservations other on other.id=other_rr.reservation_id
                  where other_rr.room_id=rr.room_id and other.id<>${id}::uuid
                    and other_rr.status in ('reserved','checked_in') and other.status in ('reserved','checked_in')
                    and other.arrival_date < ${changes.departureDate}::date and greatest(other.departure_date, other.arrival_date + 1) > ${addedFrom}::date
                ) or exists (
                  select 1 from maintenance_orders mo
                  where mo.room_id=rr.room_id and mo.rentable=false and mo.status not in ('resolved','cancelled')
                    and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockFrom')::date else null end < ${changes.departureDate}::date
                    and case when mo.notes like '{%' then (mo.notes::jsonb->>'blockTo')::date else null end >= ${addedFrom}::date
                )
              ) limit 1
            `;
            if (clash) throw new ReservationRequestError(`Room ${clash.number} is booked or blocked on the added nights. Move the guest to a free room first.`, 409);
          }
          for (const roomRow of roomRows) {
            let folioId = roomRow.folioId;
            if (!folioId) {
              const number = await allocateProductionDocumentNumber(tx, session.propertyId);
              const [folio] = await tx<Array<{ id: string }>>`
                insert into folios (property_id,reservation_id,reservation_room_id,number,name,status)
                values (${session.propertyId}::uuid,${id}::uuid,${roomRow.id}::uuid,${number},'Room & Tax Folio','open')
                returning id
              `;
              folioId = folio.id;
            }
            const [lastRate] = await tx<Array<{ finalRateCents: number }>>`
              select final_rate_cents as "finalRateCents" from nightly_rates
              where reservation_room_id=${roomRow.id}::uuid
              order by stay_date desc limit 1
            `;
            const nightlyRateCents = changes.extensionNightlyRateCents ?? lastRate?.finalRateCents ?? 0;
            for (let stayDate = current.departureDate; stayDate < changes.departureDate;) {
              await tx`
                insert into nightly_rates (property_id,reservation_room_id,stay_date,base_rate_cents,discount_cents,final_rate_cents)
                values (${session.propertyId}::uuid,${roomRow.id}::uuid,${stayDate}::date,${nightlyRateCents},0,${nightlyRateCents})
                on conflict (reservation_room_id,stay_date) do update set base_rate_cents=excluded.base_rate_cents,discount_cents=excluded.discount_cents,final_rate_cents=excluded.final_rate_cents
              `;
              const [existingCharge] = await tx<Array<{ id: string }>>`
                select id from charges where reservation_room_id=${roomRow.id}::uuid
                  and type='Room Rent' and status='posted' and service_date=${stayDate}::date limit 1
              `;
              if (!existingCharge) {
                const [charge] = await tx<Array<{ id: string }>>`
                  insert into charges (property_id,folio_id,reservation_room_id,type,description,service_date,amount_cents,taxable,status)
                  values (${session.propertyId}::uuid,${folioId}::uuid,${roomRow.id}::uuid,'Room Rent',${`Extended stay · ${stayDate}`},${stayDate}::date,${nightlyRateCents},${!current.taxExempt},'posted')
                  returning id
                `;
                // Extended nights must reach the ledger like booked nights or
                // Revenue would never include them.
                if (nightlyRateCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: stayDate, resourceType: "charge", resourceId: charge.id, description: `Extended stay · ${stayDate}`, debitAccount: "Guest Receivable", creditAccount: "Room Revenue", amountCents: nightlyRateCents });
                if (!current.taxExempt) {
                  const taxCents = calculateTaxCents(nightlyRateCents, current.taxRateBasisPoints / 10_000);
                  await tx`insert into charge_taxes (property_id,charge_id,name,rate_basis_points,amount_cents) values (${session.propertyId}::uuid,${charge.id}::uuid,'Room Tax',${current.taxRateBasisPoints},${taxCents})`;
                  if (taxCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: stayDate, resourceType: "charge-tax", resourceId: charge.id, description: `Extended stay tax · ${stayDate}`, debitAccount: "Guest Receivable", creditAccount: "Tax Payable", amountCents: taxCents });
                }
              }
              const next = new Date(`${stayDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
              stayDate = next.toISOString().slice(0, 10);
            }
          }
        } else {
          // Shortened stay (early departure): void the unused nights and
          // reverse their revenue/tax, as cancellation does, so Revenue and
          // the ledger stay in step with the folio.
          // Shortening to the arrival date makes a day-use stay: its arrival
          // night stays as the day-use charge.
          const keepBefore = changes.departureDate === nextArrival ? addDays(nextArrival, 1) : changes.departureDate;
          const unused = await tx<Array<{ id: string; serviceDate: string; amountCents: number; taxCents: number }>>`
            select c.id,c.service_date::text as "serviceDate",c.amount_cents as "amountCents",
              coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)::int as "taxCents"
            from charges c
            where c.reservation_room_id in (select id from reservation_rooms where reservation_id=${id}::uuid)
              and c.type='Room Rent' and c.status='posted' and c.service_date >= ${keepBefore}::date
            for update
          `;
          if (unused.length) await tx`update charges set status='voided',updated_at=now() where id in ${tx(unused.map((charge) => charge.id))}`;
          const businessDate = await propertyBusinessDate(tx, session.propertyId);
          for (const charge of unused) {
            if (charge.amountCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: reversalBusinessDate(businessDate, charge.serviceDate), resourceType: "stay-shortened", resourceId: id, description: `Early departure room-rent reversal · ${charge.serviceDate}`, debitAccount: "Room Revenue", creditAccount: "Guest Receivable", amountCents: charge.amountCents });
            if (charge.taxCents > 0) await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: reversalBusinessDate(businessDate, charge.serviceDate), resourceType: "stay-shortened-tax", resourceId: id, description: `Early departure room-tax reversal · ${charge.serviceDate}`, debitAccount: "Tax Payable", creditAccount: "Guest Receivable", amountCents: charge.taxCents });
          }
          await tx`
            delete from nightly_rates where reservation_room_id in (
              select id from reservation_rooms where reservation_id=${id}::uuid
            ) and stay_date >= ${keepBefore}::date
          `;
        }
      }

      // OTA commission follows the room rent actually stayed: scale an unpaid
      // commission (including a manual edit) with the change in rent.
      if (changes.departureDate && changes.departureDate !== current.departureDate && rentBeforeCents > 0) {
        const commission = await readReservationCommission(tx, session.propertyId, id);
        if (commission.commissionCents > 0 && (commission.deducted || commission.paidCents === 0)) {
          const rentAfterCents = await postedRentCents();
          await setReservationCommission(tx, {
            propertyId: session.propertyId,
            reservationId: id,
            targetCents: Math.round(commission.commissionCents * rentAfterCents / rentBeforeCents),
            businessDate: await propertyBusinessDate(tx, session.propertyId),
            reason: "Stay dates changed",
          });
        }
      }
      const databaseStatus = changes.status ? productionReservationStatus(changes.status) : null;
      if (databaseStatus === "checked_in") {
        const requested = changes.reservationRooms?.filter((room) => room.status === "Checked In").map((room) => room.id);
        const rooms = await tx<Array<{ id: string; roomId: string | null; status: string }>>`
          select id,room_id as "roomId",status from reservation_rooms
          where reservation_id=${id}::uuid and property_id=${session.propertyId}::uuid for update
        `;
        const toCheckIn = rooms.filter((room) => room.status === "reserved" && (!requested || requested.includes(room.id)));
        if (toCheckIn.some((room) => !room.roomId)) throw new ReservationRequestError("Assign a room number before checking this room in.", 409);
        if (toCheckIn.length) {
          await tx`
            update reservation_rooms set status='checked_in',checked_in_at=now(),updated_at=now()
            where id in ${tx(toCheckIn.map((room) => room.id))} and property_id=${session.propertyId}::uuid
          `;
          const numbers = await tx<Array<{ number: string }>>`select number from rooms where id in ${tx(toCheckIn.map((room) => room.roomId!))} order by number`;
          await logReservationActivity(tx, session, id, "Status", `Checked in · Room ${numbers.map((room) => room.number).join(", ")}`);
        }
      }
      // Stay details and remarks live in the notes JSON; merge rather than
      // overwrite so lifecycle history and booking details are kept.
      let nextNotes = changes.notes !== undefined ? changes.notes ?? null : current.notes;
      if (changes.details || changes.remark) {
        let stored: Record<string, unknown> = {};
        try {
          const parsed = nextNotes ? JSON.parse(nextNotes) : {};
          stored = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { legacyNotes: nextNotes };
        } catch {
          stored = { legacyNotes: nextNotes };
        }
        if (changes.details) stored = { ...stored, ...changes.details };
        if (changes.remark) {
          const remarks = (stored.remarks && typeof stored.remarks === "object" ? stored.remarks : {}) as Record<string, Array<{ id: string; text: string; createdAt: string }>>;
          const list = Array.isArray(remarks[changes.remark.section]) ? remarks[changes.remark.section] : [];
          stored.remarks = { ...remarks, [changes.remark.section]: [...list, { id: crypto.randomUUID(), text: changes.remark.text, createdAt: new Date().toISOString() }].slice(-200) };
          await logReservationActivity(tx, session, id, "Reservation", `Remark added (${changes.remark.section}): ${changes.remark.text.slice(0, 300)}`);
        }
        nextNotes = JSON.stringify(stored);
      }
      for (const change of describeNoteChanges(current.notes, nextNotes)) await logReservationActivity(tx, session, id, "Stay", change);
      if (nextArrival !== current.arrivalDate || nextDeparture !== current.departureDate) {
        const parts = [
          nextArrival !== current.arrivalDate ? `arrival ${current.arrivalDate} → ${nextArrival}` : "",
          nextDeparture !== current.departureDate ? `departure ${current.departureDate} → ${nextDeparture}` : "",
        ].filter(Boolean).join(", ");
        const extended = nextDeparture > current.departureDate && changes.extensionNightlyRateCents !== undefined ? ` · added nights at ${money(changes.extensionNightlyRateCents)}` : "";
        await logReservationActivity(tx, session, id, "Stay", `${nextDeparture > current.departureDate ? "Stay extended" : nextDeparture < current.departureDate ? "Stay shortened" : "Stay dates changed"}: ${parts}${extended}`);
      }
      await tx`
        update reservations set
          arrival_date=${nextArrival}::date,
          departure_date=${nextDeparture}::date,
          status=coalesce(${databaseStatus},status),
          notes=${nextNotes},
          version=version+1,
          updated_at=now()
        where id=${id}::uuid and property_id=${session.propertyId}::uuid
      `;
      return { kind: "updated" as const, version: expectedVersion + 1 };
    });
    if (outcome.kind === "not-found") return Response.json({ error: "Reservation not found.", code: "NOT_FOUND" }, { status: 404 });
    if (outcome.kind === "conflict") return Response.json({ error: "Another employee changed this reservation. Review the latest version before saving.", code: "EDIT_CONFLICT", currentVersion: outcome.currentVersion }, { status: 409 });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "reservation", entityId: id, action: "updated", entityVersion: outcome.version, payload: {} });
    return Response.json({ id, version: outcome.version, ...changes });
  } catch (error) {
    if (error instanceof ReservationRequestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Production reservation update failed", { propertyId: session.propertyId, id, error });
    return Response.json({ error: "The reservation update could not be saved." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  let session;
  try {
    session = await requirePropertySession(request, "reservations.manage");
  } catch (error) {
    return propertyAccessResponse(error);
  }
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "The reservation update is invalid.", issues: parsed.error.flatten() }, { status: 400 });
  const { id, expectedVersion, ...changes } = parsed.data;
  if (changes.arrivalDate && changes.departureDate && changes.departureDate < changes.arrivalDate) {
    return Response.json({ error: "Check-out cannot be before check-in." }, { status: 400 });
  }
  if (hasProductionDatabase()) return updateProductionReservation(session, id, expectedVersion, changes);
  const now = new Date().toISOString();
  const result = db.update(reservations).set({
    ...(changes.status ? { status: changes.status } : {}),
    ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
    ...(changes.arrivalDate ? { arrivalDate: changes.arrivalDate } : {}),
    ...(changes.departureDate ? { departureDate: changes.departureDate } : {}),
    version: expectedVersion + 1,
    updatedAt: now,
  }).where(and(
    eq(reservations.id, id),
    eq(reservations.propertyId, session.propertyId),
    eq(reservations.version, expectedVersion),
  )).run();
  if (result.changes === 0) {
    const current = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, session.propertyId)),
    });
    return Response.json({
      error: current ? "Another employee changed this reservation. Review the latest version before saving." : "Reservation not found.",
      code: current ? "EDIT_CONFLICT" : "NOT_FOUND",
      currentVersion: current?.version,
      current,
    }, { status: current ? 409 : 404 });
  }
  await recordChange({
    propertyId: session.propertyId,
    actorAuthUserId: session.authUserId,
    entityType: "reservation",
    entityId: id,
    action: "updated",
    entityVersion: expectedVersion + 1,
    payload: { changes },
  });
  return Response.json({ id, version: expectedVersion + 1, ...changes });
}
