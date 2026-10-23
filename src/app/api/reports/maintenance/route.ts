import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Read-only work-order report. Inventory status continues to be changed only by Maintenance. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const records = await productionSql()<Array<{
      id: string; createdAt: string; room: string; issue: string; priority: string;
      worker: string | null; costCents: number; rentable: boolean; status: string; completedAt: string | null;
    }>>`
      select m.id,m.created_at as "createdAt",r.number as room,m.problem as issue,m.priority,
        m.assigned_worker as worker,m.cost_cents as "costCents",m.rentable,m.status,m.completed_at as "completedAt"
      from maintenance_orders m join rooms r on r.id=m.room_id
      where m.property_id=${session.propertyId}::uuid
        and m.created_at::date between ${input.data.startDate}::date and ${input.data.endDate}::date
      order by m.created_at desc
    `;
    const completed = records.filter((record) => record.status === "completed" || record.status === "resolved");
    const blocked = records.filter((record) => !record.rentable);
    const totalCost = records.reduce((sum, record) => sum + record.costCents, 0);
    return Response.json({ report: {
      metrics: [
        { label: "Work Orders", value: records.length, format: "number" },
        { label: "Completed", value: completed.length, format: "number" },
        { label: "Non-Rentable", value: blocked.length, format: "number" },
        { label: "Reported Cost", value: totalCost, format: "money" },
      ],
      columns: [
        { key: "created", label: "Created", format: "date" },
        { key: "room", label: "Room" },
        { key: "issue", label: "Issue" },
        { key: "priority", label: "Priority", format: "status" },
        { key: "worker", label: "Assigned Worker" },
        { key: "rentable", label: "Room Status", format: "status" },
        { key: "status", label: "Work Order", format: "status" },
        { key: "completed", label: "Completed", format: "date" },
        { key: "cost", label: "Cost", format: "money", align: "right" },
      ],
      rows: records.map((record) => ({
        id: record.id, created: record.createdAt.slice(0, 10), room: record.room, issue: record.issue,
        priority: record.priority, worker: record.worker ?? "—", rentable: record.rentable ? "Rentable" : "Non-Rentable",
        status: record.status, completed: record.completedAt?.slice(0, 10) ?? "—", cost: record.costCents,
      })),
      note: "Maintenance records are tenant-scoped work orders created in the selected date range. Room availability is shown as the work order's recorded rental state.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
