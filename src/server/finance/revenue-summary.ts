export type RevenueLedgerRow = {
  date: string;
  roomRevenueCents: number;
  taxCents: number;
  miscellaneousRevenueCents: number;
};

export function summarizeRevenueLedger(rows: RevenueLedgerRow[]) {
  return rows.map((row) => ({
    ...row,
    totalRevenueCents: row.roomRevenueCents + row.taxCents + row.miscellaneousRevenueCents,
  }));
}
