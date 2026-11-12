import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";
import { withRequestContext } from "@/server/db/request-context";

/**
 * Download guest data (Guests page): one guest's complete record — profile,
 * ID details, vehicles, remarks and every stay with its rooms, charges,
 * tax, payments and refunds — or every guest at the motel in one file.
 * JSON holds everything; CSV opens in Excel (one row per stay, or per guest).
 * Only people who manage guests can download, and every download is noted.
 */
const querySchema = z.object({
  guestId: z.string().uuid().optional(),
  format: z.enum(["json", "csv"]).default("csv"),
});

const money = (cents: number | null | undefined) => ((cents ?? 0) / 100).toFixed(2);
function csv(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    // Excel would run a cell starting with = + - @ as a formula.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => cell(row[header])).join(","))].join("\r\n");
}
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "guest";

type Stay = {
  reservationId: string; confirmation: string; status: string; arrival: string; departure: string; source: string | null; company: string | null;
  rooms: Array<{ number: string | null; roomType: string | null; checkedInAt: string | null; checkedOutAt: string | null }>;
  charges: Array<{ date: string | null; type: string; description: string | null; amountCents: number; taxCents: number; status: string }>;
  payments: Array<{ date: string; method: string; amountCents: number; cardType: string | null; reference: string | null; note: string | null; refundedCents: number }>;
  role: "main guest" | "additional guest";
};

async function staysFor(sql: ReturnType<typeof productionSql>, propertyId: string, guestIds: string[]) {
  if (!guestIds.length) return new Map<string, Stay[]>();
  const rows = await sql<Array<{ guestId: string; role: Stay["role"]; reservationId: string; confirmation: string; status: string; arrival: string; departure: string; source: string | null; company: string | null }>>`
    with links as (
      select r.main_guest_id as guest_id, r.id as reservation_id, 'main guest' as role from reservations r
        where r.property_id=${propertyId}::uuid and r.main_guest_id = any(${guestIds}::uuid[])
      union
      select rg.guest_id, rg.reservation_id, 'additional guest' from reservation_guests rg join reservations r on r.id=rg.reservation_id
        where r.property_id=${propertyId}::uuid and rg.guest_id = any(${guestIds}::uuid[]) and rg.guest_id <> r.main_guest_id
    )
    select l.guest_id::text as "guestId", l.role, r.id::text as "reservationId", r.confirmation_number as confirmation, r.status,
      r.arrival_date::text as arrival, r.departure_date::text as departure, bs.name as source, c.name as company
    from links l join reservations r on r.id=l.reservation_id
    left join booking_sources bs on bs.id=r.booking_source_id
    left join companies c on c.id=r.company_id
    order by r.arrival_date desc`;
  const reservationIds = [...new Set(rows.map((row) => row.reservationId))];
  const [rooms, charges, payments] = reservationIds.length ? await Promise.all([
    sql<Array<{ reservationId: string; number: string | null; roomType: string | null; checkedInAt: string | null; checkedOutAt: string | null }>>`
      select rr.reservation_id::text as "reservationId", rm.number, rt.name as "roomType", rr.checked_in_at::text as "checkedInAt", rr.checked_out_at::text as "checkedOutAt"
      from reservation_rooms rr left join rooms rm on rm.id=rr.room_id left join room_types rt on rt.id=rr.room_type_id
      where rr.reservation_id = any(${reservationIds}::uuid[]) order by rm.number`,
    sql<Array<{ reservationId: string; date: string | null; type: string; description: string | null; amountCents: number; taxCents: number; status: string }>>`
      select f.reservation_id::text as "reservationId", ch.service_date::text as date, ch.type, ch.description, ch.amount_cents as "amountCents",
        coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=ch.id),0)::int as "taxCents", ch.status
      from charges ch join folios f on f.id=ch.folio_id
      where f.reservation_id = any(${reservationIds}::uuid[]) order by ch.service_date nulls last, ch.created_at`,
    sql<Array<{ reservationId: string; date: string; method: string; amountCents: number; cardType: string | null; reference: string | null; note: string | null; refundedCents: number }>>`
      select p.reservation_id::text as "reservationId", p.effective_date::text as date, p.method, p.amount_cents as "amountCents", p.card_type as "cardType",
        p.external_reference as reference, p.note, coalesce((select sum(rf.amount_cents) from refunds rf where rf.payment_id=p.id),0)::int as "refundedCents"
      from payments p where p.reservation_id = any(${reservationIds}::uuid[]) order by p.effective_date, p.created_at`,
  ]) : [[], [], []];
  const byGuest = new Map<string, Stay[]>();
  for (const row of rows) {
    const stay: Stay = {
      reservationId: row.reservationId, confirmation: row.confirmation, status: row.status, arrival: row.arrival, departure: row.departure,
      source: row.source, company: row.company, role: row.role,
      rooms: rooms.filter((room) => room.reservationId === row.reservationId).map(({ reservationId: _r, ...room }) => room),
      charges: charges.filter((charge) => charge.reservationId === row.reservationId).map(({ reservationId: _r, ...charge }) => charge),
      payments: payments.filter((payment) => payment.reservationId === row.reservationId).map(({ reservationId: _r, ...payment }) => payment),
    };
    byGuest.set(row.guestId, [...(byGuest.get(row.guestId) ?? []), stay]);
  }
  return byGuest;
}

