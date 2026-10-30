import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { recordChange } from "@/server/realtime/change-events";
import { deletePrivateFiles } from "@/server/storage/private-files";

type Address = { addressLine1?: string; postalCode?: string; city?: string; state?: string; country?: string; countryCode?: string };
// These profile values live with the configurable guest preferences so they
// remain durable without requiring an unsafe production schema migration.
type SourceDetails = { note?: string; number?: string; date?: string };
type Preferences = { paymentSourceNotes?: Record<string, string>; paymentSourceDetails?: Record<string, SourceDetails>; fixedRateCents?: number; dateOfBirth?: string; idExpires?: string; secondaryPhone?: string; secondaryEmail?: string; roomPreferences?: Record<string, unknown> };

const blankAsNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? null : value), schema);
const guestStatusSchema = z.enum(["Regular", "Returning", "New", "Do Not Rent"]);
const paymentSourceSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1).max(120),
  last4: z.string().regex(/^\d{4}$/).optional(),
  tokenReference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  // A reference number (not a full card number) and a date, e.g. expiry.
  number: z.string().trim().max(60).refine((value) => !/^\d{13,19}$/.test(value.replace(/[\s-]/g, "")), "Never store a full card number.").optional(),
  date: z.string().trim().max(40).optional(),
});
// guest_payment_sources has no note, number or date columns; they live in the
// guest's preferences, keyed by the source's label and reference.
const paymentSourceKey = (source: { label: string; tokenReference?: string | null }) => `${source.label.trim().toLowerCase()}|${(source.tokenReference ?? "").trim()}`;
// Any one detail is enough (a plate may be unknown at first); all blank removes the vehicle.
const vehicleSchema = z.object({
  plate: z.string().trim().max(40).default(""),
  make: z.string().trim().max(80).optional(),
  color: z.string().trim().max(40).optional(),
  year: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).optional(),
  state: z.string().trim().max(40).optional(),
});
const updateSchema = z.object({
  guestId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().max(80).optional(),
  secondaryPhone: z.string().max(80).optional(),
  email: z.string().email().or(z.literal("")).optional(),
  secondaryEmail: z.string().email().or(z.literal("")).optional(),
  addressLine1: z.string().max(400).optional(),
  postalCode: z.string().max(40).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  countryCode: z.string().max(20).optional(),
  fixedRateCents: z.number().int().min(0).nullable().optional(),
  // A cleared date field arrives as "" and means no date.
  dateOfBirth: blankAsNull(z.string().date().nullable().optional()),
  idExpires: blankAsNull(z.string().date().nullable().optional()),
  notes: z.string().max(20_000).nullable().optional(),
  status: guestStatusSchema.optional(),
  roomPreferences: z.record(z.string(), z.unknown()).optional(),
  vehicle: vehicleSchema.nullable().optional(),
  savedPaymentSources: z.array(paymentSourceSchema).max(20).optional(),
  remarkEntries: z.array(z.object({ text: z.string().trim().min(1).max(2_000), createdAt: z.string().optional() })).max(100).optional(),
  dnrCode: z.string().max(200).optional(),
  dnrRemarks: z.string().max(10_000).nullable().optional(),
  idType: z.enum(["US Driver License", "Passport", "Other"]).nullable().optional(),
  driverLicenseNumber: z.string().trim().min(1).max(200).nullable().optional(),
}).superRefine((value, context) => {
  const changingIdentity = value.idType !== undefined || value.driverLicenseNumber !== undefined;
  if (changingIdentity && Boolean(value.idType) !== Boolean(value.driverLicenseNumber)) {
    context.addIssue({ code: "custom", message: "Enter both an ID type and ID number, or remove both." });
  }
});
const importSchema = z.object({
  rows: z.array(z.object({
    firstName: z.string().trim().min(1).max(120), lastName: z.string().trim().min(1).max(120),
    phone: z.string().max(80).optional(), city: z.string().max(120).optional(),
    idType: z.enum(["US Driver License", "Passport", "Other"]), driverLicenseNumber: z.string().trim().min(1).max(200),
    addressLine1: z.string().max(400).optional(), notes: z.string().max(10_000).optional(),
  })).min(1).max(2_000),
});
const manualGuestSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  phone: z.string().max(80).optional(),
  email: z.string().email().or(z.literal("")).optional(),
  idType: z.enum(["US Driver License", "Passport", "Other"]).optional(),
  idNumber: z.string().trim().max(200).optional(),
  dateOfBirth: z.preprocess((value) => (value === "" ? undefined : value), z.string().date().optional()),
  idExpires: z.preprocess((value) => (value === "" ? undefined : value), z.string().date().optional()),
  addressLine1: z.string().max(400).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
  countryCode: z.string().max(20).optional(),
  notes: z.string().max(10_000).optional(),
  status: guestStatusSchema.optional(),
}).refine((value) => Boolean(value.idType) === Boolean(value.idNumber?.trim()), {
  message: "Enter both an ID type and ID number, or leave both blank.",
});

