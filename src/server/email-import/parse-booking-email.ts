/**
 * Reservation emails a motel receives, read into one booking shape so the
 * PMS can create (or flag) the reservation. Each booking engine words its
 * email differently; each has a reader below. The text is Gmail's plain-text
 * version of the email, so a label and its value may be on one line or on
 * consecutive lines.
 *
 * - SellVEL (Cyberwebhotels): the motel website's booking form.
 * - Stayflexi: Booking.com, Expedia and other OTA bookings through the
 *   Stayflexi channel manager.
 *
 * Card numbers are removed before anything is read (removeCardDetails).
 */

export type EmailBookingKind = "new" | "modified" | "cancelled";

export type EmailBooking = {
  provider: "SellVEL" | "Stayflexi" | "Expedia";
  kind: EmailBookingKind;
  /** Where the guest booked: "Website", "Booking.com", "Expedia", … */
  channel: string;
  /** The booking engine's or OTA's confirmation number. */
  confirmation: string;
  /** A second reference (the OTA's own number) when the email has one. */
  channelConfirmation?: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  address?: string;
  /** YYYY-MM-DD */
  checkIn?: string;
  checkout?: string;
  adults: number;
  children: number;
  rooms: number;
  roomTypeName?: string;
  /** One price per night for one room, before tax. */
  nightlyRatesCents: number[];
  /** Room rent for the whole stay (all rooms) before tax, as the email states it. */
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
  commissionCents?: number;
  /** What the OTA pays the motel after commission. */
  netCents?: number;
  /** Already paid online. */
  paidCents?: number;
};

/** Card numbers, expiry and security codes never get past this point. */
export function removeCardDetails(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/(card\s*(number|no\b|expir|exp\b|holder|type)|name\s+on\s+card|cvv|cvc|security\s+code)/i.test(line))
    .join("\n")
    // Any 13–19 digit run (with spaces or dashes) that slipped through.
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, "[card removed]");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (value: number) => String(value).padStart(2, "0");

function isoDate(year: number, month: number, day: number) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "11/3/2026" (US month first). */
const usDate = (value?: string) => {
  const match = value && /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  return match ? isoDate(Number(match[3]), Number(match[1]), Number(match[2])) : undefined;
};

/** "Oct 24, 2026" or "24 Oct 2026". */
const namedDate = (value?: string) => {
  if (!value) return undefined;
  let match = /([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(value);
  if (match && MONTHS.includes(match[1].toLowerCase())) return isoDate(Number(match[3]), MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2]));
  match = /(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/.exec(value);
  if (match && MONTHS.includes(match[2].toLowerCase())) return isoDate(Number(match[3]), MONTHS.indexOf(match[2].toLowerCase()) + 1, Number(match[1]));
  return undefined;
};

const cents = (value?: string) => value === undefined ? undefined : Math.round(Number(value.replace(/,/g, "")) * 100);
/** The first amount after a label (same line or the next): "69.30 USD", "USD 69.30" or "$69.30". */
const amountAfter = (text: string, label: string) => cents(new RegExp(`${label}[^\\n\\d]*?\\n?[^\\n\\d]*?(?:USD|\\$)?\\s*([\\d,]+\\.\\d{1,2})`, "i").exec(text)?.[1]);
/** The value after a label, on the same line or the next. */
const after = (text: string, label: string, value = String.raw`([^\n]+)`) =>
  new RegExp(`${label}\\s*:?[ \\t]*\\n?[ \\t]*${value}`, "i").exec(text)?.[1]?.trim();

const nightsBetween = (checkIn: string, checkout: string) => Math.round((Date.parse(`${checkout}T12:00:00Z`) - Date.parse(`${checkIn}T12:00:00Z`)) / 86_400_000);

/** A total spread over the nights; the last night takes the leftover cent. */
function spread(totalCents: number, nights: number) {
  const each = Math.floor(totalCents / nights);
  return Array.from({ length: nights }, (_, index) => index === nights - 1 ? totalCents - each * (nights - 1) : each);
}

function splitName(full: string) {
  const words = full.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const proper = (word: string) => word === word.toUpperCase() || word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word;
  const fixed = words.map(proper);
  return { firstName: fixed.slice(0, -1).join(" ") || fixed[0] || "", lastName: fixed.length > 1 ? fixed[fixed.length - 1] : "" };
}

/** "BOOKING.COM" -> "Booking.com", "EXPEDIA AFFILIATE NETWORK" -> "Expedia". */
export function channelName(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z]/g, "");
  if (compact.includes("bookingcom")) return "Booking.com";
  if (compact.includes("expedia") || compact.includes("hotelscom") || compact.includes("vrbo")) return "Expedia";
  if (compact.includes("airbnb")) return "Airbnb";
  if (compact.includes("agoda")) return "Agoda";
  if (compact.includes("trip")) return "Trip.com";
  if (compact.includes("hostelworld")) return "Hostelworld";
  return value.trim().replace(/\s+/g, " ");
}

