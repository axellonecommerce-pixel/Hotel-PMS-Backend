import { timingSafeEqual } from "node:crypto";

import { productionSql } from "@/server/db/production";
import { nightAuditDue, runNightAudit } from "@/server/night-audit/run-night-audit";

const sameSecret = (expected?: string | null, supplied?: string | null) =>
  Boolean(expected && supplied && expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));

/**
 * The Vercel cron sends CRON_SECRET; the database scheduler (pg_cron, every
 * minute when an audit is due) sends the token kept in scheduler_secrets.
 */
async function authorized(request: Request) {
  if (sameSecret(process.env.CRON_SECRET, request.headers.get("authorization")?.replace(/^Bearer /, ""))) return true;
  const token = request.headers.get("x-scheduler-token");
  if (!token) return false;
  const [row] = await productionSql()<Array<{ secret: string }>>`select secret from scheduler_secrets where name='night-audit'`;
  return sameSecret(row?.secret, token);
}

export async function POST(request: Request) {
  if (!await authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const properties = await productionSql()<Array<{ propertyId: string; timezone: string; businessDate: string; schedule: { enabled?: boolean; time?: string } | null }>>`
    select p.id as "propertyId",p.timezone,b.business_date::text as "businessDate",ps.value as schedule
    from properties p join business_days b on b.property_id=p.id and b.status='open'
    left join property_settings ps on ps.property_id=p.id and ps.key='night_audit_schedule'
  `;
  const results = [];
  for (const property of properties) {
    // Same rule as the in-app trigger: run once the hotel-local schedule time has passed.
    if (!property.schedule?.enabled || !nightAuditDue({ businessDate: property.businessDate, time: property.schedule.time ?? "02:00", timezone: property.timezone })) continue;
    // A blocked audit is retried every 30 minutes, not on every scheduler tick.
    const [recentFailure] = await productionSql()<Array<{ id: string }>>`
      select n.id from night_audit_runs n join business_days b on b.id=n.business_day_id
      where n.property_id=${property.propertyId}::uuid and b.business_date=${property.businessDate}::date
        and n.trigger='scheduled' and n.status='failed' and n.started_at > now() - interval '30 minutes'
      limit 1
    `;
    if (recentFailure) continue;
    try {
      results.push(await productionSql().begin(async (tx) => {
        // Re-check inside the audit lock: a screen may have just run it.
        await tx`select pg_advisory_xact_lock(hashtext(${`night-audit:${property.propertyId}`}))`;
        const [open] = await tx<Array<{ businessDate: string }>>`select business_date::text as "businessDate" from business_days where property_id=${property.propertyId}::uuid and status='open' order by business_date limit 1`;
        if (!open || open.businessDate !== property.businessDate) return { propertyId: property.propertyId, status: "already done" };
        return runNightAudit(tx, { propertyId: property.propertyId, trigger: "scheduled" });
      }));
    }
    catch (error) { results.push({ propertyId: property.propertyId, status: "error", error: error instanceof Error ? error.message : "Unknown error" }); }
  }
  return Response.json({ results });
}

export const GET = POST;
