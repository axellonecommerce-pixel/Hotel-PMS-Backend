import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const updateSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updates: z.array(z.object({
    roomNumber: z.string().trim().min(1),
    status: z.enum(["Unassigned", "Assigned", "Cleaning", "Clean", "Maintenance Issue"]),
    assignedHousekeeper: z.string().trim().optional(),
  })).min(1),
});

type RecordRow = { roomNumber: string; status: "Unassigned" | "Assigned" | "Cleaning" | "Clean" | "Maintenance Issue"; assignedHousekeeper: string | null };

function recordState(status: RecordRow["status"]) {
  if (status === "Clean") return { cleanliness: "clean", assignment: "completed" };
  if (status === "Cleaning") return { cleanliness: "dirty", assignment: "in_progress" };
  if (status === "Assigned") return { cleanliness: "dirty", assignment: "assigned" };
  return { cleanliness: "dirty", assignment: "unassigned" };
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const date = querySchema.safeParse({ date: new URL(request.url).searchParams.get("date") });
    if (!date.success) return Response.json({ error: "A valid service date is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ records: [] });
    const records = await productionSql()<RecordRow[]>`
      select r.number as "roomNumber",
        case h.assignment_status
          when 'completed' then 'Clean'
          when 'in_progress' then 'Cleaning'
          when 'assigned' then 'Assigned'
          else 'Unassigned'
        end as status,
        e.name as "assignedHousekeeper"
      from housekeeping_records h
      join rooms r on r.id=h.room_id
      left join employees e on e.id=h.housekeeper_employee_id
      where h.property_id=${session.propertyId}::uuid and h.service_date=${date.data.date}
    `;
    return Response.json({ records });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Housekeeping changes are invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    await productionSql().begin(async (tx) => {
      for (const update of parsed.data.updates) {
        const [room] = await tx<Array<{ id: string }>>`select id from rooms where property_id=${session.propertyId}::uuid and number=${update.roomNumber} limit 1`;
        if (!room) continue;
        const [employee] = update.assignedHousekeeper
          ? await tx<Array<{ id: string }>>`select id from employees where property_id=${session.propertyId}::uuid and lower(name)=lower(${update.assignedHousekeeper}) limit 1`
          : [];
        const state = recordState(update.status);
        await tx`
          insert into housekeeping_records (property_id,room_id,housekeeper_employee_id,service_date,service_type,cleanliness_status,assignment_status,completed_at)
          values (${session.propertyId}::uuid,${room.id}::uuid,${employee?.id ?? null}::uuid,${parsed.data.serviceDate},'standard',${state.cleanliness},${state.assignment},${update.status === "Clean" ? new Date().toISOString() : null})
          on conflict (room_id,service_date) do update set
            housekeeper_employee_id=excluded.housekeeper_employee_id,
            cleanliness_status=excluded.cleanliness_status,
            assignment_status=excluded.assignment_status,
            completed_at=excluded.completed_at
        `;
        await tx`update rooms set cleanliness_status=${state.cleanliness}, updated_at=now() where id=${room.id}::uuid`;
      }
    });
    return GET(new Request(`${new URL(request.url).origin}${new URL(request.url).pathname}?date=${parsed.data.serviceDate}`, { headers: request.headers }));
  } catch (error) { return propertyAccessResponse(error); }
}
