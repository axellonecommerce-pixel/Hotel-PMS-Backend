import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { nightAuditDue, nightAuditDueAt, runNightAudit } from "@/server/night-audit/run-night-audit";
import { withRequestContext } from "@/server/db/request-context";

/**
 * What every open screen needs to show the scheduled audit on time: the open
 * business day, the exact instant the audit is due, and the latest run (so a
 * run the database scheduler did is shown as soon as it finishes). Any role
 * can read it; only the schedule and run summary are returned.
 */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.read");
    const [state] = await productionSql()<Array<{ businessDate: string; timezone: string; schedule: { enabled?: boolean; time?: string } | null }>>`
      select b.business_date::text as "businessDate",p.timezone,ps.value as schedule
      from properties p
      join business_days b on b.property_id=p.id and b.status='open'
      left join property_settings ps on ps.property_id=p.id and ps.key='night_audit_schedule'
      where p.id=${session.propertyId}::uuid
      order by b.business_date limit 1
    `;
    const [lastRun] = await productionSql()<Array<{ status: string; trigger: string; businessDate: string; completedAt: string | null; steps: unknown; blockers: unknown }>>`
      select n.status,n.trigger,b.business_date::text as "businessDate",n.completed_at as "completedAt",n.summary as steps,n.blocking_issues as blockers
      from night_audit_runs n join business_days b on b.id=n.business_day_id
      where n.property_id=${session.propertyId}::uuid order by n.started_at desc limit 1
    `;
    const enabled = Boolean(state?.schedule?.enabled && state.schedule.time);
    return Response.json({
      businessDate: state?.businessDate ?? null,
      enabled,
      time: state?.schedule?.time ?? null,
      dueAt: enabled && state ? nightAuditDueAt({ businessDate: state.businessDate, time: state.schedule!.time!, timezone: state.timezone }) : null,
      lastRun: lastRun ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/**
 * Runs the scheduled Night Audit when it is due. Every open PMS screen asks
 * once a minute; the server decides from the hotel's clock and saved time,
 * and the audit's lock plus the open-day check make it run only once.
 */
async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.read");
    const [state] = await productionSql()<Array<{ businessDate: string; timezone: string; schedule: { enabled?: boolean; time?: string } | null }>>`
      select b.business_date::text as "businessDate",p.timezone,ps.value as schedule
      from properties p
      join business_days b on b.property_id=p.id and b.status='open'
      left join property_settings ps on ps.property_id=p.id and ps.key='night_audit_schedule'
      where p.id=${session.propertyId}::uuid
      order by b.business_date limit 1
    `;
    if (!state?.schedule?.enabled || !state.schedule.time) return Response.json({ ran: false, reason: "not scheduled" });
    if (!nightAuditDue({ businessDate: state.businessDate, time: state.schedule.time, timezone: state.timezone })) return Response.json({ ran: false, reason: "not due" });
    // A failed (blocked) run today is not retried every minute.
    const [recentFailure] = await productionSql()<Array<{ id: string }>>`
      select n.id from night_audit_runs n join business_days b on b.id=n.business_day_id
      where n.property_id=${session.propertyId}::uuid and b.business_date=${state.businessDate}::date
        and n.trigger='scheduled' and n.status='failed' and n.started_at > now() - interval '30 minutes'
      limit 1
    `;
    if (recentFailure) return Response.json({ ran: false, reason: "blocked recently" });
    const result = await productionSql().begin(async (tx) => {
      // Re-check inside the lock: another device may have just run it.
      await tx`select pg_advisory_xact_lock(hashtext(${`night-audit:${session.propertyId}`}))`;
      const [open] = await tx<Array<{ businessDate: string }>>`select business_date::text as "businessDate" from business_days where property_id=${session.propertyId}::uuid and status='open' order by business_date limit 1`;
      if (!open || open.businessDate !== state.businessDate) return null;
      return runNightAudit(tx, { propertyId: session.propertyId, trigger: "scheduled" });
    });
    return Response.json(result ? { ran: true, result } : { ran: false, reason: "already done" });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
