import { describe, expect, test } from "bun:test";

import {
  allocateCompanyPayment,
  applyStackedPromotions,
  canDeleteFolio,
  createNightlyPostings,
  nightAuditBlockers,
  planRoomChargeMove,
  planNoShow,
  planCancellation,
  planReservationReinstatement,
  remainingDepositCents,
  roomTypeAvailability,
} from "./reservation-lifecycle";

describe("reservation inventory and pricing", () => {
  test("blocks only a sold-out room type for overlapping dates", () => {
    expect(roomTypeAvailability({
      totalActiveRooms: 3,
      outOfOrderRooms: 1,
      existingReservations: [
        { arrivalDate: "2026-10-15", departureDate: "2026-10-17" },
        { arrivalDate: "2026-10-20", departureDate: "2026-10-22" },
      ],
      requestedRange: { arrivalDate: "2026-10-16", departureDate: "2026-10-18" },
      requestedRooms: 2,
    })).toEqual({ available: 1, allowed: false });
  });

  test("stacks promotions in order and stores the tax snapshot", () => {
    expect(applyStackedPromotions(10_000, [
      { type: "percentage", valueBasisPoints: 1_000 },
      { type: "fixed", valueCents: 500 },
    ])).toBe(8_500);
    expect(createNightlyPostings({
      reservationRoomId: "room-stay-1",
      nightlyRatesCents: [10_000, 12_000],
      promotions: [],
      taxRateBasisPoints: 1_000,
      taxExempt: false,
    }).map(({ roomRentCents, taxCents, totalCents }) => ({ roomRentCents, taxCents, totalCents })))
      .toEqual([
        { roomRentCents: 10_000, taxCents: 1_000, totalCents: 11_000 },
        { roomRentCents: 12_000, taxCents: 1_200, totalCents: 13_200 },
      ]);
  });
});

describe("folio, deposits, and company receivables", () => {
  test("moves a room's rent and linked tax together", () => {
    const result = planRoomChargeMove([
      { id: "rent", folioId: "main", reservationRoomId: "stay-1", type: "room_rent" },
      { id: "tax", folioId: "main", reservationRoomId: "stay-1", linkedChargeId: "rent", type: "tax" },
      { id: "extra", folioId: "main", reservationRoomId: "stay-2", type: "extra" },
    ], "stay-1", "room-folio");
    expect(result.map((item) => item.chargeId)).toEqual(["rent", "tax"]);
  });

  test("protects non-empty folios and fully resolves per-room deposits", () => {
    expect(canDeleteFolio({ chargeCount: 0, paymentAllocationCount: 0, depositActivityCount: 0 })).toBe(true);
    expect(canDeleteFolio({ chargeCount: 0, paymentAllocationCount: 1, depositActivityCount: 0 })).toBe(false);
    expect(remainingDepositCents(20_000, [
      { type: "charge", amountCents: 4_000 },
      { type: "release", amountCents: 16_000 },
    ])).toBe(0);
  });

  test("allocates one payment across invoices and keeps excess as credit", () => {
    expect(allocateCompanyPayment(35_000, [
      { invoiceId: "later", dueDate: "2026-11-20", balanceCents: 10_000 },
      { invoiceId: "first", dueDate: "2026-11-01", balanceCents: 20_000 },
    ])).toEqual({
      allocations: [
        { invoiceId: "first", amountCents: 20_000 },
        { invoiceId: "later", amountCents: 10_000 },
      ],
      companyCreditCents: 5_000,
    });
  });
});

test("Night Audit reports every blocking category", () => {
  expect(nightAuditBlockers({
    unpaidDepartureCount: 1,
    unresolvedDepositCount: 2,
    openCashShiftCount: 1,
    unresolvedOperationalIssueCount: 0,
  })).toEqual(["UNPAID_DEPARTURES", "UNRESOLVED_DEPOSITS", "OPEN_CASH_SHIFTS"]);
});

test("No Show immediately releases every reserved room and optionally posts a fee", () => {
  expect(planNoShow({ currentStatus: "Reserved", requestedFeeCents: 7_500, amountPaidCents: 2_500, reservationRoomIds: ["room-stay-1", "room-stay-2"] })).toEqual({
    allowed: true,
    status: "No Show",
    feeCents: 7_500,
    balanceCents: 5_000,
    releasedReservationRoomIds: ["room-stay-1", "room-stay-2"],
  });
  expect(planNoShow({ currentStatus: "Checked In", reservationRoomIds: ["room-stay-1"] })).toEqual({ allowed: false, reason: "NOT_RESERVED" });
});

test("cancellation releases inventory and applies only the selected fee", () => {
  expect(planCancellation({ currentStatus: "Reserved", requestedFeeCents: 5_000, amountPaidCents: 7_500, reservationRoomIds: ["room-stay-1"] })).toEqual({ allowed: true, status: "Cancelled", feeCents: 5_000, balanceCents: 0, releasedReservationRoomIds: ["room-stay-1"] });
});

test("cancelled and no-show reservations can be reinstated only when inventory is still available", () => {
  expect(planReservationReinstatement({
    currentStatus: "Cancelled",
    requestedRoomCount: 2,
    availableRoomCount: 2,
    assignedRoomNumbers: ["101", "102"],
  })).toEqual({
    allowed: true,
    status: "Reserved",
    restoredRoomStatuses: [
      { roomNumber: "101", status: "Reserved" },
      { roomNumber: "102", status: "Reserved" },
    ],
  });
  expect(planReservationReinstatement({
    currentStatus: "No Show",
    requestedRoomCount: 1,
    availableRoomCount: 1,
    unavailableAssignedRoomNumbers: ["101"],
  })).toEqual({ allowed: false, reason: "ASSIGNED_ROOM_UNAVAILABLE", unavailableRooms: ["101"] });
  expect(planReservationReinstatement({
    currentStatus: "No Show",
    requestedRoomCount: 2,
    availableRoomCount: 1,
  })).toEqual({ allowed: false, reason: "ROOM_TYPE_SOLD_OUT", requestedRoomCount: 2, availableRoomCount: 1 });
  expect(planReservationReinstatement({
    currentStatus: "Checked Out",
    requestedRoomCount: 1,
    availableRoomCount: 1,
  })).toEqual({ allowed: false, reason: "NOT_RELEASED" });
});
