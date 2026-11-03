/**
 * ID expiry and birth dates reach guest profiles from scans, typing and older
 * bookings, so they are not always YYYY-MM-DD. Reads YYYY-MM-DD (or the start
 * of an ISO timestamp), MM/DD/YYYY and MM-DD-YYYY; anything else is unknown.
 */
export function profileDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(text);
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1].padStart(2, "0"), us[2].padStart(2, "0")] : [];
  if (!year) return undefined;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? undefined : `${year}-${month}-${day}`;
}
