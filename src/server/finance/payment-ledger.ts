import type { TransactionSql } from "postgres";

import { CASH_ACCOUNTS } from "@/server/finance/cash-sources";

type Tx = TransactionSql<Record<string, never>>;

// Every payment is posted to the ledger: the money received (debit) against
// what the payer owed (credit). Bad debt and OTA commission settlements post
// their own entries where they are created. The migration
// 0019_cash_sources_and_accounting.sql backfills older payments with the
// same rules; keep the two in step.

/** Card and check payments wait here until they are deposited in a bank account (card-settlements.ts). */
export const RECEIPTS_ACCOUNT = "Card & Check Receipts";

/** Ledger account that receives a payment made by `method`. */
export function receiptAccount(method: string) {
  // Cash taken at the desk is in the drawer until the shift drops it.
  return method.trim().toLowerCase() === "cash" ? CASH_ACCOUNTS.drawer : RECEIPTS_ACCOUNT;
}

/** Who owed the money a payment settles. */
function owedAccount(payment: { method: string; reservationId: string | null; houseAccountId: string | null; companyId: string | null }) {
  if (payment.method.toUpperCase() === "DIRECT BILL") return "Guest Receivable";
  if (payment.houseAccountId) return "House Account Receivable";
  if (payment.reservationId) return "Guest Receivable";
  if (payment.companyId) return "Company Receivable";
  return "Guest Receivable";
}

const SKIPPED = new Set(["BAD DEBT", "OTA COMMISSION"]);

async function insertLines(tx: Tx, input: { propertyId: string; businessDate: string; resourceType: string; resourceId: string; description: string; debit: string; credit: string; amountCents: number }) {
  if (input.amountCents <= 0) return;
  await tx`
    insert into ledger_entries (property_id,business_date,account,debit_cents,credit_cents,resource_type,resource_id,description)
    values (${input.propertyId}::uuid,${input.businessDate}::date,${input.debit},${input.amountCents},0,${input.resourceType},${input.resourceId}::uuid,${input.description}),
           (${input.propertyId}::uuid,${input.businessDate}::date,${input.credit},0,${input.amountCents},${input.resourceType},${input.resourceId}::uuid,${input.description})
  `;
}

/** Posts a payment just created. A direct-bill transfer moves the balance from the guest to the company. */
export async function postPaymentLedger(tx: Tx, propertyId: string, paymentId: string) {
  const [payment] = await tx<Array<{ method: string; amountCents: number; businessDate: string; reservationId: string | null; houseAccountId: string | null; companyId: string | null }>>`
    select method, amount_cents as "amountCents", effective_date::text as "businessDate", reservation_id as "reservationId", house_account_id as "houseAccountId", company_id as "companyId"
    from payments where id=${paymentId}::uuid and property_id=${propertyId}::uuid
  `;
  if (!payment || SKIPPED.has(payment.method.toUpperCase())) return;
  const directBill = payment.method.toUpperCase() === "DIRECT BILL";
  await insertLines(tx, {
    propertyId, businessDate: payment.businessDate, resourceType: "payment", resourceId: paymentId,
    description: directBill ? "Balance moved to the company invoice" : `Payment received · ${payment.method}`,
    debit: directBill ? "Company Receivable" : receiptAccount(payment.method), credit: owedAccount(payment), amountCents: payment.amountCents,
  });
}

/** Posts a refund of a payment: the money goes back out, and the payer owes it again. */
export async function postRefundLedger(tx: Tx, propertyId: string, paymentId: string, refundId: string, amountCents: number, businessDate: string) {
  const [payment] = await tx<Array<{ method: string; reservationId: string | null; houseAccountId: string | null; companyId: string | null }>>`
    select method, reservation_id as "reservationId", house_account_id as "houseAccountId", company_id as "companyId"
    from payments where id=${paymentId}::uuid and property_id=${propertyId}::uuid
  `;
  if (!payment || SKIPPED.has(payment.method.toUpperCase())) return;
  await insertLines(tx, {
    propertyId, businessDate, resourceType: "refund", resourceId: refundId, description: `Refund · ${payment.method}`,
    debit: owedAccount(payment), credit: receiptAccount(payment.method), amountCents,
  });
}

/** Reverses everything posted for a payment (and its refunds) before it is deleted. */
export async function reversePaymentLedger(tx: Tx, propertyId: string, paymentId: string, businessDate: string) {
  const lines = await tx<Array<{ account: string; netCents: number }>>`
    select account, sum(debit_cents-credit_cents)::int as "netCents" from ledger_entries
    where property_id=${propertyId}::uuid and (
      (resource_type='payment' and resource_id=${paymentId}::uuid)
      or (resource_type='refund' and resource_id in (select id from refunds where payment_id=${paymentId}::uuid)))
    group by account having sum(debit_cents-credit_cents) <> 0
  `;
  for (const line of lines) await tx`
    insert into ledger_entries (property_id,business_date,account,debit_cents,credit_cents,resource_type,resource_id,description)
    values (${propertyId}::uuid,${businessDate}::date,${line.account},${line.netCents < 0 ? -line.netCents : 0},${line.netCents > 0 ? line.netCents : 0},'payment',${paymentId}::uuid,'Payment deleted · reversed')
  `;
}
