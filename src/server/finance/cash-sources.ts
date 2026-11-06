import type { Sql, TransactionSql } from "postgres";

import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { requireOpenShift } from "@/server/finance/shift-guard";

type Tx = TransactionSql<Record<string, never>>;
type Db = Sql | Tx;

// Where money is paid from: the front-desk drawer (Cash Drop shift), the
// safe, or one of the motel's bank accounts. Every payment out of any of
// them is one cash_movements row, so each balance is always the sum of its
// movements. These rules apply to every motel; never special-case one.

/** Cash paid out comes from the front-desk drawer (Cash Drop shift) or the safe. */
export const CASH_SOURCES = ["drawer", "safe"] as const;
export type CashSource = (typeof CASH_SOURCES)[number];
export type PaySource = CashSource | "bank";
export type CashLocation = PaySource;

/** Ledger account that holds each cash location. A bank account's is `bankLedgerAccount(name)`. */
export const CASH_ACCOUNTS: Record<CashSource, string> & { bank: string } = { drawer: "Cash", safe: "Cash - Safe", bank: "Bank" };
export const CASH_SOURCE_LABELS: Record<CashSource, string> = { drawer: "Cash Drop (front desk drawer)", safe: "Cash in Safe" };

export type BankAccount = { id: string; name: string };
export const bankLedgerAccount = (name: string) => `Bank - ${name}`;

/** Paying in cash: the drawer or the safe must be chosen. */
export const isCashMethod = (method: string | null | undefined) => (method ?? "").trim().toLowerCase() === "cash";
/** Paying by check, debit card, transfer, ACH, wire, Zelle or direct deposit takes money out of a bank account. */
export const isBankMethod = (method: string | null | undefined) => /check|cheque|debit|ach\b|bank|transfer|direct deposit|zelle|wire/i.test(method ?? "");

export class BankAccountError extends Error {}

const uuidOrNull = (value: string | undefined | null) => value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;

/**
 * The bank account a payment comes from: the one chosen, or the motel's
 * default account. Every motel has a default (created when it is set up), so
 * a bank payment is never left without an account.
 */
export async function bankAccountFor(db: Db, propertyId: string, bankAccountId?: string | null): Promise<BankAccount> {
  const chosen = uuidOrNull(bankAccountId);
  const [account] = chosen
    ? await db<BankAccount[]>`select id,name from bank_accounts where id=${chosen}::uuid and property_id=${propertyId}::uuid and active`
    : await db<BankAccount[]>`select id,name from bank_accounts where property_id=${propertyId}::uuid and active order by is_default desc, created_at limit 1`;
  if (account) return account;
  throw new BankAccountError(chosen ? "That bank account was not found or is closed. Choose another account." : "Add a bank account under Cash & Bank first.");
}

/** Makes sure a motel has its default bank account (new motels, and any created before bank accounts existed). */
export async function ensureDefaultBankAccount(db: Db, propertyId: string) {
  await db`
    insert into bank_accounts (property_id,name,is_default)
    select ${propertyId}::uuid,'Main Bank Account',true
    where not exists (select 1 from bank_accounts where property_id=${propertyId}::uuid)
  `;
}

/**
 * Pays money out to a vendor or employee. From the drawer it needs an open
 * shift and creates a paid out linked to the expense or wage, so it shows in
 * Shift & Cash Drop and lowers the shift's expected cash. From the safe or a
 * bank account it lowers that balance. The caller posts the expense side of
 * the ledger (debit) and credits `creditAccountFor(...)`.
 */
