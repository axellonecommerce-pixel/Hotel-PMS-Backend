import { defaultSettings } from "@/config/default-settings";
import { initialCashDrops } from "@/data/mock/cash-drops";
import { companyDirectory } from "@/data/mock/company-directory";
import { initialExpenses } from "@/data/mock/expenses";
import { initialHousekeepers, initialHousekeepingTasks, initialTimeEntries } from "@/data/mock/housekeeping";
import { mockGuests } from "@/data/mock/guests";
import { payrollEmployees } from "@/data/mock/payroll";
import { initialReservations } from "@/data/mock/reservations";
import { mockRooms } from "@/data/mock/rooms";
import { initialPropertyTasks } from "@/data/mock/tasks";
import { db, sqlite } from "@/server/db/client";
import {
  auditEvents,
  bookingChannels,
  businessDays,
  cashDrops,
  companies,
  employees,
  expenses,
  guests,
  guestPaymentSources,
  guestVehicles,
  housekeepingRecords,
  maintenanceWorkOrders,
  payments,
  properties,
  propertyMemberships,
  propertySettings,
  propertyTasks,
  reservationCharges,
  reservationExtraGuests,
  reservationSignatures,
  reservations,
  rooms,
  roomTypes,
  timeEntries,
} from "@/server/db/schema";

const propertyId = "property-sun-star-inn";
const seededAt = "2026-09-29T13:30:00-07:00";

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

function employeeIdByName(name: string, employeeRows: Array<{ id: string; name: string }>) {
  return employeeRows.find((employee) => employee.name === name)?.id;
}

function clearDatabase() {
  sqlite.exec(`
    DELETE FROM audit_events;
    DELETE FROM property_tasks;
    DELETE FROM cash_drops;
    DELETE FROM expenses;
    DELETE FROM time_entries;
    DELETE FROM housekeeping_records;
    DELETE FROM maintenance_work_orders;
    DELETE FROM payments;
    DELETE FROM reservation_signatures;
    DELETE FROM reservation_extra_guests;
    DELETE FROM reservation_charges;
    DELETE FROM reservations;
    DELETE FROM guest_payment_sources;
    DELETE FROM guest_vehicles;
    DELETE FROM guests;
    DELETE FROM rooms;
    DELETE FROM room_types;
    DELETE FROM employees;
    DELETE FROM property_memberships;
    DELETE FROM companies;
    DELETE FROM booking_channels;
    DELETE FROM business_days;
    DELETE FROM property_settings;
    DELETE FROM properties;
  `);
}

