export type CheckoutInput = {
  companyDirectBill: boolean;
  balanceCents: number;
  depositResolved: boolean;
};

export type CheckoutDecision =
  | { allowed: true; transferToCompanyCents: number }
  | { allowed: false; reason: "UNRESOLVED_DEPOSIT" | "NON_ZERO_BALANCE" };

export function evaluateCheckout(input: CheckoutInput): CheckoutDecision {
  if (!input.depositResolved) return { allowed: false, reason: "UNRESOLVED_DEPOSIT" };
  if (!input.companyDirectBill && input.balanceCents !== 0) {
    return { allowed: false, reason: "NON_ZERO_BALANCE" };
  }
  return {
    allowed: true,
    transferToCompanyCents: input.companyDirectBill ? Math.max(0, input.balanceCents) : 0,
  };
}

export function calculateCashVariance(expectedCents: number, countedCents: number) {
  const differenceCents = countedCents - expectedCents;
  return {
    differenceCents,
    status: differenceCents === 0 ? "Balanced" : differenceCents > 0 ? "Over" : "Short",
  } as const;
}

export function remainingRefundableCents(
  paymentCents: number,
  previousRefundsCents: readonly number[],
) {
  return Math.max(0, paymentCents - previousRefundsCents.reduce((sum, cents) => sum + cents, 0));
}

export function validateRefund(
  paymentCents: number,
  previousRefundsCents: readonly number[],
  requestedCents: number,
) {
  if (!Number.isInteger(requestedCents) || requestedCents <= 0) return false;
  return requestedCents <= remainingRefundableCents(paymentCents, previousRefundsCents);
}

export type PaymentSource = {
  method: string;
  label?: string | null;
  last4?: string | null;
  reference?: string | null;
};

function paymentSourceKey(source: PaymentSource) {
  return [source.method, source.label, source.last4, source.reference]
    .map((value) => value?.trim().toLocaleLowerCase() ?? "")
    .join("|");
}

export function mergePaymentSources(
  existing: readonly PaymentSource[],
  incoming: readonly PaymentSource[],
) {
  const unique = new Map<string, PaymentSource>();
  for (const source of [...existing, ...incoming]) unique.set(paymentSourceKey(source), source);
  return [...unique.values()];
}

export function mergeRemarks(existing?: string | null, incoming?: string | null) {
  const parts = [existing?.trim(), incoming?.trim()].filter(Boolean) as string[];
  return [...new Set(parts)].join("\n") || null;
}

export type PayrollPolicy = {
  dailyOvertimeAfterMinutes: number;
  dailyDoubleTimeAfterMinutes?: number;
};

export function calculatePaidMinutes(
  clockIn: Date,
  clockOut: Date,
  lunchTaken: boolean,
  policy: PayrollPolicy,
) {
  const elapsedMinutes = Math.max(0, Math.floor((clockOut.getTime() - clockIn.getTime()) / 60_000));
  const paidMinutes = Math.max(0, elapsedMinutes - (lunchTaken ? 30 : 0));
  const doubleThreshold = policy.dailyDoubleTimeAfterMinutes ?? Number.POSITIVE_INFINITY;
  const regularMinutes = Math.min(paidMinutes, policy.dailyOvertimeAfterMinutes);
  const overtimeMinutes = Math.max(
    0,
    Math.min(paidMinutes, doubleThreshold) - policy.dailyOvertimeAfterMinutes,
  );
  const doubleTimeMinutes = Math.max(0, paidMinutes - doubleThreshold);
  return { paidMinutes, regularMinutes, overtimeMinutes, doubleTimeMinutes };
}

export type PerformanceInput = {
  roomRevenueCents: number;
  soldRooms: number;
  totalRooms: number;
  outOfOrderRooms: number;
};

export function calculateHotelPerformance(input: PerformanceInput) {
  const rentableRooms = Math.max(0, input.totalRooms - input.outOfOrderRooms);
  const divide = (amount: number, count: number) => (count > 0 ? Math.round(amount / count) : 0);
  const percentage = (count: number, inventory: number) =>
    inventory > 0 ? Math.round((count / inventory) * 10_000) / 100 : 0;
  return {
    adrCents: divide(input.roomRevenueCents, input.soldRooms),
    revParAllRoomsCents: divide(input.roomRevenueCents, input.totalRooms),
    revParRentableRoomsCents: divide(input.roomRevenueCents, rentableRooms),
    occupancyAllRoomsPercent: percentage(input.soldRooms, input.totalRooms),
    occupancyRentableRoomsPercent: percentage(input.soldRooms, rentableRooms),
  };
}

export function canCreateCompanyGroupInvoice(roomStatuses: readonly string[]) {
  return roomStatuses.length > 0 && roomStatuses.every((status) => status === "Checked Out");
}
