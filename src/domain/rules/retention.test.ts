import { expect, test } from "bun:test";

import { createIdentityDeleteAfter, filterBackupStorageKeys, identityRetentionAction } from "./retention";

test("ID photos warn seven days before deletion and delete at one year", () => {
  const captured = new Date("2025-10-15T12:00:00Z");
  const deleteAfter = createIdentityDeleteAfter(captured);
  expect(deleteAfter.toISOString()).toBe("2026-10-15T12:00:00.000Z");
  expect(identityRetentionAction({ id: "id-1", storageKey: "guest/id.jpg", deleteAfter, warnedAt: null, deletedAt: null }, new Date("2026-10-09T12:00:00Z"))).toBe("warn");
  expect(identityRetentionAction({ id: "id-1", storageKey: "guest/id.jpg", deleteAfter, warnedAt: captured, deletedAt: null }, new Date("2026-10-15T12:00:00Z"))).toBe("delete");
});

test("deleted identity images cannot re-enter a backup", () => {
  expect(filterBackupStorageKeys(["active.jpg", "deleted.jpg"], new Set(["hash:deleted.jpg"]), (key) => `hash:${key}`))
    .toEqual(["active.jpg"]);
});
