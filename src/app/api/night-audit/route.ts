import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { runNightAudit } from "@/server/night-audit/run-night-audit";
import { z } from "zod";
import { isUserMessage } from "@/server/http/errors";

class AlreadyAuditedError extends Error {
  constructor(expected: string, readonly openDate: string) {
    super(`The Night Audit for ${expected} has already run. The business day is now ${openDate}.`);
  }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "night_audit.run");
    const [record] = await productionSql()<Array<{ value: { enabled?: boolean; time?: string } }>>`
      select value from property_settings where property_id=${session.propertyId}::uuid and key='night_audit_schedule'
    `;
    const [applicationSettings] = await productionSql()<Array<{ value: { property?: { nightAuditTime?: string } } }>>`
      select value from property_settings where property_id=${session.propertyId}::uuid and key='application_settings'
    `;
    const [lastRun] = await productionSql()<Array<{ status: string; trigger: string; businessDate: string; completedAt: string | null; steps: unknown; blockers: unknown }>>`
      select n.status,n.trigger,b.business_date::text as "businessDate",n.completed_at as "completedAt",n.summary as steps,n.blocking_issues as blockers
      from night_audit_runs n join business_days b on b.id=n.business_day_id
      where n.property_id=${session.propertyId}::uuid order by n.started_at desc limit 1
    `;
    return Response.json({ schedule: record?.value ?? { enabled: false, time: applicationSettings?.value.property?.nightAuditTime ?? "02:00" }, lastRun: lastRun ?? null });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "night_audit.run");
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
    const session = await requirePropertySession(request, "night_audit.run");
    const [employee] = await productionSql()<Array<{ id: string }>>`
      select id from employees where property_id=${session.propertyId}::uuid
        and membership_id in (select id from property_memberships where auth_user_id=${session.authUserId}::uuid and property_id=${session.propertyId}::uuid)
      limit 1
    `;
    // The screen sends the business day it is closing. If the scheduled audit
    // already closed that day, running again would close the NEXT day too.
    const body = await request.json().catch(() => null) as { expectedBusinessDate?: unknown } | null;
    const expected = typeof body?.expectedBusinessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expectedBusinessDate) ? body.expectedBusinessDate : null;
    const result = await productionSql().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`night-audit:${session.propertyId}`}))`;
      if (expected) {
        const [open] = await tx<Array<{ businessDate: string }>>`select business_date::text as "businessDate" from business_days where property_id=${session.propertyId}::uuid and status='open' order by business_date limit 1`;
        if (open && open.businessDate !== expected) throw new AlreadyAuditedError(expected, open.businessDate);
      }
      return runNightAudit(tx, { propertyId: session.propertyId, trigger: "manual", employeeId: employee?.id });
    });
    return Response.json(result, { status: result.status === "completed" ? 200 : 409 });
  } catch (error) {
    if (error instanceof AlreadyAuditedError) return Response.json({ error: error.message, alreadyAudited: true, businessDate: error.openDate }, { status: 409 });
    if (isUserMessage(error, /business day/i)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
