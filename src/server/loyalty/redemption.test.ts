import { describe, expect, test } from "bun:test";

import { calculateRewardApplication } from "./redemption";

describe("loyalty folio reward calculation", () => {
  test("a free night uses one nightly rent and its exact tax", () => {
    expect(calculateRewardApplication({ rewardType: "free_night", valueCents: null, percentBasisPoints: null, balanceCents: 32_400, roomRentCents: 30_000, roomTaxCents: 2_400, freeNightCents: 10_000, freeNightTaxCents: 800 }))
      .toEqual({ discountCents: 10_000, taxCents: 800, totalCents: 10_800 });
  });

  test("a percentage reward reverses proportional tax", () => {
    expect(calculateRewardApplication({ rewardType: "percent_discount", valueCents: null, percentBasisPoints: 1500, balanceCents: 21_600, roomRentCents: 20_000, roomTaxCents: 1_600, freeNightCents: 10_000, freeNightTaxCents: 800 }))
      .toEqual({ discountCents: 3_000, taxCents: 240, totalCents: 3_240 });
  });

  test("a fixed reward never creates a guest credit balance", () => {
    expect(calculateRewardApplication({ rewardType: "fixed_discount", valueCents: 5_000, percentBasisPoints: null, balanceCents: 2_000, roomRentCents: 10_000, roomTaxCents: 800, freeNightCents: 10_000, freeNightTaxCents: 800 }))
      .toEqual({ discountCents: 2_000, taxCents: 0, totalCents: 2_000 });
  });
});
