import { z } from "zod";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { allocateDocumentNumber } from "@/server/finance/documents";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { allocateProductionDocumentNumber } from "@/server/finance/production-finance";
import { withRequestContext } from "@/server/db/request-context";

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = z.object({ date: z.string().optional() }).safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Invalid document date." }, { status: 400 });
    const date = parsed.data.date ? new Date(`${parsed.data.date}T12:00:00Z`) : new Date();
    const documentNumber = hasProductionDatabase()
      ? await productionSql().begin((tx) => allocateProductionDocumentNumber(tx, session.propertyId, date))
      : allocateDocumentNumber(session.propertyId, date);
    return Response.json({ documentNumber }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const POST = withRequestContext(routePOST);