async function seed() {
  clearDatabase();

  await db.insert(properties).values({
    id: propertyId,
    ...defaultSettings.property,
    timezone: "America/Los_Angeles",
    createdAt: seededAt,
    updatedAt: seededAt,
  });

  await db.insert(propertySettings).values([
    { id: "setting-tax", propertyId, key: "tax", value: JSON.stringify(defaultSettings.tax), updatedAt: seededAt },
    { id: "setting-invoice", propertyId, key: "invoice", value: JSON.stringify(defaultSettings.invoice), updatedAt: seededAt },
    { id: "setting-payroll", propertyId, key: "payroll", value: JSON.stringify(defaultSettings.payroll), updatedAt: seededAt },
    { id: "setting-sources", propertyId, key: "reservation_sources", value: JSON.stringify(defaultSettings.reservationSources), updatedAt: seededAt },
    { id: "setting-payments", propertyId, key: "payment_types", value: JSON.stringify(defaultSettings.paymentTypes), updatedAt: seededAt },
    { id: "setting-charges", propertyId, key: "charge_types", value: JSON.stringify(defaultSettings.chargeTypes), updatedAt: seededAt },
    { id: "setting-expenses", propertyId, key: "expense_categories", value: JSON.stringify(defaultSettings.expenseCategories), updatedAt: seededAt },
  ]);

  await db.insert(propertyMemberships).values({
    id: "membership-demo-owner",
    propertyId,
    authUserId: process.env.PMS_DEMO_AUTH_USER_ID ?? "demo-owner-auth-user",
    role: "owner",
    active: true,
    createdAt: seededAt,
    updatedAt: seededAt,
  });

  await db.insert(roomTypes).values(
    defaultSettings.roomTypes.map((roomType, index) => ({
      ...roomType,
      propertyId,
      sortOrder: index,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(rooms).values(
    mockRooms.map((room) => ({
      id: room.id,
      propertyId,
      roomTypeId: room.roomTypeId,
      number: room.number,
      floor: room.floor,
      section: room.section,
      mapOrder: room.mapOrder,
      serviceStatus: room.serviceStatus,
      housekeepingStatus: room.housekeepingStatus,
      smokingAllowed: room.smokingAllowed,
      outOfOrderReason: room.outOfOrderReason,
      active: true,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  const employeeRows = [
    ...payrollEmployees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      status: employee.status,
      hourlyRateCents: employee.hourlyRateCents,
    })),
    { id: "employee-owner", membershipId: "membership-demo-owner", name: "Owner Admin", role: "Owner/Admin", status: "Active", hourlyRateCents: 0 },
  ];
  await db.insert(employees).values(
    employeeRows.map((employee) => ({ ...employee, propertyId, membershipId: "membershipId" in employee ? employee.membershipId : undefined, createdAt: seededAt, updatedAt: seededAt })),
  );

  await db.insert(companies).values(
    companyDirectory.map((company) => ({ ...company, propertyId, createdAt: seededAt, updatedAt: seededAt })),
  );

  await db.insert(bookingChannels).values(
    defaultSettings.bookingChannels.map((channel) => ({
      id: `booking-channel-${channel.id}`,
      propertyId,
      name: channel.name,
      channelType: channel.type,
      commissionBasisPoints: Math.round(channel.commissionPercent * 100),
      active: channel.active,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(businessDays).values({
    id: "business-day-2026-09-29",
    propertyId,
    businessDate: "2026-09-29",
    status: "Open",
    openedAt: seededAt,
    createdAt: seededAt,
    updatedAt: seededAt,
  });

  await db.insert(guests).values(
    mockGuests.map((guest) => ({
      id: guest.id,
      propertyId,
      firstName: guest.firstName,
      lastName: guest.lastName,
      phone: guest.phone,
      phoneNormalized: guest.phoneNormalized,
      idType: guest.idType,
      driverLicenseNumber: guest.driverLicenseNumber,
      driverLicenseNormalized: guest.driverLicenseNumber?.replace(/\s/g, "").toUpperCase(),
      dateOfBirth: guest.dateOfBirth,
      idExpires: guest.idExpires,
      addressLine1: guest.addressLine1,
      postalCode: guest.postalCode,
      state: guest.state,
      country: guest.country,
      countryCode: guest.countryCode,
      secondaryPhone: guest.secondaryPhone,
      secondaryEmail: guest.secondaryEmail,
      city: guest.city,
      guestStatus: guest.status,
      preferredRateCents: guest.fixedRateCents,
      notes: guest.notes,
      dnrCode: guest.dnrCode,
      dnrRemarks: guest.dnrRemarks,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(guestVehicles).values(
    mockGuests
      .filter((guest) => guest.vehicle)
      .map((guest) => ({
        id: `vehicle-${guest.id}`,
        guestId: guest.id,
        plate: guest.vehicle!.plate,
        make: guest.vehicle!.make,
        color: guest.vehicle!.color,
        year: guest.vehicle!.year,
        createdAt: seededAt,
        updatedAt: seededAt,
      })),
  );

  const guestIdByPhone = new Map(mockGuests.map((guest) => [guest.phoneNormalized, guest.id]));
  await db.insert(reservations).values(
    initialReservations.map((reservation) => ({
      id: reservation.id,
      propertyId,
      guestId: guestIdByPhone.get(normalizePhone(reservation.phone))!,
      roomId: `room-${reservation.room}`,
      roomTypeId: mockRooms.find((room) => room.number === reservation.room)?.roomTypeId,
      companyId: reservation.companyId,
      confirmationNumber: reservation.id.replace("reservation-", "SSI-R-"),
      source: reservation.source,
      status: reservation.status,
      arrivalDate: reservation.checkInDate,
      departureDate: reservation.checkoutDate,
      adultCount: reservation.adults ?? 1,
      childCount: reservation.children ?? 0,
      roomRateCents: Math.round(reservation.roomRentCents / Math.max(1, reservation.nights)),
      paymentArrangement: reservation.paymentType,
      notes: reservation.notes,
      checkedInAt: reservation.status === "Checked In" ? `${reservation.checkInDate}T15:00:00-07:00` : null,
      checkedOutAt: reservation.status === "Checked Out" ? `${reservation.checkoutDate}T11:00:00-07:00` : null,
      createdByEmployeeId: "employee-maria",
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(reservationCharges).values(
    initialReservations.flatMap((reservation) => [
      {
        id: `charge-room-${reservation.id}`,
        reservationId: reservation.id,
        type: "Room Rent",
        description: "Room rent",
        serviceDate: reservation.checkInDate,
        quantity: reservation.nights,
        unitAmountCents: Math.round(reservation.roomRentCents / Math.max(1, reservation.nights)),
        amountCents: reservation.roomRentCents,
        taxable: true,
        taxAmountCents: reservation.taxCents,
        status: "Posted",
        createdAt: seededAt,
      },
      ...(reservation.miscellaneousCents
        ? [{
            id: `charge-misc-${reservation.id}`,
            reservationId: reservation.id,
            type: "Miscellaneous Non-Taxable",
            description: "Miscellaneous non-taxable charge",
            serviceDate: reservation.checkInDate,
            quantity: 1,
            unitAmountCents: reservation.miscellaneousCents,
            amountCents: reservation.miscellaneousCents,
            taxable: false,
            taxAmountCents: 0,
            status: "Posted",
            createdAt: seededAt,
          }]
        : []),
    ]),
  );

  await db.insert(payments).values(
    initialReservations
      .filter((reservation) => (reservation.amountPaidCents ?? reservation.totalCents - reservation.balanceCents) > 0)
      .map((reservation) => ({
        id: `payment-${reservation.id}`,
        reservationId: reservation.id,
        companyId: reservation.companyId,
        type: reservation.paymentType,
        amountCents: reservation.amountPaidCents ?? reservation.totalCents - reservation.balanceCents,
        effectiveDate: reservation.checkInDate,
        status: "Recorded",
        recordedByEmployeeId: "employee-maria",
        createdAt: seededAt,
      })),
  );

  await db.insert(housekeepingRecords).values(
    initialHousekeepingTasks.map((task) => ({
      id: task.id,
      propertyId,
      roomId: `room-${task.roomNumber}`,
      employeeId: task.assignedHousekeeper
        ? employeeIdByName(task.assignedHousekeeper, employeeRows)
        : null,
      serviceDate: "2026-09-29",
      serviceType: task.cleaningType,
      status: task.status,
      assignedAt: task.assignedHousekeeper ? seededAt : null,
      startedAt: task.status === "Cleaning" ? seededAt : null,
      completedAt: task.status === "Clean" ? seededAt : null,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(maintenanceWorkOrders).values({
    id: "maintenance-room-142-ac",
    propertyId,
    roomId: "room-142",
    note: "Air conditioner service required before the room returns to inventory.",
    status: "Open",
    blockRoom: true,
    blockReason: "Air conditioner is not cooling.",
    blockFrom: "2026-09-29",
    blockTo: "2026-10-02",
    createdByEmployeeId: "employee-maria",
    createdAt: seededAt,
    updatedAt: seededAt,
  });

  await db.insert(timeEntries).values(
    initialTimeEntries.map((entry) => ({
      id: entry.id,
      employeeId: employeeIdByName(entry.employeeName, employeeRows)!,
      clockInAt: `${entry.date}T08:00:00-07:00`,
      clockOutAt: entry.clockOut ? `${entry.date}T14:00:00-07:00` : null,
      breakMinutes: entry.breakMinutes,
      status: entry.clockOut ? "Complete" : "Open",
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(expenses).values(
    initialExpenses.map((expense) => ({
      id: expense.id,
      propertyId,
      expenseDate: expense.date,
      category: expense.category,
      vendor: expense.vendor,
      description: expense.description,
      paymentMethod: expense.paymentMethod,
      amountCents: expense.amountCents,
      notes: expense.notes,
      receiptReference: expense.receiptName,
      status: "Recorded",
      enteredByEmployeeId: employeeIdByName(expense.enteredBy, employeeRows),
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(cashDrops).values(
    initialCashDrops.map((drop) => ({
      id: drop.id,
      propertyId,
      dropDate: drop.date,
      shift: drop.shift,
      expectedCents: drop.expectedCents,
      countedCents: drop.countedCents,
      differenceCents: drop.differenceCents,
      droppedCents: drop.droppedCents,
      managerEmployeeId: employeeIdByName(drop.employee, employeeRows),
      status: drop.status,
      notes: drop.notes,
      createdAt: seededAt,
    })),
  );

  await db.insert(propertyTasks).values(
    initialPropertyTasks.map((task) => ({
      id: task.id,
      propertyId,
      text: task.text,
      area: task.area,
      completed: task.completed,
      createdByEmployeeId: "employee-maria",
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
  );

  await db.insert(auditEvents).values({
    id: "audit-seed",
    propertyId,
    actorEmployeeId: "employee-owner",
    occurredAt: seededAt,
    action: "seed.demo",
    entityType: "property",
    entityId: propertyId,
    safeChangeSummary: "Seeded demo backend from current frontend fixtures.",
  });

  console.log("Seeded Sun Star Inn demo backend.");
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
