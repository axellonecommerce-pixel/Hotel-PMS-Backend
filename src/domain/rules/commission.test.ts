import { expect, test } from "bun:test";

import { calculateOtaBreakdown, otaDeductsCommission } from "@/domain/rules/commission";

test("OTA commission is charged on pre-tax room rent and net is gross minus commission (FR-RAT-004)", () => {
  expect(calculateOtaBreakdown({ roomRentCents: 20000, taxCents: 2400, commissionPercent: 15, paymentStatus: "Guest Pays Hotel" })).toEqual({
    grossCents: 22400,
    taxCents: 2400,
    commissionCents: 3000,
    netCents: 19400,
    commissionDeducted: false,
  });
});

test("Paid Online and Virtual Card Pending mean the OTA deducts its commission", () => {
  expect(otaDeductsCommission("Paid Online")).toBe(true);
  expect(otaDeductsCommission("Virtual Card Pending")).toBe(true);
  expect(otaDeductsCommission("Guest Pays Hotel")).toBe(false);
  expect(otaDeductsCommission(undefined)).toBe(false);
  expect(calculateOtaBreakdown({ roomRentCents: 10000, taxCents: 0, commissionPercent: 18, paymentStatus: "Paid Online" }).commissionDeducted).toBe(true);
});

test("commission never exceeds the gross amount", () => {
  expect(calculateOtaBreakdown({ roomRentCents: 10000, taxCents: 0, commissionPercent: 150, paymentStatus: "Paid Online" }).netCents).toBe(0);
});
