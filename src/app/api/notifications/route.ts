import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const records = await productionSql()<Array<Record<string, unknown>>>`
      select id,type,title,message,"resource_type" as "resourceType","resource_id" as "resourceId",
        "read_at"::text as "readAt","resolved_at"::text as "resolvedAt","created_at"::text as "createdAt"
      from notifications
      where property_id=${session.propertyId}::uuid and resolved_at is null
        and (recipient_role is null or recipient_role=${session.role})
      order by created_at desc limit 100
    `;
    return Response.json({ notifications: records });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const parsed = z.object({ id: z.string().uuid(), action: z.enum(["read", "resolve", "unread"]) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Notification change is invalid." }, { status: 400 });
    const rows = parsed.data.action === "resolve"
      ? await productionSql()`update notifications set resolved_at=now(),read_at=coalesce(read_at,now()) where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid returning id`
      : parsed.data.action === "read"
        ? await productionSql()`update notifications set read_at=now() where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid returning id`
        : await productionSql()`update notifications set read_at=null where id=${parsed.data.id}::uuid and property_id=${session.propertyId}::uuid returning id`;
    if (!rows.length) return Response.json({ error: "Notification not found." }, { status: 404 });
    return Response.json({ updated: true });
  } catch (error) { return propertyAccessResponse(error); }
}
