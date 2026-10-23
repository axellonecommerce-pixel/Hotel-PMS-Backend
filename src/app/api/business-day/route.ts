import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

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
