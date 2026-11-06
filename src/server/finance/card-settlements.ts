import type { Sql, TransactionSql } from "postgres";

import { bankAccountFor, bankLedgerAccount, type BankAccount } from "@/server/finance/cash-sources";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { RECEIPTS_ACCOUNT } from "@/server/finance/payment-ledger";

type Tx = TransactionSql<Record<string, never>>;
type Db = Sql | Tx;

// Card and check deposits. A guest card or check payment is held in
// "Card & Check Receipts" until it is deposited; a deposit moves the money
// into a bank account and books what the processor kept as a fee. The same
// rules run for every motel, by hand (Cash & Bank) or automatically (daily job).

export const FEES_ACCOUNT = "Card Processing Fees";
const SKIPPED_METHODS = ["BAD DEBT", "OTA COMMISSION", "DIRECT BILL"];

/** Card payments (deposited by the processor); checks are deposited by hand. */
export const isCardMethod = (method: string) => /card|credit|debit|visa|master|amex|american express|discover/i.test(method) && !/^cash$/i.test(method.trim());

/** viaTerminal: taken on the connected card terminal; its processor's payouts deposit it with exact fees. */
export type DepositItem = { kind: "payment" | "refund"; id: string; date: string; method: string; amountCents: number; payer: string; card: boolean; viaTerminal: boolean };

/** Card and check payments (and refunds of them) not yet deposited. Refunds are negative. */
export async function pendingDepositItems(db: Db, propertyId: string): Promise<DepositItem[]> {
  const rows = await db<Array<Omit<DepositItem, "card">>>`
    select 'payment' as kind, p.id, p.effective_date::text as date, p.method, p.amount_cents as "amountCents",
      coalesce(g.first_name||' '||g.last_name, ha.name, c.name, 'Payment') as payer, p.terminal_payment_id is not null as "viaTerminal"
    from payments p
    left join reservations r on r.id=p.reservation_id left join guests g on g.id=r.main_guest_id
    left join house_accounts ha on ha.id=p.house_account_id left join companies c on c.id=p.company_id
    where p.property_id=${propertyId}::uuid and p.settlement_id is null and lower(trim(p.method))<>'cash'
      and upper(p.method) not in ${db(SKIPPED_METHODS)} and p.amount_cents>0
    union all
    select 'refund', rf.id, rf.effective_date::text, p.method, -rf.amount_cents,
      coalesce(g.first_name||' '||g.last_name, 'Refund'), p.terminal_payment_id is not null
    from refunds rf join payments p on p.id=rf.payment_id
    left join reservations r on r.id=p.reservation_id left join guests g on g.id=r.main_guest_id
    where rf.property_id=${propertyId}::uuid and rf.settlement_id is null and lower(trim(p.method))<>'cash'
      and upper(p.method) not in ${db(SKIPPED_METHODS)} and rf.amount_cents>0
    order by date, kind
  `;
  return rows.map((row) => ({ ...row, card: isCardMethod(row.method) }));
}

export class DepositError extends Error {}

/**
 * Records one deposit of the chosen items into a bank account. `netCents` is
 * what the bank received; gross minus net is the processor's fee. With
 * `historical`, the items were deposited before the motel used the PMS (the
 * bank account's opening balance already holds them), so no money moves.
 */