function parseObject<T extends object>(value: unknown): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value === "string") try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T; } catch { /* use empty value */ }
  return {} as T;
}
function apiStatus(status: string) { return status === "do_not_rent" ? "Do Not Rent" : status === "returning" ? "Returning" : status === "regular" ? "Regular" : "New"; }
function storedStatus(status: z.infer<typeof guestStatusSchema>) { return status === "Do Not Rent" ? "do_not_rent" : status.toLowerCase(); }
function normalizedId(value: string) { return value.replace(/\s/g, "").toUpperCase(); }

async function listGuests(propertyId: string) {
  const sql = productionSql();
  const guests = await sql<Array<{ id: string; firstName: string; lastName: string; phone: string | null; email: string | null; address: unknown; guestStatus: string; remarks: string | null; dnrReason: string | null; roomPreferences: unknown; createdAt: string; updatedAt: string }>>`
    select id,first_name as "firstName",last_name as "lastName",phone,email,address,guest_status as "guestStatus",remarks,dnr_reason as "dnrReason",room_preferences as "roomPreferences",created_at::text as "createdAt",updated_at::text as "updatedAt"
    from guests where property_id=${propertyId}::uuid and archived_at is null
      -- A guest whose data was deleted before archiving existed.
      and not (first_name='Deleted' and last_name='Guest' and phone is null and email is null and room_preferences='{}'::jsonb)
    order by created_at desc,last_name,first_name
  `;
  if (!guests.length) return [];
  const identities = await sql<Array<{ guestId: string; idType: string; idNumber: string }>>`
    select distinct on (guest_id) guest_id as "guestId",id_type as "idType",id_number as "idNumber"
    from guest_identities where property_id=${propertyId}::uuid and deleted_at is null order by guest_id,captured_at desc
  `;
  const vehicles = await sql<Array<{ guestId: string; plate: string; make: string | null; color: string | null; year: string | null }>>`
    select distinct on (guest_id) guest_id as "guestId",plate,make,color,year from guest_vehicles where property_id=${propertyId}::uuid order by guest_id,updated_at desc
  `;
  const paymentSources = await sql<Array<{ guestId: string; id: string; label: string | null; last4: string | null; externalReference: string | null; method: string }>>`
    select guest_id as "guestId",id,label,last4,external_reference as "externalReference",method from guest_payment_sources where property_id=${propertyId}::uuid order by created_at desc
  `;
  const remarks = await sql<Array<{ guestId: string; id: string; text: string; createdAt: string }>>`
    select guest_id as "guestId",id,remark as text,created_at::text as "createdAt" from guest_remarks where property_id=${propertyId}::uuid order by created_at
  `;
  const stays = await sql<Array<{ guestId: string; id: string; room: string | null; checkInDate: string; checkoutDate: string; rateCents: number; totalCents: number }>>`
    select r.main_guest_id as "guestId",r.id,coalesce((select room.number from reservation_rooms rr left join rooms room on room.id=rr.room_id where rr.reservation_id=r.id order by rr.created_at limit 1),'Unassigned') as room,
      r.arrival_date::text as "checkInDate",r.departure_date::text as "checkoutDate",
      coalesce((select sum(nr.final_rate_cents) from nightly_rates nr join reservation_rooms rr on rr.id=nr.reservation_room_id where rr.reservation_id=r.id),0)::int as "rateCents",
      coalesce((select sum(c.amount_cents) from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted'),0)::int as "totalCents"
    from reservations r where r.property_id=${propertyId}::uuid and r.status='checked_out' order by r.departure_date desc
  `;
  const identityByGuest = new Map(identities.map((identity) => [identity.guestId, identity]));
  const vehicleByGuest = new Map(vehicles.map((vehicle) => [vehicle.guestId, vehicle]));
  const sourcesByGuest = new Map<string, Array<typeof paymentSources[number]>>();
  const remarksByGuest = new Map<string, Array<typeof remarks[number]>>();
  const staysByGuest = new Map<string, Array<typeof stays[number]>>();
  for (const source of paymentSources) sourcesByGuest.set(source.guestId, [...(sourcesByGuest.get(source.guestId) ?? []), source]);
  for (const remark of remarks) remarksByGuest.set(remark.guestId, [...(remarksByGuest.get(remark.guestId) ?? []), remark]);
  for (const stay of stays) staysByGuest.set(stay.guestId, [...(staysByGuest.get(stay.guestId) ?? []), stay]);
  return guests.map((guest) => {
    const address = parseObject<Address>(guest.address); const prefs = parseObject<Preferences>(guest.roomPreferences);
    const identity = identityByGuest.get(guest.id); const vehicle = vehicleByGuest.get(guest.id); const guestStays = staysByGuest.get(guest.id) ?? [];
    return {
      id: guest.id, createdAt: guest.createdAt, updatedAt: guest.updatedAt, firstName: guest.firstName, lastName: guest.lastName, phone: guest.phone ?? "", phoneNormalized: (guest.phone ?? "").replace(/\D/g, ""),
      city: address.city ?? "", addressLine1: address.addressLine1, postalCode: address.postalCode, state: address.state, country: address.country, countryCode: address.countryCode,
      email: guest.email ?? undefined, secondaryPhone: prefs.secondaryPhone, secondaryEmail: prefs.secondaryEmail, status: apiStatus(guest.guestStatus), fixedRateCents: prefs.fixedRateCents, dateOfBirth: prefs.dateOfBirth, idExpires: prefs.idExpires, roomPreferences: prefs.roomPreferences,
      idType: identity?.idType, driverLicenseNumber: identity?.idNumber, notes: guest.remarks ?? undefined, dnrRemarks: guest.dnrReason ?? undefined,
      vehicle: vehicle ? { plate: vehicle.plate, make: vehicle.make ?? "", color: vehicle.color ?? "", year: vehicle.year ?? "" } : undefined,
      savedPaymentSources: (sourcesByGuest.get(guest.id) ?? []).map((source) => { const label = source.label ?? source.method; const tokenReference = source.externalReference ?? ""; const key = paymentSourceKey({ label, tokenReference }); const details = prefs.paymentSourceDetails?.[key] ?? { note: prefs.paymentSourceNotes?.[key] }; return { id: source.id, label, last4: source.last4 ?? undefined, tokenReference, note: details.note, number: details.number, date: details.date }; }),
      remarkEntries: (remarksByGuest.get(guest.id) ?? []).map((remark) => ({ id: remark.id, text: remark.text, createdAt: remark.createdAt })),
      totalStays: guestStays.length, lastStayDate: guestStays[0]?.checkoutDate,
      stayHistory: guestStays.map((stay) => ({ ...stay, room: stay.room ?? "Unassigned", paymentType: "Credit" })),
    };
  });
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    if (!hasProductionDatabase()) return Response.json({ guests: [] });
    return Response.json({ guests: await listGuests(session.propertyId) });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return Response.json({ error: `Guest update is invalid${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}.` }, { status: 400 });
    }
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const input = parsed.data;
    const updated = await productionSql().begin(async (tx) => {
      const [guest] = await tx<Array<{ roomPreferences: unknown; address: unknown }>>`select room_preferences as "roomPreferences",address from guests where id=${input.guestId}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!guest) return false;
      const preferences = parseObject<Preferences>(guest.roomPreferences);
      const address = parseObject<Address>(guest.address);
      if (input.addressLine1 !== undefined) address.addressLine1 = input.addressLine1;
      if (input.postalCode !== undefined) address.postalCode = input.postalCode;
      if (input.city !== undefined) address.city = input.city;
      if (input.state !== undefined) address.state = input.state;
      if (input.country !== undefined) address.country = input.country;
      if (input.countryCode !== undefined) address.countryCode = input.countryCode;
      if (input.secondaryPhone !== undefined) preferences.secondaryPhone = input.secondaryPhone || undefined;
      if (input.secondaryEmail !== undefined) preferences.secondaryEmail = input.secondaryEmail || undefined;
      if (input.fixedRateCents !== undefined) preferences.fixedRateCents = input.fixedRateCents ?? undefined;
      if (input.dateOfBirth !== undefined) preferences.dateOfBirth = input.dateOfBirth ?? undefined;
      if (input.idExpires !== undefined) preferences.idExpires = input.idExpires ?? undefined;
      if (input.roomPreferences !== undefined) preferences.roomPreferences = input.roomPreferences;
      if (input.savedPaymentSources !== undefined) {
        const details = Object.fromEntries(input.savedPaymentSources.filter((source) => source.note || source.number || source.date)
          .map((source) => [paymentSourceKey(source), { note: source.note || undefined, number: source.number || undefined, date: source.date || undefined }]));
        preferences.paymentSourceDetails = Object.keys(details).length ? details : undefined;
        preferences.paymentSourceNotes = undefined;
      }
      const notes = input.notes ?? null;
      const dnrRemarks = input.dnrRemarks ?? null;
      const dnrCode = input.dnrCode ?? null;
      await tx`update guests set first_name=coalesce(${input.firstName ?? null},first_name),last_name=coalesce(${input.lastName ?? null},last_name),phone=case when ${input.phone !== undefined} then ${input.phone?.replace(/\D/g, "") || null} else phone end,email=case when ${input.email !== undefined} then ${input.email || null} else email end,address=${tx.json(address as never)},remarks=case when ${input.notes !== undefined} then ${notes} else remarks end,guest_status=coalesce(${input.status ? storedStatus(input.status) : null},guest_status),dnr_reason=case when ${input.dnrRemarks !== undefined} then ${dnrRemarks} when ${input.dnrCode !== undefined} then ${dnrCode} else dnr_reason end,room_preferences=${tx.json(preferences as never)},updated_at=now() where id=${input.guestId}::uuid and property_id=${session.propertyId}::uuid`;
      if (input.vehicle !== undefined) {
        await tx`delete from guest_vehicles where property_id=${session.propertyId}::uuid and guest_id=${input.guestId}::uuid`;
        const hasVehicle = input.vehicle && [input.vehicle.plate, input.vehicle.make, input.vehicle.color, input.vehicle.year].some((value) => value?.trim());
        if (input.vehicle && hasVehicle) await tx`insert into guest_vehicles (property_id,guest_id,plate,make,color,year) values (${session.propertyId}::uuid,${input.guestId}::uuid,${input.vehicle.plate},${input.vehicle.make || null},${input.vehicle.color || null},${input.vehicle.year || null})`;
      }
      if (input.savedPaymentSources !== undefined) {
        await tx`delete from guest_payment_sources where property_id=${session.propertyId}::uuid and guest_id=${input.guestId}::uuid`;
        for (const source of input.savedPaymentSources) await tx`insert into guest_payment_sources (property_id,guest_id,method,label,last4,external_reference) values (${session.propertyId}::uuid,${input.guestId}::uuid,'card',${source.label},${source.last4 || null},${source.tokenReference || null})`;
      }
      if (input.remarkEntries !== undefined) {
        // Remarks are a dated, append-only guest record. The client includes
        // its full visible history when it saves a new remark, so insert only
        // text not already present instead of replacing the history.
        const existingRemarks = await tx<Array<{ text: string }>>`
          select remark as text from guest_remarks
          where property_id=${session.propertyId}::uuid and guest_id=${input.guestId}::uuid
          for update
        `;
        const knownTexts = new Set(existingRemarks.map((remark) => remark.text.trim()));
        for (const remark of input.remarkEntries) {
          const text = remark.text.trim();
          if (!text || knownTexts.has(text)) continue;
          await tx`insert into guest_remarks (property_id,guest_id,remark) values (${session.propertyId}::uuid,${input.guestId}::uuid,${text})`;
          knownTexts.add(text);
        }
      }
      if (input.idType !== undefined || input.driverLicenseNumber !== undefined) {
        // Identity records are kept as history (soft-deleted), and the unique
        // key covers deleted rows too. Leave an unchanged ID alone, and reuse
        // a matching historical row instead of inserting a duplicate.
        const normalized = input.idType && input.driverLicenseNumber ? normalizedId(input.driverLicenseNumber) : null;
        const [current] = await tx<Array<{ id: string; idType: string; normalized: string }>>`
          select id, id_type as "idType", normalized_id_number as normalized from guest_identities
          where property_id=${session.propertyId}::uuid and guest_id=${input.guestId}::uuid and deleted_at is null
          order by captured_at desc limit 1
        `;
        const unchanged = current && normalized && current.idType === input.idType && current.normalized === normalized;
        if (!unchanged) {
          await tx`update guest_identities set deleted_at=now() where property_id=${session.propertyId}::uuid and guest_id=${input.guestId}::uuid and deleted_at is null`;
          if (input.idType && input.driverLicenseNumber && normalized) {
            const [existing] = await tx<Array<{ id: string; guestId: string; deletedAt: string | null }>>`
              select id, guest_id as "guestId", deleted_at::text as "deletedAt" from guest_identities
              where property_id=${session.propertyId}::uuid and id_type=${input.idType} and normalized_id_number=${normalized}
              limit 1 for update
            `;
            if (existing && !existing.deletedAt && existing.guestId !== input.guestId) throw new Error("A different guest already has this ID.");
            if (existing) {
              await tx`update guest_identities set guest_id=${input.guestId}::uuid, id_number=${input.driverLicenseNumber}, deleted_at=null, captured_at=now(), delete_after=now()+interval '1 year' where id=${existing.id}::uuid`;
            } else {
              await tx`insert into guest_identities (property_id,guest_id,id_type,id_number,normalized_id_number,delete_after)
                values (${session.propertyId}::uuid,${input.guestId}::uuid,${input.idType},${input.driverLicenseNumber},${normalized},now()+interval '1 year') on conflict (property_id,id_type,normalized_id_number) do update set guest_id=excluded.guest_id,id_number=excluded.id_number,deleted_at=null,captured_at=now(),delete_after=excluded.delete_after`;
            }
          }
        }
      }
      return true;
    });
    if (!updated) return Response.json({ error: "Guest not found." }, { status: 404 });
    return Response.json({ updated: true });
  } catch (error) {
    if (error instanceof Error && error.message === "A different guest already has this ID.") return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const body = await request.json();
    const manual = z.object({ guest: manualGuestSchema }).safeParse(body);
    if (manual.success) {
      if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
      const row = manual.data.guest;
      const result = await productionSql().begin(async (tx) => {
        const notes = row.notes?.trim() || null;
        const address = {
          addressLine1: row.addressLine1 ?? "", city: row.city ?? "", state: row.state ?? "",
          postalCode: row.postalCode ?? "", country: row.country ?? "", countryCode: row.countryCode ?? "",
        };
        if (row.idType && row.idNumber?.trim()) {
          const idNumber = normalizedId(row.idNumber);
          const [existing] = await tx<Array<{ guestId: string; guestStatus: string; roomPreferences: unknown }>>`
            select gi.guest_id as "guestId",g.guest_status as "guestStatus",g.room_preferences as "roomPreferences"
            from guest_identities gi join guests g on g.id=gi.guest_id
            where gi.property_id=${session.propertyId}::uuid and gi.id_type=${row.idType} and gi.normalized_id_number=${idNumber} and gi.deleted_at is null
            for update
          `;
          if (existing) {
            const preferences = parseObject<Preferences>(existing.roomPreferences);
            if (row.dateOfBirth !== undefined) preferences.dateOfBirth = row.dateOfBirth;
            if (row.idExpires !== undefined) preferences.idExpires = row.idExpires;
            await tx`update guests set first_name=${row.firstName},last_name=${row.lastName},phone=${row.phone?.replace(/\D/g, "") || null},email=${row.email || null},address=${tx.json(address)},remarks=case when ${notes} is null then remarks else ${notes} end,guest_status=${existing.guestStatus === "do_not_rent" ? "do_not_rent" : storedStatus(row.status ?? "New")},room_preferences=${tx.json(preferences as never)},updated_at=now() where id=${existing.guestId}::uuid and property_id=${session.propertyId}::uuid`;
            return { guestId: existing.guestId, merged: true };
          }
        }
        const [guest] = await tx<Array<{ id: string }>>`
          insert into guests (property_id,first_name,last_name,phone,email,address,remarks,guest_status,room_preferences)
          values (${session.propertyId}::uuid,${row.firstName},${row.lastName},${row.phone?.replace(/\D/g, "") || null},${row.email || null},${tx.json(address)},${row.notes || null},${storedStatus(row.status ?? "New")},${tx.json({ dateOfBirth: row.dateOfBirth, idExpires: row.idExpires })})
          returning id
        `;
        if (row.idType && row.idNumber?.trim()) {
          await tx`insert into guest_identities (property_id,guest_id,id_type,id_number,normalized_id_number,delete_after) values (${session.propertyId}::uuid,${guest.id}::uuid,${row.idType},${row.idNumber},${normalizedId(row.idNumber)},now()+interval '1 year') on conflict (property_id,id_type,normalized_id_number) do update set guest_id=excluded.guest_id,id_number=excluded.id_number,deleted_at=null,captured_at=now(),delete_after=excluded.delete_after`;
        }
        return { guestId: guest.id };
      });
      return Response.json(result, { status: result.merged ? 200 : 201 });
    }
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Guest import rows are invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    let merged = 0;
    await productionSql().begin(async (tx) => {
      for (const row of parsed.data.rows) {
        const idNumber = normalizedId(row.driverLicenseNumber);
        const [identity] = await tx<Array<{ guestId: string }>>`select guest_id as "guestId" from guest_identities where property_id=${session.propertyId}::uuid and id_type=${row.idType} and normalized_id_number=${idNumber} and deleted_at is null for update`;
        const address = { addressLine1: row.addressLine1 ?? "", city: row.city ?? "" };
        if (identity) { merged += 1; await tx`update guests set first_name=${row.firstName},last_name=${row.lastName},phone=${row.phone?.replace(/\D/g, "") || null},address=${tx.json(address)},remarks=coalesce(${row.notes || null},remarks),updated_at=now() where id=${identity.guestId}::uuid and property_id=${session.propertyId}::uuid`; }
        else {
          const [guest] = await tx<Array<{ id: string }>>`insert into guests (property_id,first_name,last_name,phone,address,remarks,guest_status) values (${session.propertyId}::uuid,${row.firstName},${row.lastName},${row.phone?.replace(/\D/g, "") || null},${tx.json(address)},${row.notes || null},'active') returning id`;
          await tx`insert into guest_identities (property_id,guest_id,id_type,id_number,normalized_id_number,delete_after) values (${session.propertyId}::uuid,${guest.id}::uuid,${row.idType},${row.driverLicenseNumber},${idNumber},now()+interval '1 year') on conflict (property_id,id_type,normalized_id_number) do update set guest_id=excluded.guest_id,id_number=excluded.id_number,deleted_at=null,captured_at=now(),delete_after=excluded.delete_after`;
        }
      }
    });
    return Response.json({ imported: parsed.data.rows.length, merged });
  } catch (error) { return propertyAccessResponse(error); }
}

/**
 * Delete a guest's data. A guest who never stayed is removed completely. A
 * guest with stays keeps an anonymous profile so folios, payments and the
 * ledger still add up: name becomes "Deleted Guest" and every personal
 * detail (contact, address, ID numbers and photos, vehicles, saved cards,
 * remarks) is erased.
 */
export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const guestId = new URL(request.url).searchParams.get("guestId") ?? "";
    if (!z.string().uuid().safeParse(guestId).success) return Response.json({ error: "Choose a guest." }, { status: 400 });
    const result = await productionSql().begin(async (tx) => {
      const [guest] = await tx<Array<{ id: string }>>`select id from guests where id=${guestId}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!guest) return null;
      const [{ stays }] = await tx<Array<{ stays: number }>>`
        select (
          (select count(*) from reservations where main_guest_id=${guestId}::uuid)
          + (select count(*) from reservation_guests where guest_id=${guestId}::uuid)
          + (select count(*) from registration_acceptances where signed_by_guest_id=${guestId}::uuid)
          + (select count(*) from dnr_overrides where guest_id=${guestId}::uuid)
        )::int as stays
      `;
      const photos = await tx<Array<{ key: string }>>`select storage_key as key from guest_identities where guest_id=${guestId}::uuid and property_id=${session.propertyId}::uuid and storage_key is not null`;
      for (const table of ["guest_identities", "guest_vehicles", "guest_payment_sources", "guest_remarks"] as const) {
        await tx.unsafe(`delete from ${table} where guest_id=$1 and property_id=$2`, [guestId, session.propertyId]);
      }
      if (stays === 0) {
        await tx`delete from guests where id=${guestId}::uuid and property_id=${session.propertyId}::uuid`;
        return { mode: "deleted" as const, photos: photos.map((photo) => photo.key) };
      }
      await tx`
        update guests set first_name='Deleted', last_name='Guest', phone=null, email=null, address='{}'::jsonb,
          remarks=null, dnr_reason=null, guest_status='active', room_preferences='{}'::jsonb, archived_at=now(), updated_at=now()
        where id=${guestId}::uuid and property_id=${session.propertyId}::uuid
      `;
      return { mode: "anonymized" as const, photos: photos.map((photo) => photo.key) };
    });
    if (!result) return Response.json({ error: "Guest not found." }, { status: 404 });
    // ID photos live in private storage; remove them once the rows are gone.
    if (result.photos.length) await deletePrivateFiles(result.photos).catch((error) => console.error("Guest ID photo delete failed", error));
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "guest", entityId: guestId, action: "deleted", entityVersion: 1, payload: { mode: result.mode } });
    return Response.json({ mode: result.mode });
  } catch (error) { return propertyAccessResponse(error); }
}
