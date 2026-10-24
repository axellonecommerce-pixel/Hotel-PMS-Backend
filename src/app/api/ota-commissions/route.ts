import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { listOtaCommissions } from "@/server/finance/ota-commission";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (!hasProductionDatabase()) return Response.json({ rows: [] });
    const url = new URL(request.url);
    const input = querySchema.safeParse({ startDate: url.searchParams.get("startDate") ?? undefined, endDate: url.searchParams.get("endDate") ?? undefined });
    if (!input.success) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    const rows = await listOtaCommissions(productionSql(), session.propertyId, input.data.startDate, input.data.endDate);
    return Response.json({ rows });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
