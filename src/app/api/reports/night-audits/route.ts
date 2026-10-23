import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** A read-only operational summary of completed and blocked business-day closes. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) {
      return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    }
    if (!hasProductionDatabase()) {
      return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    }

    const runs = await productionSql()<Array<{
      id: string;
      businessDate: string;
      trigger: string;
      status: string;
      blockers: unknown;
      completedAt: string | null;
    }>>`
      select nar.id,bd.business_date::text as "businessDate",nar.trigger,nar.status,
        nar.blocking_issues as blockers,nar.completed_at::text as "completedAt"
      from night_audit_runs nar
      join business_days bd on bd.id=nar.business_day_id
      where nar.property_id=${session.propertyId}::uuid
        and bd.business_date between ${input.data.startDate}::date and ${input.data.endDate}::date
      order by bd.business_date desc,nar.completed_at desc nulls last
    `;
    const blockerText = (value: unknown) => Array.isArray(value) && value.length
      ? value.filter((item): item is string => typeof item === "string").join(", ")
      : "—";
    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    return Response.json({
      report: {
        metrics: [
          { label: "Audit Runs", value: runs.length, format: "number" },
          { label: "Completed", value: completed, format: "number" },
          { label: "Blocked", value: failed, format: "number" },
          { label: "Scheduled", value: runs.filter((run) => run.trigger === "scheduled").length, format: "number" },
        ],
        columns: [
          { key: "date", label: "Business Date", format: "date" },
          { key: "status", label: "Status", format: "status" },
          { key: "trigger", label: "Run Type" },
          { key: "blockers", label: "Blocking Issues" },
          { key: "completed", label: "Completed At" },
        ],
        rows: runs.map((run) => ({
          id: run.id,
          date: run.businessDate,
          status: run.status === "completed" ? "Completed" : "Blocked",
          trigger: run.trigger === "scheduled" ? "Scheduled" : "Manual",
          blockers: blockerText(run.blockers),
          completed: run.completedAt ? new Date(run.completedAt).toLocaleString("en-US") : "—",
        })),
        note: "This report is read-only. Resolve any listed blockers before the next business-day close.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
