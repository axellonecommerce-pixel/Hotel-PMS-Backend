// Classifies the ledger's accounts for the Trial Balance. Debit-normal types
// (assets, expenses) show their balance as a debit; credit-normal types
// (liabilities, equity, revenue) as a credit.
export type AccountType = "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
const ORDER: AccountType[] = ["Asset", "Liability", "Equity", "Revenue", "Expense"];

export function accountType(account: string): AccountType {
  if (account === "Room Revenue" || account.startsWith("Revenue:")) return "Revenue";
  if (account.startsWith("Expense:") || ["Payroll Expense", "Paid Outs", "OTA Commission Expense", "Bad Debt Expense", "Card Processing Fees", "Bank Fees & Adjustments", "Cash Over/Short"].includes(account)) return "Expense";
  if (["Owner's Equity", "Owner's Draw", "Opening Balance Equity"].includes(account)) return "Equity";
  if (["Tax Payable", "Commission Payable", "Security Deposits Held", "Accounts Payable", "Credit Card Payable", "Payroll Withholding & Advances"].includes(account)) return "Liability";
  return "Asset";
}

/** Plain names for staff; the ledger keeps the stable account keys. */
export function accountLabel(account: string) {
  if (account === "Cash") return "Cash Drop (front desk drawer)";
  if (account === "Guest Receivable") return "Guest Ledger (owed by guests; negative = paid in advance)";
  if (account === "Cash - Unspecified") return "Cash (wages paid before cash sources were recorded)";
  if (account.startsWith("Other Revenue Receipts:")) return `Other Revenue Received (${account.slice("Other Revenue Receipts:".length)})`;
  if (account.startsWith("Expense:")) return `Expense: ${account.slice(8)}`;
  return account;
}

export const accountTypeOrder = (type: AccountType) => ORDER.indexOf(type);
export const debitNormal = (type: AccountType) => type === "Asset" || type === "Expense";
