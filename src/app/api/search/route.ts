import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({ q: z.string().trim().min(2).max(100) });

type SearchResult = {
  id: string;
  kind: "guest" | "reservation" | "room" | "company" | "folio" | "invoice";
  label: string;
  detail: string;
  href: string;
};

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Enter at least two characters to search." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ results: [] satisfies SearchResult[] });

    const query = `%${parsed.data.q.replace(/[\\%_]/g, "\\$&")}%`;
    const sql = productionSql();
    const [guests, reservations, rooms, companies, folios, invoices] = await Promise.all([
      sql<Array<{ id: string; name: string; phone: string | null }>>`
        select distinct g.id,concat_ws(' ',g.first_name,g.last_name) as name,g.phone
        from guests g left join guest_identities gi on gi.guest_id=g.id and gi.deleted_at is null
        where g.property_id=${session.propertyId}::uuid and g.archived_at is null
          and (concat_ws(' ',g.first_name,g.last_name) ilike ${query} or coalesce(g.phone,'') ilike ${query} or coalesce(gi.id_number,'') ilike ${query})
        order by name limit 4
      `,
      sql<Array<{ id: string; confirmation: string; guestName: string; room: string | null; status: string }>>`
        select r.id,r.confirmation_number as confirmation,concat_ws(' ',g.first_name,g.last_name) as "guestName",
          (select rm.number from reservation_rooms rr left join rooms rm on rm.id=rr.room_id where rr.reservation_id=r.id order by rr.created_at limit 1) as room,r.status
        from reservations r join guests g on g.id=r.main_guest_id
        where r.property_id=${session.propertyId}::uuid and (r.confirmation_number ilike ${query} or concat_ws(' ',g.first_name,g.last_name) ilike ${query})
        order by r.updated_at desc limit 4
      `,
      sql<Array<{ id: string; number: string; roomType: string; serviceStatus: string }>>`
        select r.id,r.number,rt.name as "roomType",r.service_status as "serviceStatus"
        from rooms r join room_types rt on rt.id=r.room_type_id
        where r.property_id=${session.propertyId}::uuid and r.number ilike ${query}
        order by r.number limit 4
      `,
      sql<Array<{ id: string; name: string; contact: string | null }>>`
        select c.id,c.name,cc.name as contact from companies c
        left join lateral (select name from company_contacts where company_id=c.id order by "primary" desc limit 1) cc on true
        where c.property_id=${session.propertyId}::uuid and (c.name ilike ${query} or coalesce(cc.name,'') ilike ${query})
        order by c.name limit 4
      `,
      sql<Array<{ id: string; number: string; reservationId: string; guestName: string }>>`
        select f.id,f.number,f.reservation_id as "reservationId",concat_ws(' ',g.first_name,g.last_name) as "guestName"
        from folios f join reservations r on r.id=f.reservation_id join guests g on g.id=r.main_guest_id
        where f.property_id=${session.propertyId}::uuid and f.number ilike ${query}
        order by f.updated_at desc limit 4
      `,
      sql<Array<{ id: string; number: string; company: string; reservationId: string; status: string }>>`
        select i.id,i.number,c.name as company,i.reservation_id as "reservationId",i.status
        from invoices i join companies c on c.id=i.company_id
        where i.property_id=${session.propertyId}::uuid and (i.number ilike ${query} or c.name ilike ${query})
        order by i.updated_at desc limit 4
      `,
    ]);
    const results: SearchResult[] = [
      ...guests.map((guest) => ({ id: guest.id, kind: "guest" as const, label: guest.name, detail: `Guest${guest.phone ? ` · ${guest.phone}` : ""}`, href: `/guests?search=${encodeURIComponent(guest.name)}` })),
      ...reservations.map((reservation) => ({ id: reservation.id, kind: "reservation" as const, label: reservation.guestName, detail: `Reservation ${reservation.confirmation}${reservation.room ? ` · Room ${reservation.room}` : ""} · ${reservation.status}`, href: `/reservations/${reservation.id}` })),
      ...rooms.map((room) => ({ id: room.id, kind: "room" as const, label: `Room ${room.number}`, detail: `${room.roomType} · ${room.serviceStatus}`, href: `/floor-map?room=${encodeURIComponent(room.number)}` })),
      ...companies.map((company) => ({ id: company.id, kind: "company" as const, label: company.name, detail: `Company${company.contact ? ` · ${company.contact}` : ""}`, href: "/companies" })),
      ...folios.map((folio) => ({ id: folio.id, kind: "folio" as const, label: folio.number, detail: `Folio · ${folio.guestName}`, href: `/reservations/${folio.reservationId}` })),
      ...invoices.map((invoice) => ({ id: invoice.id, kind: "invoice" as const, label: invoice.number, detail: `Invoice · ${invoice.company} · ${invoice.status}`, href: `/reservations/${invoice.reservationId}` })),
    ].slice(0, 12);
    return Response.json({ results });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
