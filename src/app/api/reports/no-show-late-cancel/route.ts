import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Current no-show/cancelled records, filtered by their last lifecycle change. */
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
    const records = await productionSql()<Array<{
      id: string;
      changedAt: string;
      confirmation: string;
      guest: string;
      company: string | null;
      arrival: string;
      departure: string;
      status: string;
      note: string | null;
      feeCents: number;
    }>>`
      select r.id,r.updated_at::text as "changedAt",r.confirmation_number as confirmation,
        concat(g.first_name,' ',g.last_name) as guest,c.name as company,
        r.arrival_date::text as arrival,r.departure_date::text as departure,r.status,r.notes as note,
        coalesce((select sum(ch.amount_cents) from charges ch join folios f on f.id=ch.folio_id
          where f.reservation_id=r.id and ch.status='posted' and ch.type in ('No-show Fee','Cancellation Fee')),0)::int as "feeCents"
      from reservations r
      join guests g on g.id=r.main_guest_id
      left join companies c on c.id=r.company_id
      where r.property_id=${session.propertyId}::uuid
        and r.status in ('no_show','cancelled')
        and r.updated_at::date between ${input.data.startDate}::date and ${input.data.endDate}::date
      order by r.updated_at desc
    `;
    const isNoShow = (record: typeof records[number]) => record.status === "no_show";
    return Response.json({
      report: {
        metrics: [
          { label: "No Shows", value: records.filter(isNoShow).length, format: "number" },
          { label: "Late Cancels", value: records.filter((record) => !isNoShow(record)).length, format: "number" },
          { label: "Fees Posted", value: records.reduce((sum, record) => sum + record.feeCents, 0), format: "money" },
          { label: "Records", value: records.length, format: "number" },
        ],
        columns: [
          { key: "changed", label: "Processed", format: "date" },
          { key: "confirmation", label: "Confirmation" },
          { key: "guest", label: "Guest" },
          { key: "company", label: "Company" },
          { key: "arrival", label: "Arrival", format: "date" },
          { key: "departure", label: "Departure", format: "date" },
          { key: "status", label: "Status", format: "status" },
          { key: "fee", label: "Fee", format: "money", align: "right" },
          { key: "remarks", label: "Remarks" },
        ],
        rows: records.map((record) => ({
          id: record.id,
          changed: record.changedAt.slice(0, 10),
          confirmation: record.confirmation,
          guest: record.guest,
          company: record.company ?? "—",
          arrival: record.arrival,
          departure: record.departure,
          status: isNoShow(record) ? "No Show" : "Cancelled",
          fee: record.feeCents,
          remarks: record.note ?? "—",
        })),
        note: "Shows current no-show and cancelled reservations processed in the selected range. Reinstated reservations are excluded because their current status is active.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