export async function payOut(tx: Tx, input: {
  propertyId: string; authUserId?: string; source: PaySource; bankAccount?: BankAccount | null; amountCents: number;
  kind: "expense" | "payroll"; resourceType: string; resourceId: string;
  paidTo: string; reason: string; description: string;
}) {
  if (input.amountCents <= 0) return { businessDate: await propertyBusinessDate(tx, input.propertyId), paidOutId: null };
  if (input.source === "bank" && !input.bankAccount) throw new BankAccountError("Choose the bank account the money came from.");
  if (input.source === "drawer") await requireOpenShift(tx, input.propertyId, "pay cash from the Cash Drop drawer (or choose Cash in Safe)");
  const businessDate = await propertyBusinessDate(tx, input.propertyId);
  let paidOutId: string | null = null;
  if (input.source === "drawer") {
    const [paidOut] = await tx<Array<{ id: string }>>`
      insert into paid_outs (property_id,business_date,amount_cents,paid_to,reason,note,created_by_auth_user_id,source_type,source_id)
      values (${input.propertyId}::uuid,${businessDate}::date,${input.amountCents},${input.paidTo.slice(0, 120)},${input.reason.slice(0, 120)},${input.description.slice(0, 500)},${uuidOrNull(input.authUserId)}::uuid,${input.resourceType},${input.resourceId}::uuid)
      returning id
    `;
    paidOutId = paidOut.id;
  }
  await tx`
    insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,resource_id,description,created_by_auth_user_id,bank_account_id)
    values (${input.propertyId}::uuid,${businessDate}::date,${input.source},null,${input.amountCents},${input.kind},${input.resourceType},${input.resourceId}::uuid,${input.description.slice(0, 500)},${uuidOrNull(input.authUserId)}::uuid,${input.source === "bank" ? input.bankAccount!.id : null}::uuid)
  `;
  return { businessDate, paidOutId };
}

/** Cash-only shorthand kept for callers that pay from the drawer or safe. */
export const payCashOut = (tx: Tx, input: Omit<Parameters<typeof payOut>[1], "source"> & { source: CashSource }) => payOut(tx, input);

/**
 * Undoes a payment (a wage marked unpaid, a payment method changed). A paid
 * out from the still-open shift is removed so the drawer balances; cash from
 * a closed shift or the safe is returned to the safe; money from a bank
 * account goes back to that account. Returns where it went (for the ledger),
 * or null if nothing had been paid out.
 */
export async function reverseCashOut(tx: Tx, input: { propertyId: string; authUserId?: string; resourceType: string; resourceId: string; description: string }) {
  const [paid] = await tx<Array<{ source: PaySource; bankAccountId: string | null; amountCents: number }>>`
    select from_location as source, bank_account_id as "bankAccountId", sum(amount_cents)::int as "amountCents"
    from cash_movements
    where property_id=${input.propertyId}::uuid and resource_type=${input.resourceType} and resource_id=${input.resourceId}::uuid and kind in ('expense','payroll')
    group by from_location, bank_account_id
  `;
  if (!paid) return null;
  const [returned] = await tx<Array<{ amountCents: number }>>`
    select coalesce(sum(amount_cents),0)::int as "amountCents" from cash_movements
    where property_id=${input.propertyId}::uuid and resource_type=${input.resourceType} and resource_id=${input.resourceId}::uuid and kind='reversal'
  `;
  const outstanding = paid.amountCents - returned.amountCents;
  if (outstanding <= 0) return null;
  const businessDate = await propertyBusinessDate(tx, input.propertyId);
  if (paid.source === "drawer") {
    // Still in the open shift: remove the paid out, as if it never happened.
    const [shift] = await tx<Array<{ openedAt: string }>>`select opened_at::text as "openedAt" from cash_shifts where property_id=${input.propertyId}::uuid and status like 'open:%' limit 1`;
    const removed = shift ? await tx<Array<{ id: string }>>`
      delete from paid_outs where property_id=${input.propertyId}::uuid and source_type=${input.resourceType} and source_id=${input.resourceId}::uuid
        and created_at >= ${shift.openedAt}::timestamptz returning id
    ` : [];
    if (removed.length) {
      await tx`delete from cash_movements where property_id=${input.propertyId}::uuid and resource_type=${input.resourceType} and resource_id=${input.resourceId}::uuid and kind in ('expense','payroll','reversal')`;
      return { location: "drawer" as const, amountCents: outstanding, businessDate, bankAccountId: null };
    }
  }
  // A bank payment goes back to its bank account. Cash from a closed shift
  // (the drawer was counted without it) or from the safe goes into the safe.
  const location: PaySource = paid.source === "bank" ? "bank" : "safe";
  await tx`
    insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,resource_id,description,created_by_auth_user_id,bank_account_id)
    values (${input.propertyId}::uuid,${businessDate}::date,null,${location},${outstanding},'reversal',${input.resourceType},${input.resourceId}::uuid,${input.description.slice(0, 500)},${uuidOrNull(input.authUserId)}::uuid,${location === "bank" ? paid.bankAccountId : null}::uuid)
  `;
  return { location, amountCents: outstanding, businessDate, bankAccountId: location === "bank" ? paid.bankAccountId : null };
}

