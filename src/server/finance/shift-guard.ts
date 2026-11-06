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

/** Cash taken in and paid out between two instants. */
export async function cashActivityBetween(db: Db, propertyId: string, from: string, to: string | null) {
  const [row] = await db<Array<{ paymentCents: number; refundCents: number; depositCents: number; paidOutCents: number }>>`
    select
      coalesce((select sum(p.amount_cents) from payments p where p.property_id=${propertyId}::uuid and lower(p.method) like '%cash%'
        and p.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or p.created_at < ${to}::timestamptz)),0)::int as "paymentCents",
      coalesce((select sum(r.amount_cents) from refunds r join payments p on p.id=r.payment_id where r.property_id=${propertyId}::uuid and lower(p.method) like '%cash%'
        and r.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or r.created_at < ${to}::timestamptz)),0)::int as "refundCents",
      -- Cash security deposits sit in the drawer until released.
      coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=${propertyId}::uuid and le.account='Cash'
        and le.resource_type in ('deposit-collect','deposit-release')
        and le.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or le.created_at < ${to}::timestamptz)),0)::int as "depositCents",
      coalesce((select sum(po.amount_cents) from paid_outs po where po.property_id=${propertyId}::uuid
        and po.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or po.created_at < ${to}::timestamptz)),0)::int as "paidOutCents"
  `;
  return { ...row, netCents: row.paymentCents - row.refundCents + row.depositCents - row.paidOutCents };
}

