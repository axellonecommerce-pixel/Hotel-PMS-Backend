type DeductionReason = "Damage" | "Late Checkout" | "Smoking" | "Missing Item" | "Other";

export type DepositRecord = { id: string; amountCents: number; method: string; status: string; createdAt: string };
export type DepositTransactionRecord = { id: string; type: string; amountCents: number; reason: string | null; note: string | null; createdAt: string };

/** Reservation fields describing its (latest) security deposit. */
export type DepositView = {
  securityDepositCents?: number;
  securityDepositStatus?: "Held" | "Settled";
  securityDepositMethod?: string;
  securityDepositCollectedAt?: string;
  securityDepositDeductions?: Array<{ id: string; reason: DeductionReason; note?: string; amountCents: number }>;
  securityDepositReleasedCents?: number;
  securityDepositSettledAt?: string;
  /** Every deposit movement, oldest first, for folios and deposit receipts. */
  securityDepositHistory?: Array<{ type: "Collected" | "Charged" | "Released"; amountCents: number; at: string; method?: string; reason?: string; note?: string }>;
};

const reasons: DeductionReason[] = ["Damage", "Late Checkout", "Smoking", "Missing Item", "Other"];

export function depositView(deposit: DepositRecord | null | undefined, transactions: DepositTransactionRecord[]): DepositView {
  if (!deposit) return {};
  const deductions = transactions.filter((transaction) => transaction.type === "charge").map((transaction) => ({
    id: transaction.id,
    reason: reasons.includes(transaction.reason as DeductionReason) ? transaction.reason as DeductionReason : "Other" as const,
    note: transaction.note ?? undefined,
    amountCents: transaction.amountCents,
  }));
  const releases = transactions.filter((transaction) => transaction.type === "release");
  const releasedCents = releases.reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const settledAt = releases.at(-1)?.createdAt;
  return {
    securityDepositCents: deposit.amountCents,
    securityDepositStatus: deposit.status === "held" ? "Held" : "Settled",
    securityDepositMethod: deposit.method,
    securityDepositCollectedAt: deposit.createdAt,
    securityDepositDeductions: deductions.length ? deductions : undefined,
    securityDepositReleasedCents: releasedCents || undefined,
    securityDepositSettledAt: deposit.status === "held" ? undefined : settledAt ?? undefined,
    securityDepositHistory: [
      { type: "Collected" as const, amountCents: deposit.amountCents, at: deposit.createdAt, method: deposit.method },
      ...transactions.filter((transaction) => transaction.type === "charge" || transaction.type === "release").map((transaction) => ({
        type: transaction.type === "charge" ? "Charged" as const : "Released" as const,
        amountCents: transaction.amountCents,
        at: transaction.createdAt,
        reason: transaction.reason ?? undefined,
        note: transaction.note ?? undefined,
      })),
    ],
  };
}
