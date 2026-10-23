import { expect, test } from "bun:test";

import { calculateAvailabilityRateCents } from "@/domain/rules/availability";

test("availability honors an exact room-type rate including zero and per-person amounts", () => {
  const roomType = { id: "standard", baseRateCents: 12_500 };
  const rateCode = {
    rateAdjustmentPercent: 25,
    roomTypeRates: {
      standard: {
        nightlyRateCents: 0,
        additionalAdultCents: 1_500,
        childCents: 500,
      },
    },
  };

  expect(calculateAvailabilityRateCents(roomType, rateCode, 1, 0)).toBe(0);
  expect(calculateAvailabilityRateCents(roomType, rateCode, 3, 2)).toBe(4_000);
});

test("availability uses a rate-code percentage only when no explicit room-type rate exists", () => {
  expect(calculateAvailabilityRateCents(
    { id: "deluxe", baseRateCents: 12_500 },
    { rateAdjustmentPercent: 10 },
    1,
    0,
  )).toBe(13_750);
});
