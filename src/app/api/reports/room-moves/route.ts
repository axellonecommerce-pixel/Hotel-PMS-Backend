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
    if (!input.success || input.data.startDate > input.data.endDate) {
      return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    }
    if (!hasProductionDatabase()) {
      return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    }

    const records = await productionSql()<Array<{
      id: string;
      movedAt: string;
      guest: string;
      fromRoom: string;
      toRoom: string;
      rateDecision: string;
      remark: string;
    }>>`
      select rm.id,rm.moved_at::text as "movedAt",
        concat(g.first_name,' ',g.last_name) as guest,
        from_room.number as "fromRoom",to_room.number as "toRoom",
        rm.rate_decision as "rateDecision",rm.remark
      from room_moves rm
      join reservation_rooms rr on rr.id=rm.reservation_room_id
      join reservations r on r.id=rr.reservation_id
      join guests g on g.id=r.main_guest_id
      join rooms from_room on from_room.id=rm.from_room_id
      join rooms to_room on to_room.id=rm.to_room_id
      where rm.property_id=${session.propertyId}::uuid
        and rm.moved_at::date between ${input.data.startDate}::date and ${input.data.endDate}::date
      order by rm.moved_at desc
    `;
    const retained = records.filter((record) => record.rateDecision === "keep").length;
    const changed = records.filter((record) => record.rateDecision === "change").length;
    return Response.json({
      report: {
        metrics: [
          { label: "Room Moves", value: records.length, format: "number" },
          { label: "Guests Moved", value: new Set(records.map((record) => record.guest)).size, format: "number" },
          { label: "Rate Retained", value: retained, format: "number" },
          { label: "Rate Changed", value: changed, format: "number" },
        ],
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "guest", label: "Guest" },
          { key: "from", label: "Old Room" },
          { key: "to", label: "New Room" },
          { key: "rate", label: "Rate Decision" },
          { key: "remark", label: "Required Remark" },
        ],
        rows: records.map((record) => ({
          id: record.id,
          date: record.movedAt.slice(0, 10),
          guest: record.guest,
          from: record.fromRoom,
          to: record.toRoom,
          rate: record.rateDecision === "change" ? "Changed to New Room Rate" : "Kept Existing Rate",
          remark: record.remark,
        })),
        note: "Every room move requires a remark. The prior room becomes available and dirty.",
      },
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
