import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const orderSchema = z.object({
  roomNumber: z.string().trim().min(1),
  note: z.string().trim().min(1),
  priority: z.enum(["Low", "Medium", "High", "Emergency"]),
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

const selecting = `select m.id,r.number as "roomNumber",m.problem as note,m.priority,m.assigned_worker as "assignedWorker",m.cost_cents as "costCents",m.rentable,m.status,m.notes,m.created_at as "createdAt",m.completed_at as "completedAt",m.returned_to_service_at as "returnedToServiceAt" from maintenance_orders m join rooms r on r.id=m.room_id`;

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "maintenance.manage");
    if (!hasProductionDatabase()) return Response.json({ workOrders: [] });
    const rows = await productionSql()<OrderRow[]>`${productionSql().unsafe(selecting)} where m.property_id=${session.propertyId}::uuid order by m.created_at desc`;
    return Response.json({ workOrders: rows.map(toClient) });
  } catch (error) { return propertyAccessResponse(error); }
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
      const [room] = await tx<Array<{ id: string }>>`select id from rooms where property_id=${session.propertyId}::uuid and number=${parsed.data.roomNumber} limit 1`;
      if (!room) return null;
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
    return Response.json({ workOrder: toClient(workOrder) }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
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
      if (parsed.data.action === "extend") {
        if (typeof extra.blockTo !== "string" || parsed.data.blockTo <= extra.blockTo) return "invalid-date" as const;
        extra.blockTo = parsed.data.blockTo;
      } else if (parsed.data.action === "unblock") {
        extra.unblockReason = parsed.data.reason;
      }
      const [row] = await tx<OrderRow[]>`
        update maintenance_orders set
          status=${parsed.data.action === "unblock" ? "resolved" : parsed.data.action === "complete" ? "completed" : existing.status},
          rentable=${parsed.data.action === "unblock" ? true : existing.rentable},
          notes=${tx.json(JSON.parse(JSON.stringify(extra)))}::text,
          completed_at=case when ${parsed.data.action === "complete"} then now() else completed_at end,
          returned_to_service_at=case when ${parsed.data.action === "unblock"} then now() else returned_to_service_at end,
          updated_at=now()
        where id=${existing.id}::uuid
        returning id,(select number from rooms where id=room_id) as "roomNumber",problem as note,initcap(priority) as priority,assigned_worker as "assignedWorker",cost_cents as "costCents",rentable,status,notes,created_at as "createdAt",completed_at as "completedAt",returned_to_service_at as "returnedToServiceAt"
      `;
      // "Make Available" is the controlled return-to-service action. A
      // repaired room becomes rentable but dirty, so it cannot be treated as
      // guest-ready until Housekeeping completes the clean.
      if (parsed.data.action === "unblock") {
        await tx`
          update rooms
          set service_status='rentable', cleanliness_status='dirty', updated_at=now()
          where property_id=${session.propertyId}::uuid and number=${existing.roomNumber}
        `;
      }
      return row;
    });
    if (updated === "invalid-date") return Response.json({ error: "Choose a later block end date." }, { status: 400 });
    if (!updated) return Response.json({ error: "Maintenance issue not found." }, { status: 404 });
    return Response.json({ workOrder: toClient(updated) });
  } catch (error) { return propertyAccessResponse(error); }
}