export async function settleDeposit(tx: Tx, input: {
  propertyId: string; bankAccount: BankAccount; paymentIds: string[]; refundIds: string[]; netCents: number;
  depositDate: string; reference?: string | null; note?: string | null; automatic?: boolean; historical?: boolean; authUserId?: string | null;
}) {
  const paymentIds = [...new Set(input.paymentIds)];
  const refundIds = [...new Set(input.refundIds)];
  if (!paymentIds.length && !refundIds.length) throw new DepositError("Choose the payments in this deposit.");
  await tx`select pg_advisory_xact_lock(hashtext(${`deposit:${input.propertyId}`}))`;
  // Lock and re-check: an item can be deposited only once.
  const payments = paymentIds.length ? await tx<Array<{ id: string; amountCents: number }>>`
    select id, amount_cents as "amountCents" from payments
    where property_id=${input.propertyId}::uuid and id in ${tx(paymentIds)} and settlement_id is null
      and lower(trim(method))<>'cash' and upper(method) not in ${tx(SKIPPED_METHODS)} for update
  ` : [];
  const refunds = refundIds.length ? await tx<Array<{ id: string; amountCents: number }>>`
    select rf.id, rf.amount_cents as "amountCents" from refunds rf join payments p on p.id=rf.payment_id
    where rf.property_id=${input.propertyId}::uuid and rf.id in ${tx(refundIds)} and rf.settlement_id is null for update of rf
  ` : [];
  if (payments.length !== paymentIds.length || refunds.length !== refundIds.length) throw new DepositError("Some of these payments were already deposited or no longer exist. Reload and try again.");
  const grossCents = payments.reduce((sum, item) => sum + item.amountCents, 0) - refunds.reduce((sum, item) => sum + item.amountCents, 0);
  const netCents = input.historical ? grossCents : input.netCents;
  const feeCents = grossCents - netCents;
  if (feeCents < 0) throw new DepositError(`The bank received more than these payments total ($${(grossCents / 100).toFixed(2)}). Check the amount or the payments chosen.`);
  if (netCents < 0) throw new DepositError("The deposit amount cannot be negative.");
  const actor = input.authUserId && /^[0-9a-f-]{36}$/i.test(input.authUserId) ? input.authUserId : null;
  const [settlement] = await tx<Array<{ id: string }>>`
    insert into card_settlements (property_id,bank_account_id,deposit_date,gross_cents,fee_cents,net_cents,item_count,reference,note,automatic,created_by_auth_user_id)
    values (${input.propertyId}::uuid,${input.bankAccount.id}::uuid,${input.depositDate}::date,${grossCents},${feeCents},${netCents},${payments.length + refunds.length},
      ${input.reference ?? null},${input.historical ? `Deposited before using the PMS${input.note ? ` · ${input.note}` : ""}` : input.note ?? null},${input.automatic ?? false},${actor}::uuid)
    returning id
  `;
  if (payments.length) await tx`update payments set settlement_id=${settlement.id}::uuid where id in ${tx(payments.map((item) => item.id))}`;
  if (refunds.length) await tx`update refunds set settlement_id=${settlement.id}::uuid where id in ${tx(refunds.map((item) => item.id))}`;
  const description = `${input.historical ? "Card & check receipts already in the bank" : input.automatic ? "Card deposit (automatic)" : "Card & check deposit"} · ${input.bankAccount.name}${input.reference ? ` · ref ${input.reference}` : ""}`;
  const post = (debitAccount: string, creditAccount: string, amountCents: number) => amountCents > 0
    ? postProductionLedger(tx, { propertyId: input.propertyId, businessDate: input.depositDate, resourceType: "card-settlement", resourceId: settlement.id, description, debitAccount, creditAccount, amountCents })
    : Promise.resolve();
  const gross = (debit: string, credit: string, amount: number) => amount < 0 ? post(credit, debit, -amount) : post(debit, credit, amount);
  if (input.historical) {
    // Already counted in the bank account's opening balance.
    await gross("Opening Balance Equity", RECEIPTS_ACCOUNT, grossCents);
  } else {
    await gross(bankLedgerAccount(input.bankAccount.name), RECEIPTS_ACCOUNT, netCents);
    await post(FEES_ACCOUNT, RECEIPTS_ACCOUNT, feeCents);
    if (netCents !== 0) await tx`
      insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,resource_id,description,reference,bank_account_id,created_by_auth_user_id)
      values (${input.propertyId}::uuid,${input.depositDate}::date,${netCents < 0 ? "bank" : null},${netCents > 0 ? "bank" : null},${Math.abs(netCents)},'card_settlement','card-settlement',${settlement.id}::uuid,${description},${input.reference ?? null},${input.bankAccount.id}::uuid,${actor}::uuid)
    `;
  }
  return { id: settlement.id, grossCents, feeCents, netCents, itemCount: payments.length + refunds.length };
}

