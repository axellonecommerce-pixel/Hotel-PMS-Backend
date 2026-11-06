import { expect, test } from "bun:test";

import { creditAccountFor, isBankMethod, isCashMethod } from "./cash-sources";

test("cash paid out is credited to the drawer or the safe", () => {
  expect(creditAccountFor("Cash", "drawer")).toBe("Cash");
  expect(creditAccountFor("Cash", "safe")).toBe("Cash - Safe");
});

test("bank methods are credited to the chosen bank account", () => {
  const bank = { id: "00000000-0000-0000-0000-000000000001", name: "Chase Operating" };
  for (const method of ["Check", "Debit Card", "Bank Transfer", "Direct deposit", "ACH", "Zelle", "Wire"]) {
    expect(isBankMethod(method)).toBe(true);
    expect(creditAccountFor(method, null, bank)).toBe("Bank - Chase Operating");
  }
  expect(creditAccountFor("Check")).toBe("Bank");
});

test("other methods never touch cash or a bank account", () => {
  for (const method of ["Credit Card", "Other"]) {
    expect(isBankMethod(method)).toBe(false);
    expect(isCashMethod(method)).toBe(false);
  }
  expect(creditAccountFor("Credit Card")).toBe("Credit Card Payable");
  expect(creditAccountFor("Other")).toBe("Accounts Payable");
});
