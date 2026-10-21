import { timingSafeEqual } from "node:crypto";

import { productionSql } from "@/server/db/production";
import { runNightAudit } from "@/server/night-audit/run-night-audit";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  return Boolean(expected && supplied && expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const properties = await productionSql()<Array<{ propertyId: string; timezone: string; schedule: { enabled?: boolean; time?: string } | null }>>`
    select p.id as "propertyId",p.timezone,ps.value as schedule
    from properties p join business_days b on b.property_id=p.id and b.status='open'
    left join property_settings ps on ps.property_id=p.id and ps.key='night_audit_schedule'
  `;
  const results = [];
  for (const property of properties) {
    const localTime = new Intl.DateTimeFormat("en-US", { timeZone: property.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    if (!property.schedule?.enabled || property.schedule.time !== localTime) continue;
    try { results.push(await productionSql().begin((tx) => runNightAudit(tx, { propertyId: property.propertyId, trigger: "scheduled" }))); }
    catch (error) { results.push({ propertyId: property.propertyId, status: "error", error: error instanceof Error ? error.message : "Unknown error" }); }
  }
  return Response.json({ results });
}

export const GET = POST;
