import { and, eq } from "drizzle-orm";

import { db } from "@/server/db/client";
import { documentSequences, ledgerEntries } from "@/server/db/schema";
import { balancedLedgerLines, formatDocumentNumber } from "@/domain/rules/accounting";

export function allocateDocumentNumber(propertyId: string, date = new Date()) {
  return db.transaction((tx) => {
    let sequence = tx.query.documentSequences.findFirst({ where: eq(documentSequences.propertyId, propertyId) }).sync();
    const year = date.getUTCFullYear();
    if (!sequence) {
      sequence = { id: `sequence-${crypto.randomUUID()}`, propertyId, prefix: "FOL", format: "YYYY-######", nextNumber: 1, annualReset: false, resetYear: year, updatedAt: date.toISOString() };
      tx.insert(documentSequences).values(sequence).run();
    }
    const number = sequence.annualReset && sequence.resetYear !== year ? 1 : sequence.nextNumber;
    tx.update(documentSequences).set({ nextNumber: number + 1, resetYear: year, updatedAt: date.toISOString() }).where(eq(documentSequences.id, sequence.id)).run();
    return formatDocumentNumber(sequence.prefix, sequence.format, number, date);
  });
}

export function postBalancedLedger(input: { propertyId: string; businessDate: string; resourceType: string; resourceId: string; description: string; debitAccount: string; creditAccount: string; amountCents: number }) {
  const lines = balancedLedgerLines(input.debitAccount, input.creditAccount, input.amountCents);
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.insert(ledgerEntries).values(lines.map((line) => ({ id: `ledger-${crypto.randomUUID()}`, propertyId: input.propertyId, businessDate: input.businessDate, ...line, resourceType: input.resourceType, resourceId: input.resourceId, description: input.description, createdAt: now }))).run();
  });
}

export function ledgerBalances(propertyId: string, resourceId: string) {
  return db.query.ledgerEntries.findMany({ where: and(eq(ledgerEntries.propertyId, propertyId), eq(ledgerEntries.resourceId, resourceId)) });
}
