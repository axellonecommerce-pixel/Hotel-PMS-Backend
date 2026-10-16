export function formatDocumentNumber(prefix: string, format: string, value: number, date: Date) {
  const hashMatch = format.match(/#+/);
  const digits = hashMatch?.[0].length ?? 6;
  const body = format.replace("YYYY", String(date.getUTCFullYear())).replace(/#+/, String(value).padStart(digits, "0"));
  return `${prefix}${prefix && body ? "-" : ""}${body}`;
}

export function balancedLedgerLines(debitAccount: string, creditAccount: string, amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("A positive whole-cent amount is required.");
  return [
    { account: debitAccount, debitCents: amountCents, creditCents: 0 },
    { account: creditAccount, debitCents: 0, creditCents: amountCents },
  ];
}
