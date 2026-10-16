import { z } from "zod";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { allocateDocumentNumber } from "@/server/finance/documents";

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = z.object({ date: z.string().optional() }).safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Invalid document date." }, { status: 400 });
    return Response.json({ documentNumber: allocateDocumentNumber(session.propertyId, parsed.data.date ? new Date(`${parsed.data.date}T12:00:00Z`) : new Date()) }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
