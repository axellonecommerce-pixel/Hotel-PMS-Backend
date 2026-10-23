import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { runNightAudit } from "@/server/night-audit/run-night-audit";
import { z } from "zod";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const [record] = await productionSql()<Array<{ value: { enabled?: boolean; time?: string } }>>`
      select value from property_settings where property_id=${session.propertyId}::uuid and key='night_audit_schedule'
    `;
    const [applicationSettings] = await productionSql()<Array<{ value: { property?: { nightAuditTime?: string } } }>>`
      select value from property_settings where property_id=${session.propertyId}::uuid and key='application_settings'
    `;
    return Response.json({ schedule: record?.value ?? { enabled: false, time: applicationSettings?.value.property?.nightAuditTime ?? "02:00" } });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const parsed = z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Choose a valid Night Audit time." }, { status: 400 });
    await productionSql()`
      insert into property_settings (property_id,key,value) values (${session.propertyId}::uuid,'night_audit_schedule',${productionSql().json(parsed.data)})
      on conflict (property_id,key) do update set value=excluded.value,updated_at=now()
    `;
    await productionSql()`
      update property_settings
      set value=jsonb_set(value, '{property,nightAuditTime}', to_jsonb(${parsed.data.time}::text), true), updated_at=now()
      where property_id=${session.propertyId}::uuid and key='application_settings'
    `;
    return Response.json({ schedule: parsed.data });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    const [employee] = await productionSql()<Array<{ id: string }>>`
      select id from employees where property_id=${session.propertyId}::uuid
        and membership_id in (select id from property_memberships where auth_user_id=${session.authUserId}::uuid and property_id=${session.propertyId}::uuid)
      limit 1
    `;
    const result = await productionSql().begin((tx) => runNightAudit(tx, { propertyId: session.propertyId, trigger: "manual", employeeId: employee?.id }));
    return Response.json(result, { status: result.status === "completed" ? 200 : 409 });
  } catch (error) {
    if (error instanceof Error && /business day/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
