import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const records = await productionSql()<Array<{ id: string; date: string; category: string; vendor: string; description: string; amountCents: number }>>`
      select e.id,e.expense_date::text as date,e.category,coalesce(v.name,'Other') as vendor,e.description,e.amount_cents as "amountCents"
      from expenses e left join vendors v on v.id=e.vendor_id
      where e.property_id=${session.propertyId}::uuid
        and e.expense_date between ${input.data.startDate}::date and ${input.data.endDate}::date
      order by e.expense_date desc,e.created_at desc
    `;
    const total = records.reduce((sum, record) => sum + record.amountCents, 0);
    const largest = records.reduce((current, record) => !current || record.amountCents > current.amountCents ? record : current, null as typeof records[number] | null);
    return Response.json({ report: {
      metrics: [
        { label: "Total Expenses", value: total, format: "money" },
        { label: "Entries", value: records.length, format: "number" },
        { label: "Average Expense", value: records.length ? Math.round(total / records.length) : 0, format: "money" },
        { label: "Largest Expense", value: largest?.amountCents ?? 0, format: "money" },
      ],
      columns: [
        { key: "date", label: "Date", format: "date" },
        { key: "category", label: "Category", format: "status" },
        { key: "vendor", label: "Vendor" },
        { key: "description", label: "Description" },
        { key: "amount", label: "Amount", format: "money", align: "right" },
      ],
      rows: records.map((record) => ({ id: record.id, date: record.date, category: record.category, vendor: record.vendor, description: record.description, amount: record.amountCents })),
      note: "Expenses are tenant-scoped posted expense records in the selected business-date range.",
    } });
  } catch (error) { return propertyAccessResponse(error); }
}
