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

export function createIdentityDeleteAfter(capturedAt: Date) {
  const result = new Date(capturedAt);
  result.setUTCFullYear(result.getUTCFullYear() + 1);
  return result;
}

export function filterBackupStorageKeys(
  retainedKeys: readonly string[],
  tombstonedKeyHashes: ReadonlySet<string>,
  hash: (storageKey: string) => string,
) {
  return retainedKeys.filter((key) => !tombstonedKeyHashes.has(hash(key)));
}