/** Records a cash drop (drawer → safe) and posts it to the ledger. */
export async function recordCashDrop(tx: Tx, input: { propertyId: string; cashDropId: string; businessDate: string; amountCents: number; clerk: string; authUserId?: string }) {
  if (input.amountCents <= 0) return;
  const description = `Cash drop from ${input.clerk}`;
  await tx`
    insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,resource_id,description,created_by_auth_user_id)
    values (${input.propertyId}::uuid,${input.businessDate}::date,'drawer','safe',${input.amountCents},'cash_drop','cash-drop',${input.cashDropId}::uuid,${description},${uuidOrNull(input.authUserId)}::uuid)
  `;
  await postProductionLedger(tx, {
    propertyId: input.propertyId, businessDate: input.businessDate, resourceType: "cash-drop", resourceId: input.cashDropId,
    description, debitAccount: CASH_ACCOUNTS.safe, creditAccount: CASH_ACCOUNTS.drawer, amountCents: input.amountCents,
  });
}

/** Current safe balance and total in all bank accounts (sum of every movement in and out). */
export async function cashBalances(db: Db, propertyId: string) {
  const [row] = await db<Array<{ safeCents: number; bankCents: number }>>`
    select
      coalesce(sum(case when to_location='safe' then amount_cents else 0 end) - sum(case when from_location='safe' then amount_cents else 0 end),0)::int as "safeCents",
      coalesce(sum(case when to_location='bank' then amount_cents else 0 end) - sum(case when from_location='bank' then amount_cents else 0 end),0)::int as "bankCents"
    from cash_movements where property_id=${propertyId}::uuid
  `;
  return row ?? { safeCents: 0, bankCents: 0 };
}

/** Each bank account with its balance. */
export async function bankAccountBalances(db: Db, propertyId: string) {
  return db<Array<{ id: string; name: string; bankName: string | null; last4: string | null; accountType: string; isDefault: boolean; active: boolean; balanceCents: number }>>`
    select b.id, b.name, b.bank_name as "bankName", b.account_last4 as last4, b.account_type as "accountType", b.is_default as "isDefault", b.active,
      coalesce((select sum(case when m.to_location='bank' then m.amount_cents else 0 end) - sum(case when m.from_location='bank' then m.amount_cents else 0 end)
        from cash_movements m where m.bank_account_id=b.id),0)::int as "balanceCents"
    from bank_accounts b where b.property_id=${propertyId}::uuid
    order by b.active desc, b.is_default desc, b.created_at
  `;
}

/** Ledger account credited when an expense or wage is paid by this method. */
export function creditAccountFor(paymentMethod: string, cashSource?: CashSource | null, bankAccount?: BankAccount | null) {
  if (isCashMethod(paymentMethod)) return CASH_ACCOUNTS[cashSource ?? "safe"];
  if (isBankMethod(paymentMethod)) return bankAccount ? bankLedgerAccount(bankAccount.name) : CASH_ACCOUNTS.bank;
  if (/credit/i.test(paymentMethod)) return "Credit Card Payable";
  return "Accounts Payable";
}
