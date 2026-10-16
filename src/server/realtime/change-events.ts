import { and, eq, gt } from "drizzle-orm";

import { db } from "@/server/db/client";
import { changeEvents } from "@/server/db/schema";

export function recordChange(input: {
  propertyId: string;
  actorAuthUserId: string;
  entityType: string;
  entityId: string;
  action: "created" | "updated" | "deleted";
  entityVersion: number;
  payload?: unknown;
}) {
  db.insert(changeEvents).values({
    ...input,
    payloadJson: JSON.stringify(input.payload ?? {}),
    occurredAt: new Date().toISOString(),
  }).run();
}

export async function changesAfter(propertyId: string, cursor: number) {
  return db.query.changeEvents.findMany({
    where: and(eq(changeEvents.propertyId, propertyId), gt(changeEvents.id, cursor)),
    orderBy: changeEvents.id,
    limit: 100,
  });
}
