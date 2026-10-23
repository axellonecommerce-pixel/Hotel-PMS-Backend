import { and, eq, gt } from "drizzle-orm";

import { db } from "@/server/db/client";
import { changeEvents } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

type ChangeInput = {
  propertyId: string;
  actorAuthUserId: string;
  entityType: string;
  entityId: string;
  action: "created" | "updated" | "deleted";
  entityVersion: number;
  payload?: unknown;
};

export type StreamChangeEvent = {
  id: string;
  cursor: string;
  propertyId: string;
  actorAuthUserId: string;
  entityType: string;
  entityId: string;
  action: "created" | "updated" | "deleted";
  entityVersion: number;
  payloadJson: string;
};

/** SQLite uses an integer event id while PostgreSQL uses UUIDs. Cursors are
 * opaque (`s:<integer>` locally, timestamp/UUID in production) so browsers
 * never depend on a database-specific identifier type. */
export async function recordChange(input: ChangeInput) {
  try {
    if (hasProductionDatabase()) {
      await productionSql()`
        insert into change_events (property_id,actor_auth_user_id,entity_type,entity_id,action,entity_version,payload)
        values (${input.propertyId}::uuid,${input.actorAuthUserId}::uuid,${input.entityType},${input.entityId}::uuid,${input.action},${input.entityVersion},${JSON.stringify(input.payload ?? {})}::jsonb)
      `;
      return;
    }
    db.insert(changeEvents).values({
      ...input,
      payloadJson: JSON.stringify(input.payload ?? {}),
      occurredAt: new Date().toISOString(),
    }).run();
  } catch (error) {
    // Change events keep other browser tabs fresh; they are not the source
    // of truth. A delivery outage must not turn an already-committed write
    // into an apparent operation failure for the person who made the change.
    console.error("Realtime change event could not be recorded", {
      propertyId: input.propertyId,
      entityType: input.entityType,
      entityId: input.entityId,
      error,
    });
  }
}

export async function changesAfter(propertyId: string, cursor: string): Promise<StreamChangeEvent[]> {
  if (hasProductionDatabase()) {
    const marker = cursor.startsWith("p:") ? cursor.slice(2) : "";
    const separator = marker.lastIndexOf("|");
    const occurredAt = separator > 0 ? marker.slice(0, separator) : "";
    const id = separator > 0 ? marker.slice(separator + 1) : "";
    const rows = occurredAt && id
      ? await productionSql()<Array<{ id: string; propertyId: string; actorAuthUserId: string; entityType: string; entityId: string; action: "created" | "updated" | "deleted"; entityVersion: number; payload: unknown; occurredAt: string }>>`
          select id,property_id as "propertyId",actor_auth_user_id as "actorAuthUserId",entity_type as "entityType",entity_id as "entityId",action,entity_version as "entityVersion",payload,created_at::text as "occurredAt"
          from change_events
          where property_id=${propertyId}::uuid and (created_at > ${occurredAt}::timestamptz or (created_at = ${occurredAt}::timestamptz and id::text > ${id}))
          order by created_at,id limit 100
        `
      : await productionSql()<Array<{ id: string; propertyId: string; actorAuthUserId: string; entityType: string; entityId: string; action: "created" | "updated" | "deleted"; entityVersion: number; payload: unknown; occurredAt: string }>>`
          select id,property_id as "propertyId",actor_auth_user_id as "actorAuthUserId",entity_type as "entityType",entity_id as "entityId",action,entity_version as "entityVersion",payload,created_at::text as "occurredAt"
          from change_events where property_id=${propertyId}::uuid order by created_at,id limit 100
        `;
    return rows.map((row) => ({ ...row, cursor: `p:${row.occurredAt}|${row.id}`, payloadJson: JSON.stringify(row.payload ?? {}) }));
  }
  const marker = Number(cursor.startsWith("s:") ? cursor.slice(2) : "0");
  const rows = await db.query.changeEvents.findMany({
    where: and(eq(changeEvents.propertyId, propertyId), gt(changeEvents.id, Number.isSafeInteger(marker) ? marker : 0)),
    orderBy: changeEvents.id,
    limit: 100,
  });
  return rows.map((row) => ({
    id: String(row.id), cursor: `s:${row.id}`, propertyId: row.propertyId,
    actorAuthUserId: row.actorAuthUserId, entityType: row.entityType, entityId: row.entityId,
    action: row.action as StreamChangeEvent["action"], entityVersion: row.entityVersion,
    payloadJson: row.payloadJson,
  }));
}
