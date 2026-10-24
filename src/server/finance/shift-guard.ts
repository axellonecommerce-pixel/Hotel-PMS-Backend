import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql<Record<string, never>>;

/** Raised when money is taken without an open shift (HotelKey requires one). */
export class ShiftRequiredError extends Error {
  constructor(action = "collect payments") {
    super(`Start a shift before you ${action}. Open Shift & Cash Drop and count the drawer.`);
  }
}

/**
 * Like HotelKey, every payment, refund, deposit, and paid out belongs to an
 * open clerk shift so the drawer can be reconciled at End Shift.
 */
export async function requireOpenShift(db: Db, propertyId: string, action?: string) {
  const [shift] = await db<Array<{ id: string }>>`
    select id from cash_shifts where property_id=${propertyId}::uuid and status like 'open:%' limit 1
  `;
  if (!shift) throw new ShiftRequiredError(action);
  return shift.id;
}
