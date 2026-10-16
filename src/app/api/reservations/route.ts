import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/server/db/client";
import { calculateCommissionCents } from "@/domain/rules/commission";
import { calculateTaxCents } from "@/domain/rules/tax";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { bookingChannels, companies, guests, reservationCharges, reservationRooms, reservations, rooms, roomTypes } from "@/server/db/schema";
import { recordChange } from "@/server/realtime/change-events";

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
  nightlyRatesCents: z.array(z.number().int().nonnegative()).min(1),
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

export async function POST(request: Request) {
  let session;
  try {
    session = await requirePropertySession(request, "reservations.manage");
  } catch (error) {
    return propertyAccessResponse(error);
  }
  const { propertyId } = session;
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
  if (selectedRooms.some((room) => !room) || payload.roomNumbers.length > payload.roomCount) {
    return NextResponse.json({ error: "One or more selected rooms are not rentable." }, { status: 409 });
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
      paymentArrangement: payload.companyId ? "Direct Bill" : "Credit",
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

  recordChange({
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
        paymentType: payload.companyId ? "Direct Bill" : "Credit",
        roomRentCents,
        taxCents,
        totalCents: roomRentCents + taxCents,
        balanceCents: roomRentCents + taxCents,
        status: "Reserved",
      },
    },
  });

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
}

const updateSchema = z.object({
  id: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  status: z.enum(["Reserved", "Checked In", "Checked Out", "Cancelled", "No Show"]).optional(),
  notes: z.string().nullable().optional(),
  arrivalDate: z.string().optional(),
  departureDate: z.string().optional(),
});

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
  if (changes.arrivalDate && changes.departureDate && changes.departureDate <= changes.arrivalDate) {
    return Response.json({ error: "Check-out must be after check-in." }, { status: 400 });
  }
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
  recordChange({
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
