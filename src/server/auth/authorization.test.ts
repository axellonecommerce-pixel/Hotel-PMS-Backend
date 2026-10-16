import { describe, expect, test } from "bun:test";

import { authorizePropertyAccess, hasPermission } from "./authorization";

describe("role authorization", () => {
  test("owner and manager can manage every feature", () => {
    expect(hasPermission("owner", "backups.manage")).toBe(true);
    expect(hasPermission("manager", "employees.manage")).toBe(true);
  });

  test("front desk has operations access but cannot manage employees or backups", () => {
    expect(hasPermission("front_desk", "housekeeping.manage")).toBe(true);
    expect(hasPermission("front_desk", "payments.manage")).toBe(true);
    expect(hasPermission("front_desk", "employees.manage")).toBe(false);
    expect(hasPermission("front_desk", "backups.manage")).toBe(false);
  });

  test("accountants manage approved financial areas only", () => {
    expect(hasPermission("accountant", "payments.manage")).toBe(true);
    expect(hasPermission("accountant", "payroll.manage")).toBe(true);
    expect(hasPermission("accountant", "reservations.manage")).toBe(false);
  });
});

test("hotel isolation rejects a valid employee from another property", () => {
  expect(authorizePropertyAccess({
    authUserId: "employee-1",
    propertyId: "hotel-a",
    role: "manager",
    active: true,
  }, "hotel-b", "reports.view")).toEqual({
    allowed: false,
    status: 403,
    reason: "WRONG_PROPERTY",
  });
});
