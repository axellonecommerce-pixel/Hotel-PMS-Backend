import { expect, test } from "bun:test";

import { nightAuditDue, nightAuditDueAt } from "./run-night-audit";

test("a morning audit time is due on the next calendar day, in the hotel's time zone", () => {
  // 02:00 Pacific on Nov 7 (PST, UTC-8) is 10:00 UTC.
  expect(nightAuditDueAt({ businessDate: "2026-11-06", time: "02:00", timezone: "America/Los_Angeles" })).toBe("2026-11-07T10:00:00.000Z");
  // An evening time belongs to the business day itself (PDT, UTC-7 in July).
  expect(nightAuditDueAt({ businessDate: "2026-07-01", time: "23:30", timezone: "America/Los_Angeles" })).toBe("2026-07-02T06:30:00.000Z");
  expect(nightAuditDueAt({ businessDate: "2026-07-01", time: "03:00", timezone: "America/New_York" })).toBe("2026-07-02T07:00:00.000Z");
});

test("due instant and due check agree", () => {
  const input = { businessDate: "2026-11-06", time: "02:00", timezone: "America/Los_Angeles" };
  const dueAt = Date.parse(nightAuditDueAt(input));
  expect(nightAuditDue({ ...input, now: new Date(dueAt - 60_000) })).toBe(false);
  expect(nightAuditDue({ ...input, now: new Date(dueAt) })).toBe(true);
});
