import { expect, test } from "bun:test";

import { nextRecurringExpenseDate } from "./recurring";

test("recurring expense dates advance across month ends and leap years", () => {
  expect(nextRecurringExpenseDate("2026-01-31", "Monthly")).toBe("2026-02-28");
  expect(nextRecurringExpenseDate("2024-01-31", "Monthly")).toBe("2024-02-29");
  expect(nextRecurringExpenseDate("2024-02-29", "Annually")).toBe("2025-02-28");
  expect(nextRecurringExpenseDate("2026-11-30", "Quarterly")).toBe("2027-02-28");
  expect(nextRecurringExpenseDate("2026-12-28", "Weekly")).toBe("2027-01-04");
});
