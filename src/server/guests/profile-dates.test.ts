import { describe, expect, test } from "bun:test";

import { profileDate } from "./profile-dates";

describe("profileDate", () => {
  test("keeps ISO dates and trims timestamps", () => {
    expect(profileDate("2029-05-12")).toBe("2029-05-12");
    expect(profileDate("2029-05-12T00:00:00.000Z")).toBe("2029-05-12");
  });
  test("reads US-style dates", () => {
    expect(profileDate("5/12/2029")).toBe("2029-05-12");
    expect(profileDate("05-12-2029")).toBe("2029-05-12");
  });
  test("drops impossible or unreadable dates", () => {
    expect(profileDate("2029-02-30")).toBeUndefined();
    expect(profileDate("soon")).toBeUndefined();
    expect(profileDate("")).toBeUndefined();
    expect(profileDate(undefined)).toBeUndefined();
  });
});
