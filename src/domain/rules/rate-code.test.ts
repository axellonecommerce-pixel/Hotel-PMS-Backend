import { expect, test } from "bun:test";

import { canUseRateCode } from "@/domain/rules/rate-code";

test("reservation rate codes must be active and property configured", () => {
  expect(canUseRateCode("RACK", [])).toBe(true);
  expect(canUseRateCode("WEEKEND", [])).toBe(false);
  expect(canUseRateCode("WEEKEND", [{ name: "WEEKEND", active: true }])).toBe(true);
  expect(canUseRateCode("WEEKEND", [{ name: "WEEKEND", active: false }])).toBe(false);
  expect(canUseRateCode("UNKNOWN", [{ name: "WEEKEND", active: true }])).toBe(false);
});
