import type { Sql, TransactionSql } from "postgres";

import { balancedLedgerLines, formatDocumentNumber } from "@/domain/rules/accounting";

type Tx = TransactionSql<Record<string, never>>;

export async function allocateProductionDocumentNumber(tx: Tx, propertyId: string, date = new Date()) {
  const year = date.getUTCFullYear();
  let rows = await tx<Array<{ id: string; prefix: string; format: string; nextNumber: number; resetYearly: boolean; currentYear: number }>>`
    select id, prefix, format, next_number as "nextNumber", reset_yearly as "resetYearly", current_year as "currentYear"
    from document_sequences
    where property_id = ${propertyId}::uuid
    for update
  `;
  if (!rows.length) {
    rows = await tx<Array<{ id: string; prefix: string; format: string; nextNumber: number; resetYearly: boolean; currentYear: number }>>`
      insert into document_sequences (property_id, prefix, format, next_number, reset_yearly, current_year)
      values (${propertyId}::uuid, 'FOL', 'YYYY-######', 1, true, ${year})
      returning id, prefix, format, next_number as "nextNumber", reset_yearly as "resetYearly", current_year as "currentYear"
    `;
  }
  const sequence = rows[0];
  const value = sequence.resetYearly && sequence.currentYear !== year ? 1 : sequence.nextNumber;
  await tx`
    update document_sequences
    set next_number = ${value + 1}, current_year = ${year}
    where id = ${sequence.id}::uuid
  `;
  return formatDocumentNumber(sequence.prefix, sequence.format, value, date);
}

export async function postProductionLedger(tx: Tx, input: {
  propertyId: string;
  businessDate: string;
  resourceType: string;
  resourceId: string;
  description: string;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
}) {
  const lines = balancedLedgerLines(input.debitAccount, input.creditAccount, input.amountCents);
  for (const line of lines) {
    await tx`
      insert into ledger_entries (
        property_id, business_date, account, debit_cents, credit_cents,
        resource_type, resource_id, description
      ) values (
        ${input.propertyId}::uuid, ${input.businessDate}::date, ${line.account},
        ${line.debitCents}, ${line.creditCents}, ${input.resourceType},
        ${input.resourceId}::uuid, ${input.description}
      )
    `;
  }
}

/**
 * The property's current business date: the open Night Audit day, or today in
 * the property's timezone. Never the database's UTC `current_date`, which is
 * already tomorrow during a West Coast evening.
 */
export async function propertyBusinessDate(tx: Tx | Sql, propertyId: string) {
  const [row] = await tx<Array<{ date: string }>>`
    select coalesce(
      (select business_date::text from business_days where property_id=${propertyId}::uuid and status='open' order by business_date limit 1),
      (now() at time zone coalesce((select timezone from properties where id=${propertyId}::uuid),'UTC'))::date::text
    ) as date
  `;
  return row.date;
}

/**
 * Ledger date for reversing a charge. A night that has not been audited yet
 * is reversed on its own date so that day nets to zero; a charge from a
 * closed day is reversed on the current business date.
 */
export function reversalBusinessDate(businessDate: string, serviceDate: string) {
  return serviceDate > businessDate ? serviceDate : businessDate;
}
