import { eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { savedReportDefinitions } from "@/server/db/schema";

const schema = z.object({ name: z.string().trim().min(1), reportId: z.string().trim().min(1), columnKeys: z.array(z.string()).min(1) });

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const records = await db.query.savedReportDefinitions.findMany({ where: eq(savedReportDefinitions.propertyId, session.propertyId) });
    return Response.json({ savedReports: records.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name, reportId: item.baseReportId, columnKeys: JSON.parse(item.columnKeysJson) })) });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Report name and columns are required." }, { status: 400 });
    const now = new Date().toISOString();
    const report = { id: `saved-report-${crypto.randomUUID()}`, ...parsed.data };
    db.insert(savedReportDefinitions).values({ id: report.id, propertyId: session.propertyId, name: report.name, baseReportId: report.reportId, columnKeysJson: JSON.stringify(report.columnKeys), filtersJson: "{}", active: true, createdAt: now, updatedAt: now }).run();
    return Response.json({ report }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
