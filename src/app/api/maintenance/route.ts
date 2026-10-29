import type { TransactionSql } from "postgres";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";

const orderSchema = z.object({
  roomNumber: z.string().trim().min(1),
  note: z.string().trim().min(1),
  priority: z.preprocess((value) => typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value, z.enum(["Low", "Medium", "High", "Emergency"])),
  assignedWorker: z.string().trim().optional(),
  costCents: z.number().int().nonnegative(),
  notes: z.string().optional(),
  attachmentNames: z.array(z.string()).optional(),
  blockRoom: z.boolean(),
  blockReason: z.string().optional(),
  blockFrom: z.string().min(1),
  blockTo: z.string().min(1),
});

const updateSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string().uuid(), action: z.literal("complete") }),
  z.object({ id: z.string().uuid(), action: z.literal("extend"), blockTo: z.string().min(1) }),
  z.object({ id: z.string().uuid(), action: z.literal("unblock"), reason: z.string().trim().min(1) }),
  // Correct any field entered wrongly, including the room and block dates.
  orderSchema.extend({ id: z.string().uuid(), action: z.literal("edit") }),
]);

type OrderRow = {
  id: string; roomNumber: string; note: string; priority: "Low" | "Medium" | "High" | "Emergency";
  assignedWorker: string | null; costCents: number; rentable: boolean; status: string; notes: string | null;
  createdAt: string; completedAt: string | null; returnedToServiceAt: string | null;
};

function metadata(value: string | null) {
  if (!value) return {} as Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return { additionalNotes: value }; }
}

function toClient(row: OrderRow) {
  const extra = metadata(row.notes);
  return {
    id: row.id, roomNumber: row.roomNumber, note: row.note, priority: row.priority,
    assignedWorker: row.assignedWorker ?? undefined, costCents: row.costCents,
    notes: typeof extra.additionalNotes === "string" ? extra.additionalNotes : undefined,
    attachmentNames: Array.isArray(extra.attachmentNames) ? extra.attachmentNames.filter((item): item is string => typeof item === "string") : [],
    status: row.status === "completed" ? "Completed" : row.status === "resolved" ? "Resolved" : "Open",
    createdAt: row.createdAt, blockRoom: !row.rentable,
    blockReason: typeof extra.blockReason === "string" ? extra.blockReason : undefined,
    blockFrom: typeof extra.blockFrom === "string" ? extra.blockFrom : undefined,
    blockTo: typeof extra.blockTo === "string" ? extra.blockTo : undefined,
    unblockReason: typeof extra.unblockReason === "string" ? extra.unblockReason : undefined,
    unblockedAt: row.returnedToServiceAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

const selecting = `select m.id,r.number as "roomNumber",m.problem as note,initcap(m.priority) as priority,m.assigned_worker as "assignedWorker",m.cost_cents as "costCents",m.rentable,m.status,m.notes,m.created_at as "createdAt",m.completed_at as "completedAt",m.returned_to_service_at as "returnedToServiceAt" from maintenance_orders m join rooms r on r.id=m.room_id`;

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    if (!hasProductionDatabase()) return Response.json({ workOrders: [] });
    const rows = await productionSql()<OrderRow[]>`${productionSql().unsafe(selecting)} where m.property_id=${session.propertyId}::uuid order by m.created_at desc`;
    return Response.json({ workOrders: rows.map(toClient) });
  } catch (error) { return propertyAccessResponse(error); }
}

class MaintenanceConflict extends Error {}

type Tx = TransactionSql<Record<string, never>>;

/** A room cannot be blocked while a guest is in it or booked into the block dates. */
async function assertRoomCanBeBlocked(tx: Tx, roomId: string, roomNumber: string, blockFrom: string, blockTo: string) {
  const [conflict] = await tx<Array<{ guest: string; status: string; departure: string }>>`
    select concat(g.first_name,' ',g.last_name) as guest,rr.status,rs.departure_date::text as departure
    from reservation_rooms rr join reservations rs on rs.id=rr.reservation_id join guests g on g.id=rs.main_guest_id
    where rr.room_id=${roomId}::uuid and rr.status in ('reserved','checked_in') and rs.status in ('reserved','checked_in')
      and (rr.status='checked_in' or (rs.arrival_date <= ${blockTo}::date and greatest(rs.departure_date, rs.arrival_date + 1) > ${blockFrom}::date))
    order by rr.status desc limit 1
  `;
  if (conflict) {
    throw new MaintenanceConflict(conflict.status === "checked_in"
      ? `Room ${roomNumber} is occupied by ${conflict.guest} until ${conflict.departure}. Move the guest before blocking the room.`
      : `Room ${roomNumber} is reserved for ${conflict.guest} during these dates. Move that reservation before blocking the room.`);
  }
}