const totals = (stay: Stay) => {
  const posted = stay.charges.filter((charge) => charge.status !== "voided");
  const chargesCents = posted.reduce((sum, charge) => sum + charge.amountCents, 0);
  const taxCents = posted.reduce((sum, charge) => sum + charge.taxCents, 0);
  const paidCents = stay.payments.reduce((sum, payment) => sum + payment.amountCents - payment.refundedCents, 0);
  return { chargesCents, taxCents, paidCents, balanceCents: chargesCents + taxCents - paidCents };
};

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Guest downloads need the PMS database." }, { status: 503 });
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Choose a guest and a file type." }, { status: 400 });
    const { guestId, format } = parsed.data;
    const sql = productionSql();
    const [motel] = await sql<Array<{ name: string }>>`select name from properties where id=${session.propertyId}::uuid`;
    const guests = await sql<Array<{ id: string; firstName: string; lastName: string; phone: string | null; email: string | null; address: unknown; status: string; remarks: string | null; dnrReason: string | null; roomPreferences: unknown; archivedAt: string | null; createdAt: string }>>`
      select id::text, first_name as "firstName", last_name as "lastName", phone, email, address, guest_status as status, remarks,
        dnr_reason as "dnrReason", room_preferences as "roomPreferences", archived_at::text as "archivedAt", created_at::text as "createdAt"
      from guests where property_id=${session.propertyId}::uuid ${guestId ? sql`and id=${guestId}::uuid` : sql``}
      order by last_name, first_name`;
    if (guestId && !guests.length) return Response.json({ error: "Guest not found." }, { status: 404 });
    const ids = guests.map((guest) => guest.id);
    const [identities, vehicles, remarks, stays] = await Promise.all([
      sql<Array<{ guestId: string; idType: string; idNumber: string | null; capturedAt: string | null }>>`
        select guest_id::text as "guestId", id_type as "idType", id_number as "idNumber", captured_at::text as "capturedAt"
        from guest_identities where property_id=${session.propertyId}::uuid and guest_id = any(${ids}::uuid[])`,
      sql<Array<{ guestId: string; plate: string | null; make: string | null; color: string | null; year: number | null }>>`
        select guest_id::text as "guestId", plate, make, color, year from guest_vehicles where property_id=${session.propertyId}::uuid and guest_id = any(${ids}::uuid[])`,
      sql<Array<{ guestId: string; remark: string; createdAt: string }>>`
        select guest_id::text as "guestId", remark, created_at::text as "createdAt" from guest_remarks where property_id=${session.propertyId}::uuid and guest_id = any(${ids}::uuid[]) order by created_at`,
      staysFor(sql, session.propertyId, ids),
    ]);
    const exportedAt = new Date().toISOString();
    // Note who downloaded guest data (shown in the activity feed like other changes).
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "guest", entityId: guestId ?? session.propertyId, action: "updated", entityVersion: Date.now(), payload: { exported: guestId ? "guest" : "all guests", format } }).catch(() => undefined);
    const fileBase = guestId ? `guest-${slug(`${guests[0].firstName} ${guests[0].lastName}`)}-${exportedAt.slice(0, 10)}` : `all-guests-${slug(motel?.name ?? "motel")}-${exportedAt.slice(0, 10)}`;

    if (format === "json") {
      const records = guests.map((guest) => ({
        ...guest,
        identities: identities.filter((item) => item.guestId === guest.id).map(({ guestId: _g, ...item }) => item),
        vehicles: vehicles.filter((item) => item.guestId === guest.id).map(({ guestId: _g, ...item }) => item),
        remarkHistory: remarks.filter((item) => item.guestId === guest.id).map(({ guestId: _g, ...item }) => item),
        stays: (stays.get(guest.id) ?? []).map((stay) => ({ ...stay, totals: totals(stay) })),
      }));
      const body = JSON.stringify({ motel: motel?.name ?? null, exportedAt, guests: guestId ? undefined : records, guest: guestId ? records[0] : undefined }, null, 2);
      return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${fileBase}.json"` } });
    }

    // CSV: one guest -> one row per stay; all guests -> one row per guest.
    const address = (value: unknown) => value && typeof value === "object" ? Object.values(value as Record<string, unknown>).filter((part) => typeof part === "string" && part).join(", ") : "";
    const rows = guestId
      ? (stays.get(guestId)?.length ? stays.get(guestId)! : [null]).map((stay) => {
        const guest = guests[0];
        const sum = stay ? totals(stay) : null;
        return {
          "Guest": `${guest.firstName} ${guest.lastName}`.trim(), "Phone": guest.phone, "Email": guest.email, "Address": address(guest.address),
          "ID": identities.filter((item) => item.guestId === guest.id).map((item) => `${item.idType} ${item.idNumber ?? ""}`.trim()).join("; "),
          "Vehicles": vehicles.filter((item) => item.guestId === guest.id).map((item) => [item.year, item.color, item.make, item.plate].filter(Boolean).join(" ")).join("; "),
          "Status": guest.status, "Do Not Rent reason": guest.dnrReason,
          "Confirmation": stay?.confirmation ?? "", "Stay status": stay?.status ?? "", "Arrival": stay?.arrival ?? "", "Departure": stay?.departure ?? "",
          "Rooms": stay?.rooms.map((room) => [room.number, room.roomType].filter(Boolean).join(" ")).join("; ") ?? "",
          "Source": stay?.source ?? "", "Company": stay?.company ?? "", "Guest on stay as": stay?.role ?? "",
          "Charges": sum ? money(sum.chargesCents) : "", "Tax": sum ? money(sum.taxCents) : "", "Paid": sum ? money(sum.paidCents) : "", "Balance": sum ? money(sum.balanceCents) : "",
          "Payments": stay?.payments.map((payment) => `${payment.date} ${payment.method} ${money(payment.amountCents)}${payment.refundedCents ? ` (refunded ${money(payment.refundedCents)})` : ""}`).join("; ") ?? "",
        };
      })
      : guests.map((guest) => {
        const list = stays.get(guest.id) ?? [];
        const spent = list.reduce((sum, stay) => sum + totals(stay).paidCents, 0);
        return {
          "Guest": `${guest.firstName} ${guest.lastName}`.trim(), "Phone": guest.phone, "Email": guest.email, "Address": address(guest.address),
          "ID": identities.filter((item) => item.guestId === guest.id).map((item) => `${item.idType} ${item.idNumber ?? ""}`.trim()).join("; "),
          "Vehicles": vehicles.filter((item) => item.guestId === guest.id).map((item) => [item.year, item.color, item.make, item.plate].filter(Boolean).join(" ")).join("; "),
          "Status": guest.status, "Do Not Rent reason": guest.dnrReason, "Remarks": guest.remarks,
          "Stays": list.length, "First stay": list.at(-1)?.arrival ?? "", "Last stay": list[0]?.arrival ?? "", "Total paid": money(spent),
          "Guest since": guest.createdAt.slice(0, 10),
        };
      });
    // A byte-order mark so Excel reads accents and symbols correctly.
    return new Response(`﻿${csv(rows)}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${fileBase}.csv"` } });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