/** Undoes a deposit recorded by mistake: the payments wait for deposit again. */
export async function undoDeposit(tx: Tx, propertyId: string, settlementId: string) {
  const [settlement] = await tx<Array<{ id: string }>>`select id from card_settlements where id=${settlementId}::uuid and property_id=${propertyId}::uuid for update`;
  if (!settlement) return false;
  const today = await propertyBusinessDate(tx, propertyId);
  const lines = await tx<Array<{ account: string; netCents: number }>>`
    select account, sum(debit_cents-credit_cents)::int as "netCents" from ledger_entries
    where property_id=${propertyId}::uuid and resource_type='card-settlement' and resource_id=${settlementId}::uuid
    group by account having sum(debit_cents-credit_cents) <> 0
  `;
  for (const line of lines) await tx`
    insert into ledger_entries (property_id,business_date,account,debit_cents,credit_cents,resource_type,resource_id,description)
    values (${propertyId}::uuid,${today}::date,${line.account},${line.netCents < 0 ? -line.netCents : 0},${line.netCents > 0 ? line.netCents : 0},'card-settlement',${settlementId}::uuid,'Card deposit undone')
  `;
  await tx`delete from cash_movements where property_id=${propertyId}::uuid and resource_type='card-settlement' and resource_id=${settlementId}::uuid`;
  await tx`update payments set settlement_id=null where settlement_id=${settlementId}::uuid`;
  await tx`update refunds set settlement_id=null where settlement_id=${settlementId}::uuid`;
  await tx`delete from card_settlements where id=${settlementId}::uuid`;
  return true;
}

export type AutoDepositSettings = { enabled: boolean; bankAccountId?: string | null; feePercent: number; delayDays: number };
export const DEFAULT_AUTO_DEPOSIT: AutoDepositSettings = { enabled: false, bankAccountId: null, feePercent: 2.9, delayDays: 2 };

export async function autoDepositSettings(db: Db, propertyId: string): Promise<AutoDepositSettings> {
  const [row] = await db<Array<{ value: Partial<AutoDepositSettings> }>>`select value from property_settings where property_id=${propertyId}::uuid and key='card_deposits'`;
  return { ...DEFAULT_AUTO_DEPOSIT, ...(row?.value ?? {}) };
}

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Automatic card deposits (daily job): each day's card payments are deposited
 * `delayDays` later into the chosen account, less the estimated fee. Checks
 * are never deposited automatically. Match Statement corrects any difference.
 */
export async function autoDepositCards(tx: Tx, propertyId: string) {
  const settings = await autoDepositSettings(tx, propertyId);
  if (!settings.enabled) return 0;
  const bank = await bankAccountFor(tx, propertyId, settings.bankAccountId).catch(() => null);
  if (!bank) return 0;
  const today = await propertyBusinessDate(tx, propertyId);
  // Terminal payments are deposited from the processor's real payouts instead.
  const due = (await pendingDepositItems(tx, propertyId)).filter((item) => item.card && !item.viaTerminal && addDays(item.date, settings.delayDays) <= today);
  const byDay = new Map<string, DepositItem[]>();
  for (const item of due) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);
  let created = 0;
  for (const [date, items] of byDay) {
    const grossCents = items.reduce((sum, item) => sum + item.amountCents, 0);
    if (grossCents <= 0) continue;
    const feeCents = Math.max(0, Math.round(grossCents * Math.min(Math.max(settings.feePercent, 0), 20) / 100));
    await settleDeposit(tx, {
      propertyId, bankAccount: bank, automatic: true, depositDate: addDays(date, settings.delayDays), netCents: grossCents - feeCents,
      paymentIds: items.filter((item) => item.kind === "payment").map((item) => item.id),
      refundIds: items.filter((item) => item.kind === "refund").map((item) => item.id),
      note: `Card sales of ${date}; fee estimated at ${settings.feePercent}%`,
    });
    created += 1;
  }
  return created;
}
