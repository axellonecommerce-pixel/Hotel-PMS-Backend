const DAY_MS = 86_400_000;

export type IdentityImage = {
  id: string;
  storageKey: string | null;
  deleteAfter: Date;
  warnedAt: Date | null;
  deletedAt: Date | null;
};

export function identityRetentionAction(image: IdentityImage, now: Date) {
  if (!image.storageKey || image.deletedAt) return "none" as const;
  if (image.deleteAfter.getTime() <= now.getTime()) return "delete" as const;
  if (!image.warnedAt && image.deleteAfter.getTime() - now.getTime() <= 7 * DAY_MS) {
    return "warn" as const;
  }
  return "none" as const;
}

/**
 * Guest data is kept for the life of the motel's account: InnSeva never
 * deletes it on a schedule. (Guest ID photos are not stored at all; the ID
 * type and number are.) The database column needs a date, so it holds this
 * "never" date.
 */
export const KEEP_FOREVER = "9999-12-31T00:00:00.000Z";

export function createIdentityDeleteAfter(_capturedAt?: Date) {
  return new Date(KEEP_FOREVER);
}

export function filterBackupStorageKeys(
  retainedKeys: readonly string[],
  tombstonedKeyHashes: ReadonlySet<string>,
  hash: (storageKey: string) => string,
) {
  return retainedKeys.filter((key) => !tombstonedKeyHashes.has(hash(key)));
}
