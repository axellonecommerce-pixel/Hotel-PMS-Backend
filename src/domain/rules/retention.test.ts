import { expect, test } from "bun:test";

import { createIdentityDeleteAfter, filterBackupStorageKeys, identityRetentionAction } from "./retention";

test("guest ID photos are kept for life: never warned about or deleted on a schedule", () => {
  const captured = new Date("2025-10-15T12:00:00Z");
  const deleteAfter = createIdentityDeleteAfter(captured);
  expect(deleteAfter.toISOString()).toBe("9999-12-31T00:00:00.000Z");
  expect(identityRetentionAction({ id: "id-1", storageKey: "guest/id.jpg", deleteAfter, warnedAt: null, deletedAt: null }, new Date("2060-10-09T12:00:00Z"))).toBe("none");
});

test("deleted identity images cannot re-enter a backup", () => {
  expect(filterBackupStorageKeys(["active.jpg", "deleted.jpg"], new Set(["hash:deleted.jpg"]), (key) => `hash:${key}`))
    .toEqual(["active.jpg"]);
});