const kindOf = (text: string): EmailBookingKind => /cancel/i.test(text) ? "cancelled" : /modif|amend|chang|updat/i.test(text) ? "modified" : "new";

/** Lines that are labels or headings in a SellVEL email, never a room type. */
const SELLVEL_LABEL = /:|^(date|price per night|booking summary|guest details|payment method|cancellation policy|additional note|subtotal|tax|total|new reservation|mobile secured|confirmation)\b/i;
const ROOM_WORDS = /\b(king|queen|double|twin|single|suite|bed|beds|studio|deluxe|standard|kitchenette|efficiency)\b/i;

function readSellvel(text: string, subject: string): EmailBooking | null {
  if (!/sellvel|cyberwebhotels/i.test(`${subject}\n${text}`)) return null;
  const confirmation = after(text, String.raw`Confirmation\s*#`, String.raw`([A-Z0-9-]+)`);
  if (!confirmation) return null;
  const heading = /^[^\n]*(reservation|booking)[^\n]*$/im.exec(text)?.[0] ?? "";
  const checkIn = usDate(after(text, String.raw`Check-?\s?in\s+Date`));
  const checkout = usDate(after(text, String.raw`Check-?\s?out\s+Date`));
  const rooms = Number(after(text, String.raw`No\.?\s*of\s*Rooms`, String.raw`(\d+)`)) || 1;
  const lines = text.split("\n").map((line) => line.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // The room type is the line above the nightly price table ("Date"), or
  // else a room-like line ("… King Bed") that is not a label.
  const tableAt = lines.findIndex((line) => /^date\b/i.test(line) && !line.includes(":"));
  const aboveTable = tableAt > 0 && !SELLVEL_LABEL.test(lines[tableAt - 1]) ? lines[tableAt - 1] : undefined;
  const roomLike = lines.find((line) => ROOM_WORDS.test(line) && !SELLVEL_LABEL.test(line) && line.length <= 60 && !/\d+\.\d{2}/.test(line));
  const roomTypeName = aboveTable ?? roomLike;
  const nights = checkIn && checkout ? nightsBetween(checkIn, checkout) : 0;
  // Nightly prices: amounts between "Price Per Night" and "Subtotal".
  const table = /Price\s+Per\s+Night([\s\S]*?)Subtotal/i.exec(text)?.[1] ?? "";
  const listed = [...table.matchAll(/([\d,]+\.\d{2})/g)].map((match) => cents(match[1])!);
  const subtotal = amountAfter(text, String.raw`Subtotal[^\n]*?Room\/?s?`) ?? amountAfter(text, "Subtotal");
  const nightlyRatesCents = nights > 0 && listed.length === nights ? listed
    : nights > 0 && subtotal !== undefined ? spread(Math.round(subtotal / rooms), nights) : [];
  const name = splitName(after(text, String.raw`(?:^|\n)[ \t]*(?:Guest\s+)?Name(?!\s+on)`) ?? "");
  return {
    provider: "SellVEL",
    kind: kindOf(`${subject}\n${heading}`),
    channel: "Website",
    confirmation,
    ...name,
    email: after(text, String.raw`(?:^|\n)[ \t]*E-?mail`, String.raw`([^\s@]+@[^\s]+)`),
    phone: after(text, String.raw`(?:^|\n)[ \t]*Phone`, String.raw`([+\d][\d ().-]{6,})`)?.trim(),
    address: after(text, String.raw`Addr(?:ess)?\.?`),
    checkIn,
    checkout,
    adults: Number(after(text, String.raw`Adults?\s+per\s+Room`, String.raw`(\d+)`)) || 1,
    children: Number(after(text, String.raw`(?:^|\n)[ \t]*Children`, String.raw`(\d+)`)) || 0,
    rooms,
    roomTypeName: roomTypeName || undefined,
    nightlyRatesCents,
    subtotalCents: subtotal,
    taxCents: amountAfter(text, String.raw`(?:^|\n)[ \t]*Tax\b(?:\s*\([^)\n]*\))?`),
    totalCents: amountAfter(text, String.raw`(?:^|\n)[ \t]*Total\b`),
  };
}

function readStayflexi(text: string, subject: string): EmailBooking | null {
  const all = `${subject}\n${text}`;
  const confirmation = /(SFBOOKING_\d+_\d+)/i.exec(all)?.[1];
  if (!confirmation) return null;
  // "New BOOKING.COM booking from Oct 24, 2026 15:00 PM to Oct 25, 2026 11:00 AM (Itinerary #SFBOOKING_…)"
  const channelText = /(?:^|\n)\s*(?:New|Modified|Cancell?ed|Updated|Amended)?\s*([A-Z0-9][A-Z0-9 .&-]*?)\s+booking\b/i.exec(subject)?.[1]
    ?? /(?:New|Modified|Cancell?ed)\s+([A-Z0-9][A-Z0-9 .&-]*?)\s+booking/i.exec(text)?.[1] ?? "";
  const range = /from\s+([A-Za-z]{3,9}\.? \d{1,2},? \d{4})[\s\S]*?\bto\s+([A-Za-z]{3,9}\.? \d{1,2},? \d{4})/i.exec(all);
  const checkIn = namedDate(range?.[1]);
  const checkout = namedDate(range?.[2]);
  const guest = /booking\s+(?:confirmed|cancell?ed|modified)?\s*for\s+([^,\n]+),/i.exec(text)?.[1]
    ?? after(text, String.raw`Customer\s+details\s*\n?[ \t]*Name`);
  const roomLines = [...text.matchAll(/(?:^|\n)[ \t]*Room\s*:\s*([^,\n]+)/gi)].map((match) => match[1].trim());
  const plan = /Rate\s+plan\s*:[^\n]*?(\d+)\s*Adult\(?s?\)?,?\s*(\d+)\s*Child/i.exec(text);
  const nights = checkIn && checkout ? nightsBetween(checkIn, checkout) : 0;
  const subtotal = amountAfter(text, String.raw`Subtotal\s*\(ex\.?\s*tax\)`) ?? amountAfter(text, String.raw`Booking\s+Price`);
  const rooms = Math.max(1, roomLines.length);
  const channel = channelName(channelText || "OTA");
  const channelConfirmation = new RegExp(`${channelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+Confirmation\\s+code\\s*:?\\s*\\n?\\s*([A-Z0-9-]+)`, "i").exec(text)?.[1];
  return {
    provider: "Stayflexi",
    kind: kindOf(subject.split(/\bbooking\b/i)[0] + (/^[^\n]*cancel/im.test(text.slice(0, 300)) ? " cancel" : "")),
    channel,
    confirmation,
    channelConfirmation: channelText ? channelConfirmation : undefined,
    ...splitName(guest ?? ""),
    checkIn,
    checkout,
    adults: Number(plan?.[1]) || 1,
    children: Number(plan?.[2]) || 0,
    rooms,
    roomTypeName: roomLines[0],
    nightlyRatesCents: nights > 0 && subtotal !== undefined ? spread(Math.round(subtotal / rooms), nights) : [],
    subtotalCents: subtotal,
    taxCents: amountAfter(text, String.raw`Hotel\s+Taxes`),
    totalCents: amountAfter(text, String.raw`Total\s+charges`),
    commissionCents: amountAfter(text, String.raw`OTA\s+commission`),
    netCents: amountAfter(text, String.raw`Net\s+amount`),
    paidCents: amountAfter(text, String.raw`Total\s+payments`),
  };
}

/**
 * Expedia Partner Central's own email (booknotif@expedia.com), sent when the
 * motel is connected to Expedia directly rather than through a channel
 * manager: "Expedia - New Booking - Arriving on 9 Nov 2026". The stay table
 * (Check-In, Check-Out, Adults, Kids/Ages, Room Nights) may come label by
 * label or as a header row followed by a value row.
 */
const DATE_TEXT = String.raw`[A-Za-z]{3,9}\.? \d{1,2},? \d{4}`;

function readExpedia(text: string, subject: string): EmailBooking | null {
  if (!/expedia|hotels\.com|vrbo/i.test(`${subject}\n${text.slice(0, 600)}`) || !/Reservation\s+ID\s*:/i.test(text)) return null;
  const confirmation = after(text, String.raw`Reservation\s+ID`, String.raw`(\d{6,})`);
  if (!confirmation) return null;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  // The stay table: label by label ("Check-In: Nov 9, 2026") or a header row then a values row.
  const headerAt = lines.findIndex((line) => /^Check-?\s?In\b/i.test(line));
  const table = headerAt >= 0 ? lines.slice(headerAt, headerAt + 24).join("\n") : "";
  const dates = [...table.matchAll(new RegExp(`(${DATE_TEXT})`, "g"))].map((match) => namedDate(match[1])).filter((value): value is string => Boolean(value));
  const checkIn = dates[0];
  const checkout = dates[1];
  // Numbers in the table after the check-out date: adults, kids, room nights.
  const lastDate = [...table.matchAll(new RegExp(DATE_TEXT, "g"))][1];
  const counts = lastDate ? [...table.slice((lastDate.index ?? 0) + lastDate[0].length).matchAll(/(?:^|[\s:])(\d{1,2})(?=\s|$)/g)].map((match) => Number(match[1])) : [];
  const labelled = (label: string) => {
    const value = new RegExp(`${label}\\s*:\\s*(\\d{1,2})\\b`, "i").exec(text)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const adults = labelled("Adults") ?? counts[0] ?? 1;
  const children = labelled(String.raw`Kids(?:\s*\/\s*Ages)?`) ?? counts[1] ?? 0;
  const nights = checkIn && checkout ? nightsBetween(checkIn, checkout) : 0;

  // "Standard Room, 1 King Bed - Standard Rate": the room, without the rate plan.
  const roomTypeName = after(text, String.raw`Room\s+Type\s+Name`)?.replace(/\s+-\s+[^-]*\brate\b[^-]*$/i, "").trim();
  // Nightly prices sit between "Daily Rate" and the extra charges and taxes.
  const rateBlock = /Daily\s+Rate([\s\S]*?)(?:Extra\s+Person|Taxes|Extra\s+Charges|Total\s*:)/i.exec(text)?.[1] ?? "";
  const listed = [...rateBlock.replace(/Rate\s+Code[^\n]*/gi, "").matchAll(/([\d,]+\.\d{2})/g)].map((match) => cents(match[1])!);
  const taxCents = amountAfter(text, String.raw`(?:^|\n)[ \t]*Taxes?\s*:`);
  const totalCents = amountAfter(text, String.raw`(?:^|\n)[ \t]*Total\s*:`);
  const extraCents = (amountAfter(text, String.raw`Extra\s+Person\s*:`) ?? 0) + (amountAfter(text, String.raw`Extra\s+Charges\s*:`) ?? 0);
  const listedSum = listed.reduce((sum, value) => sum + value, 0);
  const subtotalCents = totalCents !== undefined ? totalCents - (taxCents ?? 0) : listedSum || undefined;
  const nightlyRatesCents = nights <= 0 ? []
    : listed.length === nights && extraCents === 0 ? listed
    : listed.length === 1 && extraCents === 0 && (subtotalCents === undefined || subtotalCents === listed[0] * nights) ? Array<number>(nights).fill(listed[0])
    : subtotalCents !== undefined ? spread(subtotalCents, nights) : [];

  // "Hotel Collects Payment from Guest" (pays at the desk) or "Expedia Collects Payment" (prepaid; Expedia pays the motel).
  const expediaCollects = /Expedia\s+Collects/i.test(text) && !/Hotel\s+Collects/i.test(text);
  const heading = /(?:^|\n)\s*((?:New|Modified|Cancell?ed|Changed)\s+Reservation)/i.exec(text)?.[1] ?? "";
  // "Guest: Spencer Lowell" with the phone on the same line or the next one.
  const guestAt = lines.findIndex((line) => /^Guest\s*:/i.test(line));
  const guestLine = guestAt >= 0 ? lines[guestAt].replace(/^Guest\s*:\s*/i, "") : "";
  const phonePattern = /([+(]?\d[\d ()-]{8,}\d)/;
  const phone = phonePattern.exec(guestLine)?.[1] ?? (guestAt >= 0 ? phonePattern.exec(/^[+(]?\d/.test(lines[guestAt + 1] ?? "") ? lines[guestAt + 1] : "")?.[1] : undefined);
  const name = guestLine.replace(/Booked\s+on.*$/i, "").replace(phonePattern, "").trim();
  const brand = /hotels\.com/i.test(subject) ? "Hotels.com" : /vrbo/i.test(subject) ? "Vrbo" : "Expedia";
  return {
    provider: "Expedia",
    // "NO GUEST NAME CHANGES ALLOWED" in the special request is not a modification.
    kind: kindOf(`${subject}\n${heading}`),
    channel: channelName(brand),
    confirmation,
    channelConfirmation: confirmation,
    ...splitName(name),
    email: after(text, String.raw`Guest\s+Email`, String.raw`([^\s@]+@[^\s]+)`),
    phone: phone?.replace(/\s+/g, " ").trim(),
    checkIn,
    checkout,
    adults: Math.max(1, adults),
    children,
    rooms: 1,
    roomTypeName: roomTypeName || undefined,
    nightlyRatesCents,
    subtotalCents,
    taxCents,
    totalCents,
    paidCents: expediaCollects ? totalCents : undefined,
  };
}

/** The booking in an email, or null when no reader knows its format. */
export function parseBookingEmail(input: { subject: string; text: string }): EmailBooking | null {
  // Gmail's plain text adds blank lines between table rows and *stars* around bold text.
  const text = removeCardDetails(input.text.replace(/\r/g, "").replace(/\*/g, "").replace(/\n[ \t]*(?=\n)/g, "").replace(/ /g, " ").replace(/[ \t]+/g, " "));
  const subject = input.subject.replace(/\s+/g, " ").trim();
  return readSellvel(text, subject) ?? readStayflexi(text, subject) ?? readExpedia(text, subject);
}

/**
 * The PMS room type for a room name in an email: the motel's own match from
 * Settings first, then the same words ("Standard One King Bed" =
 * "Standard 1 King"). Non-smoking is preferred when both variants share a name.
 */
export function matchRoomType<T extends { id: string; name: string; active?: boolean; smokingAllowed?: boolean }>(name: string | undefined, roomTypes: T[], saved: Record<string, string> = {}) {
  if (!name) return undefined;
  const key = roomNameKey(name);
  const active = roomTypes.filter((type) => type.active !== false);
  const savedId = saved[key];
  if (savedId) return active.find((type) => type.id === savedId);
  const same = active.filter((type) => roomNameKey(type.name) === key);
  return same.find((type) => !type.smokingAllowed) ?? same[0];
}

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", single: "1" };

/** "Standard One King Bed" and "Standard 1 King" -> "standard 1 king". */
export function roomNameKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((word) => word && !["bed", "beds", "room", "rooms", "the", "with"].includes(word))
    .map((word) => NUMBER_WORDS[word] ?? word.replace(/s$/, ""))
    .join(" ");
}
