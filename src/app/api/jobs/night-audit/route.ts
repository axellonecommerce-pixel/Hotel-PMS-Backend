import { timingSafeEqual } from "node:crypto";

import { productionSql } from "@/server/db/production";
import { runNightAudit } from "@/server/night-audit/run-night-audit";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  return Boolean(expected && supplied && expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const properties = await productionSql()<Array<{ propertyId: string; timezone: string; businessDate: string; schedule: { enabled?: boolean; time?: string } | null }>>`
    select p.id as "propertyId",p.timezone,b.business_date::text as "businessDate",ps.value as schedule
    from properties p join business_days b on b.property_id=p.id and b.status='open'
    left join property_settings ps on ps.property_id=p.id and ps.key='night_audit_schedule'
  `;
  const results = [];
  for (const property of properties) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: property.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    const localDate = `${part("year")}-${part("month")}-${part("day")}`;
    // Hobby cron timing is approximate and limited to once daily. Run only when the
    // hotel's open business date is behind its local calendar date; manual audit
    // remains available at any time.
    if (!property.schedule?.enabled || property.businessDate >= localDate) continue;
    try { results.push(await productionSql().begin((tx) => runNightAudit(tx, { propertyId: property.propertyId, trigger: "scheduled" }))); }
    catch (error) { results.push({ propertyId: property.propertyId, status: "error", error: error instanceof Error ? error.message : "Unknown error" }); }
  }
  return Response.json({ results });
}

export const GET = POST;
