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
  /** A new booking that needs review, kept (without card details) so staff can add it to Arrivals. */
  booking?: EmailBooking;
};

const LOG_KEY = "email_booking_imports";
type Db = Sql | TransactionSql;

export async function readImportLog(db: Db, propertyId: string, lock = false): Promise<ImportEntry[]> {
  const rows = lock
    ? await db<Array<{ value: { entries?: ImportEntry[] } }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${LOG_KEY} for update`
    : await db<Array<{ value: { entries?: ImportEntry[] } }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${LOG_KEY}`;
  return Array.isArray(rows[0]?.value?.entries) ? rows[0].value.entries : [];
}

export async function writeImportLog(db: Db, propertyId: string, entries: ImportEntry[]) {
  // Every booking email ever received stays in the log (no limit).
  const value = { entries };
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

type Placed = { reservationId: string; confirmationNumber: string } | { reason: string };

/** The closest room type for a room name the motel has not matched: most words in common, non-smoking first. */
function closestRoomTypes<T extends { id: string; name: string; active?: boolean; smokingAllowed?: boolean }>(name: string | undefined, roomTypes: T[]) {
  const words = new Set(roomNameKey(name ?? "").split(" ").filter(Boolean));
  return roomTypes.filter((type) => type.active !== false)
    .map((type) => ({ type, score: roomNameKey(type.name).split(" ").filter((word) => words.has(word)).length * 2 - (type.smokingAllowed ? 1 : 0) }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.type);
}

/**
 * Create the reservation for a new booking: the motel's room type for the
 * online room category (or, when none matches, the closest one with a free
 * room, marked for staff to confirm before assigning a room or checking
 * in), the email's nightly prices, and its full price breakdown.
 */
async function placeBooking(tx: TransactionSql, motel: Motel, booking: EmailBooking, receivedAt?: string): Promise<Placed> {
  if (!booking.checkIn || !booking.checkout || booking.checkout <= booking.checkIn) return { reason: "The stay dates could not be read." };
  if (!booking.firstName) return { reason: "The guest's name could not be read." };
  if (!booking.nightlyRatesCents.length) return { reason: "The room price could not be read." };
  const [settingsRow] = await tx<Array<{ value: StoredSettings }>>`
    select case when jsonb_typeof(value)='object' then value else (value#>>'{}')::jsonb end as value
    from property_settings where property_id=${motel.propertyId}::uuid and key='application_settings'`;
  const settings = settingsRow?.value ?? {};
  const roomTypes = settings.roomTypes ?? [];
  const matched = matchRoomType(booking.roomTypeName, roomTypes, motel.settings.roomTypeMatches);
  // A name shared by smoking and non-smoking types is confirmed by staff too.
  const sameName = matched ? roomTypes.filter((type) => type.active !== false && roomNameKey(type.name) === roomNameKey(matched.name)).length : 0;
  const savedMatch = booking.roomTypeName ? Boolean(motel.settings.roomTypeMatches[roomNameKey(booking.roomTypeName)]) : false;
  const candidates = matched ? [matched, ...closestRoomTypes(booking.roomTypeName, roomTypes).filter((type) => type.id !== matched.id)] : closestRoomTypes(booking.roomTypeName, roomTypes);
  if (!candidates.length) return { reason: "This motel has no active room types." };
  const sources = await tx<Array<{ name: string; type: string }>>`select name,type from booking_sources where property_id=${motel.propertyId}::uuid and active=true`;
  const want = compact(booking.channel);
  const source = sources.find((item) => compact(item.name) === want)
    ?? sources.find((item) => want === "website" ? /website|web/.test(compact(item.name)) : compact(item.name).includes(want) || want.includes(compact(item.name)));
  if (!source) return { reason: `There is no active reservation source for ${booking.channel}. Add it in Settings › Reservation Sources, then click Add to Arrivals.` };
  const rateCodes = (settings.rateCodes ?? []).filter((rate) => rate.active !== false && !/rate (exception|exemption)/i.test(rate.name));
  const rateCode = (rateCodes.find((rate) => rate.isAvailabilityDefault) ?? rateCodes[0])?.name ?? "RACK";
  const taxPercentage = Math.max(0, settings.tax?.percentage ?? 0);
  const contact = booking.email?.toLowerCase() || booking.channelConfirmation || booking.confirmation;
  const actor = { authUserId: "email", propertyId: motel.propertyId, role: "owner" as const, active: true, systemName: `${booking.channel} email` };
  // Paid online when the email shows the stay already paid; otherwise the guest pays at the motel.
  const paidOnline = booking.paidCents !== undefined && booking.totalCents !== undefined && booking.paidCents > 0 && booking.paidCents >= booking.totalCents;
  for (const [index, roomType] of candidates.entries()) {
    const confirmed = index === 0 && Boolean(matched) && (savedMatch || sameName <= 1);
    try {
      // A savepoint: a refused booking leaves the log and notification to be written.
      const created = await tx.savepoint((inner) => createProductionReservationTransaction(inner, actor, {
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
        otaPaymentStatus: paidOnline ? "Paid Online" : "Guest Pays Hotel",
        ...(booking.commissionCents !== undefined ? { commissionCents: booking.commissionCents } : {}),
        source: source.name,
        online: {
          provider: booking.provider, channel: booking.channel, confirmation: booking.confirmation, channelConfirmation: booking.channelConfirmation,
          roomTypeName: booking.roomTypeName, roomTypeConfirmed: confirmed, rooms: booking.rooms, nightlyRatesCents: booking.nightlyRatesCents,
          subtotalCents: booking.subtotalCents, taxCents: booking.taxCents, totalCents: booking.totalCents, commissionCents: booking.commissionCents,
          netCents: booking.netCents, paidCents: booking.paidCents, receivedAt,
        },
      }, { alreadySold: true }));
      const [reservation] = await tx<Array<{ confirmationNumber: string }>>`select confirmation_number as "confirmationNumber" from reservations where id=${created.reservationId}::uuid`;
      const pmsTax = booking.nightlyRatesCents.reduce((sum, rate) => sum + calculateTaxCents(rate, taxPercentage / 100), 0) * booking.rooms;
      await logReservationActivity(tx, actor, created.reservationId, "Reservation",
        `Imported from the ${booking.provider} email · ${booking.channel} confirmation ${booking.channelConfirmation ?? booking.confirmation}${booking.roomTypeName ? ` · booked as "${booking.roomTypeName}"` : ""}${confirmed ? "" : ` · room type ${roomType.name} to confirm`}${booking.totalCents !== undefined ? ` · email total ${money(booking.totalCents)}` : ""}${booking.taxCents !== undefined && Math.abs(booking.taxCents - pmsTax) > booking.nightlyRatesCents.length * booking.rooms ? ` · email tax ${money(booking.taxCents)}, posted ${money(pmsTax)}` : ""}`);
      await notify(tx, motel.propertyId, `New ${booking.channel} booking`, `${booking.firstName} ${booking.lastName} · ${booking.rooms} × ${roomType.name}${confirmed ? "" : ` (booked as "${booking.roomTypeName ?? "room"}": confirm the room type)`} · ${booking.checkIn} → ${booking.checkout} · ${reservation.confirmationNumber}`, created.reservationId);
      return { reservationId: created.reservationId, confirmationNumber: reservation.confirmationNumber };
    } catch (error) {
      if (!(error instanceof ReservationRequestError)) throw error;
      // No free room of this type: try the next closest type.
      if (/inventory|available|rooms? of this type/i.test(error.message)) continue;
      return { reason: error.message };
    }
  }
  return { reason: `No ${booking.roomTypeName ?? "matching"} room is free for these dates: this booking may be an overbooking. Free a room or contact ${booking.channel}, then click Add to Arrivals.` };
}

/** Staff add a booking from Needs review to Arrivals (after freeing a room, adding a source, …). */
export async function addReviewedBooking(sql: Sql, propertyId: string, messageId: string): Promise<{ entries: ImportEntry[]; error?: string; reservationId?: string }> {
  return sql.begin(async (tx) => {
    const log = await readImportLog(tx, propertyId, true);
    const entry = log.find((item) => item.messageId === messageId && item.status === "review");
    if (!entry?.booking) return { entries: log, error: "This email has no booking details to add. Enter it with New Arrival." };
    const [row] = await tx<Array<{ value: { emailImport?: unknown } }>>`
      select case when jsonb_typeof(value)='object' then value else (value#>>'{}')::jsonb end as value from property_settings where property_id=${propertyId}::uuid and key='application_settings'`;
    const placed = await placeBooking(tx, { propertyId, settings: emailImportSettings(row?.value?.emailImport) }, entry.booking, entry.receivedAt);
    if ("reason" in placed) return { entries: log, error: placed.reason };
    const next = log.map((item) => item.messageId === messageId ? { ...item, status: "imported" as const, reason: undefined, booking: undefined, reservationId: placed.reservationId, confirmationNumber: placed.confirmationNumber } : item);
    await writeImportLog(tx, propertyId, next);
    return { entries: next, reservationId: placed.reservationId };
  }) as Promise<{ entries: ImportEntry[]; error?: string; reservationId?: string }>;
}

export type ImportResult = { status: "imported" | "duplicate" | "review" | "ignored"; message: string; reservationId?: string };

export async function importBookingEmail(sql: Sql, motel: Motel, email: { messageId: string; subject: string; text: string; receivedAt?: string }): Promise<ImportResult> {
  const booking = parseBookingEmail(email);
  return sql.begin(async (tx) => {
    // One import at a time per motel: the log row is the lock.
    await tx`insert into property_settings (property_id,key,value) values (${motel.propertyId}::uuid,${LOG_KEY},${tx.json({ entries: [] } as never)}) on conflict (property_id,key) do nothing`;
    const stored = await readImportLog(tx, motel.propertyId, true);
    const earlier = stored.find((entry) => entry.messageId === email.messageId);
    // An email whose format was not known yet is read again (the Gmail script
    // resends Needs review emails); any other email is only ever imported once.
    const unreadBefore = earlier?.status === "review" && !earlier.provider && !earlier.booking;
    if (earlier && !(unreadBefore && booking)) return { status: earlier.status === "review" ? "review" as const : "duplicate" as const, message: earlier.status === "review" ? earlier.reason ?? "Needs review." : "Already imported." };
    const log = unreadBefore ? stored.filter((entry) => entry !== earlier) : stored;
    const base = { messageId: email.messageId, receivedAt: email.receivedAt, processedAt: new Date().toISOString() };
    const review = async (reason: string, found?: EmailBooking, reservationId?: string): Promise<ImportResult> => {
      await writeImportLog(tx, motel.propertyId, [{ ...base, ...(found ? { ...summary(found), booking: found.kind === "new" ? found : undefined } : { guest: email.subject.slice(0, 120) }), status: "review", reason, reservationId }, ...log]);
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
    const placed = await placeBooking(tx, motel, booking, email.receivedAt);
    if ("reason" in placed) return review(placed.reason, booking);
    await writeImportLog(tx, motel.propertyId, [{ ...base, ...summary(booking), status: "imported", reservationId: placed.reservationId, confirmationNumber: placed.confirmationNumber }, ...log]);
    return { status: "imported", message: `Imported as ${placed.confirmationNumber}.`, reservationId: placed.reservationId };
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
