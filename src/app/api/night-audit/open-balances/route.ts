import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { pastReservationsWithBalance } from "@/server/night-audit/open-balances";

export const dynamic = "force-dynamic";

/** Finished reservations whose folio is not settled (shown in red on the Night Audit page). */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (!hasProductionDatabase()) return Response.json({ reservations: [] });
    return Response.json({ reservations: await pastReservationsWithBalance(productionSql(), session.propertyId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}
