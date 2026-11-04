import type { Sql, TransactionSql } from "postgres";

import { calculateTaxCents } from "@/domain/rules/tax";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";
import { recordChange } from "@/server/realtime/change-events";
import { createProductionReservationTransaction, ReservationRequestError } from "@/app/api/reservations/route";
import { matchRoomType, parseBookingEmail, roomNameKey, type EmailBooking } from "./parse-booking-email";

/**
 * Booking emails a motel's Gmail sends in (Settings › Online Bookings ›
 * Booking emails). Each email becomes a reservation in Arrivals, or an entry
 * in Needs review when it cannot be placed safely: an unknown format, a room
 * type or source the PMS does not have, no free room (an overbooking), or a
 * cancellation or change to apply by hand. Every email is logged once, by
 * its Gmail message id, so sending it again never makes a second booking.
 * The email text itself is never stored.
 */

export type EmailImportSettings = { enabled: boolean; key: string; roomTypeMatches: Record<string, string> };

export function emailImportSettings(value: unknown): EmailImportSettings {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const matches = stored.roomTypeMatches && typeof stored.roomTypeMatches === "object" && !Array.isArray(stored.roomTypeMatches) ? stored.roomTypeMatches as Record<string, unknown> : {};
  return {
    enabled: stored.enabled === true,
    key: typeof stored.key === "string" ? stored.key : "",
    roomTypeMatches: Object.fromEntries(Object.entries(matches).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

export type ImportEntry = {
  messageId: string;
  receivedAt?: string;
  processedAt: string;
  status: "imported" | "review" | "resolved";
  reason?: string;
  provider?: string;
  channel?: string;
  kind?: string;
  confirmation?: string;
  channelConfirmation?: string;
  guest?: string;
  checkIn?: string;
  checkout?: string;
  roomTypeName?: string;
  rooms?: number;
  totalCents?: number;
  reservationId?: string;
  confirmationNumber?: string;
};

const LOG_KEY = "email_booking_imports";
const LOG_LIMIT = 300;
type Db = Sql | TransactionSql;

export async function readImportLog(db: Db, propertyId: string, lock = false): Promise<ImportEntry[]> {
  const rows = lock
    ? await db<Array<{ value: { entries?: ImportEntry[] } }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${LOG_KEY} for update`
    : await db<Array<{ value: { entries?: ImportEntry[] } }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${LOG_KEY}`;
  return Array.isArray(rows[0]?.value?.entries) ? rows[0].value.entries : [];
}

export async function writeImportLog(db: Db, propertyId: string, entries: ImportEntry[]) {
  const value = { entries: entries.slice(0, LOG_LIMIT) };
  await db`insert into property_settings (property_id,key,value) values (${propertyId}::uuid,${LOG_KEY},${db.json(value as never)})
    on conflict (property_id,key) do update set value=excluded.value,updated_at=now()`;
}

type Motel = { propertyId: string; settings: EmailImportSettings };
type StoredSettings = {
  roomTypes?: Array<{ id: string; name: string; active?: boolean; smokingAllowed?: boolean }>;
  rateCodes?: Array<{ name: string; active?: boolean; isAvailabilityDefault?: boolean }>;
  tax?: { percentage?: number };
};

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const summary = (booking: EmailBooking): Partial<ImportEntry> => ({
  provider: booking.provider, channel: booking.channel, kind: booking.kind, confirmation: booking.confirmation,
  channelConfirmation: booking.channelConfirmation, guest: `${booking.firstName} ${booking.lastName}`.trim(),
  checkIn: booking.checkIn, checkout: booking.checkout, roomTypeName: booking.roomTypeName, rooms: booking.rooms, totalCents: booking.totalCents,
});

async function notify(tx: TransactionSql, propertyId: string, title: string, message: string, reservationId?: string) {
  await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
    values (${propertyId}::uuid,null,'EMAIL_BOOKING',${title},${message},${reservationId ? "reservation" : null},${reservationId ?? null}::uuid)`;
}

export type ImportResult = { status: "imported" | "duplicate" | "review" | "ignored"; message: string; reservationId?: string };

export async function importBookingEmail(sql: Sql, motel: Motel, email: { messageId: string; subject: string; text: string; receivedAt?: string }): Promise<ImportResult> {
  const booking = parseBookingEmail(email);
  return sql.begin(async (tx) => {
    // One import at a time per motel: the log row is the lock.
    await tx`insert into property_settings (property_id,key,value) values (${motel.propertyId}::uuid,${LOG_KEY},${tx.json({ entries: [] } as never)}) on conflict (property_id,key) do nothing`;
    const log = await readImportLog(tx, motel.propertyId, true);
    if (log.some((entry) => entry.messageId === email.messageId)) return { status: "duplicate" as const, message: "Already imported." };
    const base = { messageId: email.messageId, receivedAt: email.receivedAt, processedAt: new Date().toISOString() };
    const review = async (reason: string, found?: EmailBooking, reservationId?: string): Promise<ImportResult> => {
      await writeImportLog(tx, motel.propertyId, [{ ...base, ...(found ? summary(found) : { guest: email.subject.slice(0, 120) }), status: "review", reason, reservationId }, ...log]);
      await notify(tx, motel.propertyId, "Booking email needs review", `${found ? `${found.channel} · ${found.firstName} ${found.lastName} · ${found.checkIn ?? "?"} → ${found.checkout ?? "?"}: ` : ""}${reason}`, reservationId);
      return { status: "review", message: reason, reservationId };
    };
    if (!booking) return review("This email's format is not known yet. Enter the booking by hand, and send a copy of the email to InnSeva support so it can be read next time.");

    const original = log.find((entry) => entry.confirmation === booking.confirmation && entry.reservationId);
    if (booking.kind !== "new") {
      const what = booking.kind === "cancelled" ? "cancelled" : "changed";
      return review(original
        ? `${booking.channel} ${what} booking ${booking.channelConfirmation ?? booking.confirmation}. Open reservation ${original.confirmationNumber ?? ""} and ${booking.kind === "cancelled" ? "cancel it" : "update the stay"}.`.replace("  ", " ")
        : `${booking.channel} ${what} booking ${booking.channelConfirmation ?? booking.confirmation}, which was not imported here. Find it in Reservations and ${booking.kind === "cancelled" ? "cancel it" : "update it"}.`, booking, original?.reservationId);
    }
    if (original || log.some((entry) => entry.confirmation === booking.confirmation && entry.status !== "review")) {
      await writeImportLog(tx, motel.propertyId, [{ ...base, ...summary(booking), status: "resolved", reason: "Another copy of an imported booking email." }, ...log]);
      return { status: "duplicate", message: "This booking was already imported." };
    }
    if (!booking.checkIn || !booking.checkout || booking.checkout <= booking.checkIn) return review("The stay dates could not be read.", booking);
    if (!booking.firstName) return review("The guest's name could not be read.", booking);
    if (!booking.nightlyRatesCents.length) return review("The room price could not be read.", booking);

    const [settingsRow] = await tx<Array<{ value: StoredSettings }>>`
      select case when jsonb_typeof(value)='object' then value else (value#>>'{}')::jsonb end as value
      from property_settings where property_id=${motel.propertyId}::uuid and key='application_settings'`;
    const settings = settingsRow?.value ?? {};
    const roomType = matchRoomType(booking.roomTypeName, settings.roomTypes ?? [], motel.settings.roomTypeMatches);
    if (!roomType) return review(`Room type "${booking.roomTypeName ?? "not shown"}" is not matched to a room type here. Match it in Settings › Online Bookings, then enter this booking.`, booking);
    const sources = await tx<Array<{ name: string }>>`select name from booking_sources where property_id=${motel.propertyId}::uuid and active=true`;
    const want = compact(booking.channel);
    const source = sources.find((item) => compact(item.name) === want)
      ?? sources.find((item) => want === "website" ? /website|web/.test(compact(item.name)) : compact(item.name).includes(want) || want.includes(compact(item.name)));
    if (!source) return review(`There is no active reservation source for ${booking.channel}. Add it in Settings › Reservation Sources.`, booking);
    const rateCodes = (settings.rateCodes ?? []).filter((rate) => rate.active !== false && !/rate (exception|exemption)/i.test(rate.name));
    const rateCode = (rateCodes.find((rate) => rate.isAvailabilityDefault) ?? rateCodes[0])?.name ?? "RACK";
    const taxPercentage = Math.max(0, settings.tax?.percentage ?? 0);
    const contact = booking.email?.toLowerCase() || booking.channelConfirmation || booking.confirmation;
    const actor = { authUserId: "email", propertyId: motel.propertyId, role: "owner" as const, active: true, systemName: `${booking.channel} email` };
    let created: Awaited<ReturnType<typeof createProductionReservationTransaction>>;
    try {
      // A savepoint: a refused booking leaves the log and notification to be written.
      created = await tx.savepoint((inner) => createProductionReservationTransaction(inner, actor, {
        idType: "Other",
        idNumber: `${booking.email ? "WEB" : compact(booking.channel).toUpperCase()}-${contact}`,
        firstName: booking.firstName,
        lastName: booking.lastName || "-",
        dateOfBirth: "",
        idExpires: "",
        countryCode: "+1",
        phone: booking.phone ?? "",
        email: booking.email ?? "",
        addressLine1: booking.address,
        roomTypeId: roomType.id,
        roomCount: booking.rooms,
        roomNumbers: [],
        additionalRooms: [],
        checkInDate: booking.checkIn!,
        checkoutDate: booking.checkout!,
        adults: booking.adults,
        children: booking.children,
        petCount: 0,
        servicePetCount: 0,
        rateCode,
        baseNightlyRatesCents: booking.nightlyRatesCents,
        nightlyRatesCents: booking.nightlyRatesCents,
        promotionIds: [],
        taxRatePercentage: taxPercentage,
        taxExempt: false,
        ...(booking.commissionCents !== undefined ? { commissionCents: booking.commissionCents } : {}),
        source: source.name,
      }, { alreadySold: true }));
    } catch (error) {
      if (error instanceof ReservationRequestError) {
        const full = /inventory|available|rooms? of this type/i.test(error.message);
        return review(full ? `No ${roomType.name} room is free for these dates: this booking may be an overbooking. Move a stay or contact ${booking.channel}, then enter it by hand.` : error.message, booking);
      }
      throw error;
    }
    const [reservation] = await tx<Array<{ confirmationNumber: string }>>`select confirmation_number as "confirmationNumber" from reservations where id=${created.reservationId}::uuid`;
    const emailTax = booking.taxCents;
    const pmsTax = booking.nightlyRatesCents.reduce((sum, rate) => sum + calculateTaxCents(rate, taxPercentage / 100), 0) * booking.rooms;
    await logReservationActivity(tx, actor, created.reservationId, "Reservation",
      `Imported from the ${booking.provider} email · ${booking.channel} confirmation ${booking.channelConfirmation ?? booking.confirmation}${booking.totalCents !== undefined ? ` · email total ${money(booking.totalCents)}` : ""}${emailTax !== undefined && Math.abs(emailTax - pmsTax) > booking.nightlyRatesCents.length * booking.rooms ? ` · email tax ${money(emailTax)}, posted ${money(pmsTax)}` : ""}`);
    await writeImportLog(tx, motel.propertyId, [{ ...base, ...summary(booking), status: "imported", reservationId: created.reservationId, confirmationNumber: reservation.confirmationNumber }, ...log]);
    await notify(tx, motel.propertyId, `New ${booking.channel} booking`, `${booking.firstName} ${booking.lastName} · ${booking.rooms} × ${roomType.name} · ${booking.checkIn} → ${booking.checkout} · ${reservation.confirmationNumber}`, created.reservationId);
    return { status: "imported", message: `Imported as ${reservation.confirmationNumber}.`, reservationId: created.reservationId };
  }) as Promise<ImportResult>;
}

/**
 * Open PMS screens refresh (Arrivals and its review list) as they do for a
 * booking made at the desk. The event is recorded as the motel owner's, the
 * account that installed the import. A delivery failure never undoes an import.
 */
export async function announceImport(sql: Sql, propertyId: string, result: ImportResult) {
  if (result.status !== "imported" && result.status !== "review") return;
  const [owner] = await sql<Array<{ authUserId: string }>>`
    select auth_user_id as "authUserId" from property_memberships where property_id=${propertyId}::uuid and active=true order by (role='owner') desc, created_at limit 1
  `.catch(() => []);
  if (!owner) return;
  await recordChange({ propertyId, actorAuthUserId: owner.authUserId, entityType: result.reservationId ? "reservation" : "email_import", entityId: result.reservationId ?? crypto.randomUUID(), action: result.status === "imported" ? "created" : "updated", entityVersion: Date.now(), payload: {} }).catch(() => undefined);
}

/** The motel's key from the Gmail script. Only the motel's own settings hold it. */
export async function motelForImportKey(sql: Sql, key: string | null): Promise<Motel | null> {
  if (!key || key.length < 24 || key.length > 80) return null;
  const [row] = await sql<Array<{ propertyId: string; value: { emailImport?: unknown } }>>`
    select ps.property_id as "propertyId", case when jsonb_typeof(ps.value)='object' then ps.value else (ps.value#>>'{}')::jsonb end as value
    from property_settings ps join properties p on p.id=ps.property_id
    where ps.key='application_settings' and p.status <> 'deleted'
      and (case when jsonb_typeof(ps.value)='object' then ps.value else (ps.value#>>'{}')::jsonb end)->'emailImport'->>'key' = ${key}
    limit 1`;
  if (!row) return null;
  const settings = emailImportSettings(row.value?.emailImport);
  return settings.enabled && settings.key === key ? { propertyId: row.propertyId, settings } : null;
}

export { roomNameKey };
