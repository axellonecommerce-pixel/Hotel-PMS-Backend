import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";

// HotelKey "Lost & Found": log a found item with where and when it was found,
// keep it in storage, and record who it was returned to or how it was
// disposed of.
const createSchema = z.object({
  item: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  location: z.string().trim().min(1).max(120),
  foundBy: z.string().trim().min(1).max(120),
  foundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reservationId: z.string().uuid().optional(),
  guestName: z.string().trim().max(120).optional(),
  storageLocation: z.string().trim().max(120).optional(),
});
const closeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["returned", "disposed", "stored"]),
  closedBy: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const items = await productionSql()<Array<Record<string, unknown>>>`
      select l.id, l.item, l.description, l.location, l.found_date::text as "foundDate", l.found_by as "foundBy",
        l.reservation_id as "reservationId", r.confirmation_number as "confirmationNumber", l.guest_name as "guestName",
        l.storage_location as "storageLocation", l.status, l.closed_date::text as "closedDate", l.closed_by as "closedBy", l.closed_note as "closedNote"
      from lost_found_items l left join reservations r on r.id=l.reservation_id
      where l.property_id=${session.propertyId}::uuid
      order by (l.status='stored') desc, l.found_date desc, l.created_at desc
    `;
    return Response.json({ items });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter the item, where it was found, and who found it." }, { status: 400 });
    const input = parsed.data;
    const sql = productionSql();
    const foundDate = input.foundDate ?? await propertyBusinessDate(sql, session.propertyId);
    const [created] = await sql<Array<{ id: string }>>`
      insert into lost_found_items (property_id, item, description, location, found_date, found_by, reservation_id, guest_name, storage_location)
      values (${session.propertyId}::uuid, ${input.item}, ${input.description ?? null}, ${input.location}, ${foundDate}::date, ${input.foundBy},
        (select id from reservations where id=${input.reservationId ?? null}::uuid and property_id=${session.propertyId}::uuid), ${input.guestName ?? null}, ${input.storageLocation ?? null})
      returning id
    `;
    return Response.json({ id: created.id }, { status: 201 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "housekeeping.manage");
    const parsed = closeSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Choose returned or disposed and who handled it." }, { status: 400 });
    const input = parsed.data;
    if (input.status !== "stored" && !input.closedBy) return Response.json({ error: "Enter who the item was returned to or who disposed of it." }, { status: 400 });
    const sql = productionSql();
    const closedDate = input.status === "stored" ? null : await propertyBusinessDate(sql, session.propertyId);
    const [updated] = await sql<Array<{ id: string }>>`
      update lost_found_items set status=${input.status}, closed_date=${closedDate}::date,
        closed_by=${input.status === "stored" ? null : input.closedBy ?? null}, closed_note=${input.status === "stored" ? null : input.note ?? null}, updated_at=now()
      where id=${input.id}::uuid and property_id=${session.propertyId}::uuid
      returning id
    `;
    if (!updated) return Response.json({ error: "Item not found." }, { status: 404 });
    return Response.json({ id: updated.id, status: input.status });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
