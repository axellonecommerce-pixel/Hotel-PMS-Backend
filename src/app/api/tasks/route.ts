import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

const areas = ["Front Desk", "Maintenance", "Housekeeping", "Manager"] as const;
const createSchema = z.object({ text: z.string().trim().min(1).max(500), area: z.enum(areas) });
const updateSchema = z.object({ id: z.string().uuid(), completed: z.boolean() });
type TaskRow = { id: string; text: string; area: (typeof areas)[number]; completed: boolean; createdAt: string };

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.read");
    if (!hasProductionDatabase()) return Response.json({ tasks: [] });
    const tasks = await productionSql()<TaskRow[]>`
      select id,text,area,completed,created_at::text as "createdAt"
      from property_tasks where property_id=${session.propertyId}::uuid
      order by completed asc,created_at desc limit 200
    `;
    return Response.json({ tasks });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.read");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Task details are invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const [task] = await productionSql()<TaskRow[]>`
      insert into property_tasks (property_id,text,area,completed)
      values (${session.propertyId}::uuid,${parsed.data.text},${parsed.data.area},false)
      returning id,text,area,completed,created_at::text as "createdAt"
    `;
    return Response.json({ task }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.read");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Task update is invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const [task] = await productionSql()<TaskRow[]>`
      update property_tasks set completed=${parsed.data.completed},
        completed_at=${parsed.data.completed ? new Date().toISOString() : null}::timestamptz,updated_at=now()
      where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid
      returning id,text,area,completed,created_at::text as "createdAt"
    `;
    if (!task) return Response.json({ error: "Task not found." }, { status: 404 });
    return Response.json({ task });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
export const PATCH = withRequestContext(routePATCH);
