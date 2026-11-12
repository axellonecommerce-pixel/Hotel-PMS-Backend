import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { pastReservationsWithBalance } from "@/server/night-audit/open-balances";
import { withRequestContext } from "@/server/db/request-context";

export const dynamic = "force-dynamic";

/** Finished reservations whose folio is not settled (shown in red on the Night Audit page). */
async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, ["night_audit.run", "reports.view"]);
    if (!hasProductionDatabase()) return Response.json({ reservations: [] });
    return Response.json({ reservations: await pastReservationsWithBalance(productionSql(), session.propertyId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
