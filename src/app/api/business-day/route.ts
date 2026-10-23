import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

function localBusinessDate(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (part: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === part)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Could not determine the business date.");
  return `${year}-${month}-${day}`;
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (!hasProductionDatabase()) return Response.json({ businessDate: null });
    const [day] = await productionSql()<Array<{ businessDate: string }>>`
      select business_date::text as "businessDate" from business_days
      where property_id=${session.propertyId}::uuid and status='open'
      order by business_date limit 1
    `;
    return Response.json({ businessDate: day?.businessDate ?? null });
  } catch (error) { return propertyAccessResponse(error); }
}

/**
 * Repairs legacy properties created before initial business-day provisioning
 * existed. The operation is intentionally owner/manager scoped and
 * idempotent: it only opens a day when this property has none.
 */
export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const result = await productionSql().begin(async (tx) => {
      const [open] = await tx<Array<{ businessDate: string }>>`
        select business_date::text as "businessDate" from business_days
        where property_id=${session.propertyId}::uuid and status='open'
        order by business_date limit 1 for update
      `;
      if (open) return { businessDate: open.businessDate, created: false };
      const [property] = await tx<Array<{ timezone: string }>>`
        select timezone from properties where id=${session.propertyId}::uuid for update
      `;
      if (!property) throw new Error("Property not found.");
      const businessDate = localBusinessDate(property.timezone);
      const [created] = await tx<Array<{ businessDate: string }>>`
        insert into business_days (property_id,business_date,status,opened_at)
        values (${session.propertyId}::uuid,${businessDate}::date,'open',now())
        on conflict (property_id,business_date) do update
          set status=case when business_days.status='closed' then 'open' else business_days.status end
        returning business_date::text as "businessDate"
      `;
      return { businessDate: created.businessDate, created: true };
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) { return propertyAccessResponse(error); }
}
