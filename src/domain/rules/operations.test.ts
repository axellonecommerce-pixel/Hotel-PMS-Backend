import { describe, expect, test } from "bun:test";

import {
  calculateCashVariance,
  calculateHotelPerformance,
  calculatePaidMinutes,
  canCreateCompanyGroupInvoice,
  evaluateCheckout,
  mergePaymentSources,
  mergeRemarks,
  remainingRefundableCents,
  validateRefund,
} from "./operations";

describe("checkout", () => {
  test("blocks an unresolved room deposit", () => {
    expect(evaluateCheckout({ companyDirectBill: false, balanceCents: 0, depositResolved: false }))
      .toEqual({ allowed: false, reason: "UNRESOLVED_DEPOSIT" });
  });

  test("requires zero for individual stays and transfers company balances", () => {
    expect(evaluateCheckout({ companyDirectBill: false, balanceCents: 1, depositResolved: true }).allowed)
      .toBe(false);
    expect(evaluateCheckout({ companyDirectBill: true, balanceCents: 42_500, depositResolved: true }))
      .toEqual({ allowed: true, transferToCompanyCents: 42_500 });
  });
});

describe("payments and cash", () => {
  test("calculates over and short without manual input", () => {
    expect(calculateCashVariance(10_000, 10_500)).toEqual({ differenceCents: 500, status: "Over" });
    expect(calculateCashVariance(10_000, 9_500)).toEqual({ differenceCents: -500, status: "Short" });
  });

  test("limits cumulative partial refunds", () => {
    expect(remainingRefundableCents(10_000, [3_000, 2_000])).toBe(5_000);
    expect(validateRefund(10_000, [3_000, 2_000], 5_000)).toBe(true);
    expect(validateRefund(10_000, [3_000, 2_000], 5_001)).toBe(false);
  });
});

describe("guest merge", () => {
  test("deduplicates identical payment sources and keeps different sources", () => {
    expect(mergePaymentSources(
      [{ method: "Credit Card", label: "Visa", last4: "4242" }],
      [
        { method: "Credit Card", label: "Visa", last4: "4242" },
        { method: "Debit Card", label: "Mastercard", last4: "1111" },
      ],
    )).toHaveLength(2);
    expect(mergeRemarks("Prefers first floor", "Prefers first floor")).toBe("Prefers first floor");
    expect(mergeRemarks("Guest remark", "DNR override remark")).toBe("Guest remark\nDNR override remark");
  });
});

describe("payroll and hotel performance", () => {
  test("deducts a manually entered break and splits configured overtime", () => {
    const clockIn = new Date("2026-10-15T08:00:00-07:00");
    const clockOut = new Date("2026-10-15T21:00:00-07:00");
    expect(calculatePaidMinutes(clockIn, clockOut, 30, {
      dailyOvertimeAfterMinutes: 8 * 60,
      dailyDoubleTimeAfterMinutes: 12 * 60,
    })).toEqual({ paidMinutes: 750, regularMinutes: 480, overtimeMinutes: 240, doubleTimeMinutes: 30 });
  });

  test("supports a custom break duration and prevents a negative paid shift", () => {
    const clockIn = new Date("2026-10-15T08:00:00-07:00");
    const clockOut = new Date("2026-10-15T12:00:00-07:00");
    expect(calculatePaidMinutes(clockIn, clockOut, 45, {
      dailyOvertimeAfterMinutes: 8 * 60,
    })).toEqual({ paidMinutes: 195, regularMinutes: 195, overtimeMinutes: 0, doubleTimeMinutes: 0 });
    expect(calculatePaidMinutes(clockIn, clockOut, 300, {
      dailyOvertimeAfterMinutes: 8 * 60,
    }).paidMinutes).toBe(0);
  });

  test("counts zero-rate rooms as sold and reports both inventory bases", () => {
    expect(calculateHotelPerformance({
      roomRevenueCents: 3_000_00,
      soldRooms: 30,
      totalRooms: 42,
      outOfOrderRooms: 2,
    })).toEqual({
      adrCents: 10_000,
      revParAllRoomsCents: 7_143,
      revParRentableRoomsCents: 7_500,
      occupancyAllRoomsPercent: 71.43,
      occupancyRentableRoomsPercent: 75,
    });
  });

  test("waits for every company group room before invoicing", () => {
    expect(canCreateCompanyGroupInvoice(["Checked Out", "Checked In"])).toBe(false);
    expect(canCreateCompanyGroupInvoice(["Checked Out", "Checked Out"])).toBe(true);
  });
});
