import { expect, test } from "bun:test";
import postgres from "postgres";

import { isDatabaseError, isUserMessage } from "./errors";

test("our own messages are shown; database errors never are", () => {
  expect(isUserMessage(new Error("This payment was already deposited in the bank."), /already deposited/)).toBe(true);
  const dbError = Object.assign(new Error('insert or update on table "charges" violates foreign key constraint "charges_folio_id_fkey"'), { severity: "ERROR", code: "23503" });
  expect(isDatabaseError(dbError)).toBe(true);
  expect(isUserMessage(dbError, /charge/i)).toBe(false);
  expect(isUserMessage("charge", /charge/)).toBe(false);
  expect(typeof postgres).toBe("function");
});
