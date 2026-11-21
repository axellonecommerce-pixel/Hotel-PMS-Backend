import { describe, expect, test } from "bun:test";

import { loyaltyMemberNumber } from "./service";

describe("loyalty member IDs", () => {
  test("are stable for the same property and guest", () => {
    const guestId = "0f7c1423-4c88-4bd2-96bf-02b7999b1d53";
    expect(loyaltyMemberNumber("Sunset Motor Inn", guestId)).toBe("SMI-0F7C1423-4C88-4BD2-96BF-02B7999B1D53");
    expect(loyaltyMemberNumber("Sunset Motor Inn", guestId)).toBe("SMI-0F7C1423-4C88-4BD2-96BF-02B7999B1D53");
  });

  test("uses a safe fallback for short property names", () => {
    expect(loyaltyMemberNumber("A", "12345678-1234-1234-1234-123456789abc")).toBe("INN-12345678-1234-1234-1234-123456789ABC");
  });
});