/** Return a room to rentable only when no other open non-rentable issue holds it. */
async function releaseRoomIfUnblocked(tx: Tx, propertyId: string, roomNumber: string, exceptOrderId: string, markDirty: boolean) {
  await tx`
    update rooms set service_status='rentable', cleanliness_status=case when ${markDirty} then 'dirty' else cleanliness_status end, updated_at=now()
    where property_id=${propertyId}::uuid and number=${roomNumber}
      and not exists (select 1 from maintenance_orders mo where mo.room_id=rooms.id and mo.id<>${exceptOrderId}::uuid and mo.rentable=false and mo.status not in ('resolved','cancelled'))
  `;
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    const parsed = orderSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Maintenance details are invalid." }, { status: 400 });
    if (parsed.data.blockTo < parsed.data.blockFrom) return Response.json({ error: "The end date must not be before the start date." }, { status: 400 });
    if (parsed.data.blockRoom && !parsed.data.blockReason?.trim()) return Response.json({ error: "A blocking reason is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const workOrder = await productionSql().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string }>>`select id from rooms where property_id=${session.propertyId}::uuid and number=${parsed.data.roomNumber} limit 1 for update`;
      if (!room) return null;
      if (parsed.data.blockRoom) await assertRoomCanBeBlocked(tx, room.id, parsed.data.roomNumber, parsed.data.blockFrom, parsed.data.blockTo);
      const [created] = await tx<OrderRow[]>`
        insert into maintenance_orders (property_id,room_id,problem,priority,assigned_worker,cost_cents,rentable,status,notes)
        values (${session.propertyId}::uuid,${room.id}::uuid,${parsed.data.note},${parsed.data.priority.toLowerCase()},${parsed.data.assignedWorker ?? null},${parsed.data.costCents},${!parsed.data.blockRoom},'open',${tx.json({ additionalNotes: parsed.data.notes, attachmentNames: parsed.data.attachmentNames ?? [], blockReason: parsed.data.blockReason, blockFrom: parsed.data.blockFrom, blockTo: parsed.data.blockTo })}::text)
        returning id,(select number from rooms where id=room_id) as "roomNumber",problem as note,initcap(priority) as priority,assigned_worker as "assignedWorker",cost_cents as "costCents",rentable,status,notes,created_at as "createdAt",completed_at as "completedAt",returned_to_service_at as "returnedToServiceAt"
      `;
      // A non-rentable maintenance issue is an inventory change, not only a
      // work-order label. Keep the durable room record in sync so every
      // inventory consumer (availability, housekeeping, and the floor map)
      // reports the same state after a refresh.
      if (parsed.data.blockRoom) {
        await tx`
          update rooms
          set service_status='non-rentable', updated_at=now()
          where id=${room.id}::uuid
        `;
      }
      return created;
    });
    if (!workOrder) return Response.json({ error: "The selected room no longer exists." }, { status: 404 });
    await recordChange({
      propertyId: session.propertyId,
      actorAuthUserId: session.authUserId,
      entityType: "settings",
      entityId: session.propertyId,
      action: "updated",
      entityVersion: Math.floor(Date.now() / 1000),
      payload: { source: "maintenance" },
    });
    return Response.json({ workOrder: toClient(workOrder) }, { status: 201 });
  } catch (error) {
    if (error instanceof MaintenanceConflict) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Maintenance update is invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const updated = await productionSql().begin(async (tx) => {
      const [existing] = await tx<OrderRow[]>`${tx.unsafe(selecting)} where m.id=${parsed.data.id}::uuid and m.property_id=${session.propertyId}::uuid for update`;
      if (!existing) return null;
      const extra = metadata(existing.notes);
      if (parsed.data.action === "edit") {
        const input = parsed.data;
        if (input.blockTo < input.blockFrom) throw new MaintenanceConflict("The end date must not be before the start date.");
        if (input.blockRoom && !input.blockReason?.trim()) throw new MaintenanceConflict("A blocking reason is required.");
        if (existing.status === "resolved" && (input.roomNumber !== existing.roomNumber || input.blockRoom !== !existing.rentable)) {
          throw new MaintenanceConflict("This issue is already resolved; only its details and cost can be corrected.");
        }
        const [room] = await tx<Array<{ id: string }>>`select id from rooms where property_id=${session.propertyId}::uuid and number=${input.roomNumber} limit 1 for update`;
        if (!room) throw new MaintenanceConflict(`Room ${input.roomNumber} does not exist.`);
        const wasBlocking = !existing.rentable && existing.status !== "resolved";
        const blocks = input.blockRoom && existing.status !== "resolved";
        const blockChanged = blocks && (!wasBlocking || input.roomNumber !== existing.roomNumber || input.blockFrom !== extra.blockFrom || input.blockTo !== extra.blockTo);
        if (blockChanged) await assertRoomCanBeBlocked(tx, room.id, input.roomNumber, input.blockFrom, input.blockTo);
        const nextExtra = { ...extra, additionalNotes: input.notes, attachmentNames: input.attachmentNames ?? extra.attachmentNames ?? [], blockReason: input.blockReason, blockFrom: input.blockFrom, blockTo: input.blockTo };
        const [row] = await tx<OrderRow[]>`
          update maintenance_orders set room_id=${room.id}::uuid, problem=${input.note}, priority=${input.priority.toLowerCase()},
            assigned_worker=${input.assignedWorker || null}, cost_cents=${input.costCents}, rentable=${!input.blockRoom},
            notes=${tx.json(JSON.parse(JSON.stringify(nextExtra)))}::text, updated_at=now()
          where id=${existing.id}::uuid
          returning id,(select number from rooms where id=room_id) as "roomNumber",problem as note,initcap(priority) as priority,assigned_worker as "assignedWorker",cost_cents as "costCents",rentable,status,notes,created_at as "createdAt",completed_at as "completedAt",returned_to_service_at as "returnedToServiceAt"
        `;
        // Keep room inventory in step: the old room is released if nothing
        // else blocks it, and a blocking issue blocks its (new) room.
        if (wasBlocking && (!blocks || input.roomNumber !== existing.roomNumber)) await releaseRoomIfUnblocked(tx, session.propertyId, existing.roomNumber, existing.id, false);
        if (blocks) await tx`update rooms set service_status='non-rentable', updated_at=now() where id=${room.id}::uuid`;
        return row;
      }
      if (parsed.data.action === "extend") {
        if (typeof extra.blockTo !== "string" || parsed.data.blockTo <= extra.blockTo) return "invalid-date" as const;
        extra.blockTo = parsed.data.blockTo;
      } else if (parsed.data.action === "unblock") {
        extra.unblockReason = parsed.data.reason;
      }
      const [row] = await tx<OrderRow[]>`
        update maintenance_orders set
          status=${parsed.data.action === "unblock" ? "resolved" : parsed.data.action === "complete" ? (existing.rentable ? "resolved" : "completed") : existing.status},
          rentable=${parsed.data.action === "unblock" ? true : existing.rentable},
          notes=${tx.json(JSON.parse(JSON.stringify(extra)))}::text,
          completed_at=case when ${parsed.data.action === "complete"} then now() else completed_at end,
          returned_to_service_at=case when ${parsed.data.action === "unblock"} then now() else returned_to_service_at end,
          updated_at=now()
        where id=${existing.id}::uuid
        returning id,(select number from rooms where id=room_id) as "roomNumber",problem as note,initcap(priority) as priority,assigned_worker as "assignedWorker",cost_cents as "costCents",rentable,status,notes,created_at as "createdAt",completed_at as "completedAt",returned_to_service_at as "returnedToServiceAt"
      `;
      // A rentable issue never took the room out of service, so finishing its
      // work ("Mark Fixed") resolves it. A blocking issue stays "completed"
      // until "Make Available" returns the room to service.
      // "Make Available" is the controlled return-to-service action. A
      // repaired room becomes rentable but dirty, so it cannot be treated as
      // guest-ready until Housekeeping completes the clean.
      if (parsed.data.action === "unblock") await releaseRoomIfUnblocked(tx, session.propertyId, existing.roomNumber, existing.id, true);
      return row;
    });
    if (updated === "invalid-date") return Response.json({ error: "Choose a later block end date." }, { status: 400 });
    if (!updated) return Response.json({ error: "Maintenance issue not found." }, { status: 404 });
    await recordChange({
      propertyId: session.propertyId,
      actorAuthUserId: session.authUserId,
      entityType: "settings",
      entityId: session.propertyId,
      action: "updated",
      entityVersion: Math.floor(Date.now() / 1000),
      payload: { source: "maintenance" },
    });
    return Response.json({ workOrder: toClient(updated) });
  } catch (error) {
    if (error instanceof MaintenanceConflict) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
