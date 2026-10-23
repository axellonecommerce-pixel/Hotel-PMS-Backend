import { z } from "zod";

import { summarizeRevenueLedger } from "@/server/finance/revenue-summary";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((value) => value.start <= value.end, { message: "Date range is invalid." });

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "A valid revenue date range is required." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ records: [] });
    const rows = await productionSql()<Array<{ date: string; roomRevenueCents: number; taxCents: number; miscellaneousRevenueCents: number }>>`
      select business_date::text as date,
        coalesce(sum(credit_cents) filter (where account='Room Revenue'),0)::int as "roomRevenueCents",
        coalesce(sum(credit_cents) filter (where account='Tax Payable'),0)::int as "taxCents",
        coalesce(sum(credit_cents) filter (where account like 'Revenue:%'),0)::int as "miscellaneousRevenueCents"
      from ledger_entries
      where property_id=${session.propertyId}::uuid
        and business_date between ${parsed.data.start}::date and ${parsed.data.end}::date
      group by business_date order by business_date desc
    `;
    return Response.json({ records: summarizeRevenueLedger(rows) });
  } catch (error) { return propertyAccessResponse(error); }
}
