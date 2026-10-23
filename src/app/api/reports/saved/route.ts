import { eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { savedReportDefinitions } from "@/server/db/schema";

const schema = z.object({ name: z.string().trim().min(1), reportId: z.string().trim().min(1), columnKeys: z.array(z.string()).min(1) });
const storedReportsSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  reportId: z.string(),
  columnKeys: z.array(z.string()),
  active: z.boolean().default(true),
}));
const savedReportsKey = "saved_report_definitions";

function parseStoredReports(value: unknown) {
  return storedReportsSchema.safeParse(value).data ?? [];
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    if (hasProductionDatabase()) {
      const [stored] = await productionSql()<Array<{ value: unknown }>>`
        select value from property_settings where property_id=${session.propertyId}::uuid and key=${savedReportsKey}
      `;
      return Response.json({ savedReports: parseStoredReports(stored?.value).filter((item) => item.active) });
    }
    const records = await db.query.savedReportDefinitions.findMany({ where: eq(savedReportDefinitions.propertyId, session.propertyId) });
    return Response.json({ savedReports: records.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name, reportId: item.baseReportId, columnKeys: JSON.parse(item.columnKeysJson) })) });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Report name and columns are required." }, { status: 400 });
    const report = { id: `saved-report-${crypto.randomUUID()}`, ...parsed.data };
    if (hasProductionDatabase()) {
      const result = await productionSql().begin(async (tx) => {
        const [stored] = await tx<Array<{ value: unknown }>>`
          select value from property_settings where property_id=${session.propertyId}::uuid and key=${savedReportsKey} for update
        `;
        const reports = parseStoredReports(stored?.value);
        if (reports.some((item) => item.active && item.name.toLocaleLowerCase() === report.name.toLocaleLowerCase())) {
          return { duplicate: true as const };
        }
        const next = [...reports, { ...report, active: true }];
        await tx`
          insert into property_settings (property_id,key,value)
          values (${session.propertyId}::uuid,${savedReportsKey},${tx.json(next)})
          on conflict (property_id,key) do update set value=excluded.value,updated_at=now()
        `;
        return { duplicate: false as const };
      });
      if (result.duplicate) return Response.json({ error: "A saved report already has that name." }, { status: 409 });
      return Response.json({ report: { ...report, active: true } }, { status: 201 });
    }
    const now = new Date().toISOString();
    db.insert(savedReportDefinitions).values({ id: report.id, propertyId: session.propertyId, name: report.name, baseReportId: report.reportId, columnKeysJson: JSON.stringify(report.columnKeys), filtersJson: "{}", active: true, createdAt: now, updatedAt: now }).run();
    return Response.json({ report }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}
