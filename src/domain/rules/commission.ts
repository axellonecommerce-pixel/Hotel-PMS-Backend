export function calculateCommissionCents(roomRevenueCents: number, commissionPercent: number) {
  return Math.round(Math.max(0, roomRevenueCents) * Math.max(0, commissionPercent) / 100);
}

export function calculateNetRoomRevenueCents(roomRevenueCents: number, commissionCents: number) {
  return Math.max(0, roomRevenueCents - Math.max(0, commissionCents));
}

export type OtaPaymentStatus = "Guest Pays Hotel" | "Paid Online" | "Virtual Card Pending";

/**
 * Paid Online and Virtual Card Pending mean the OTA collected from the guest
 * and keeps its commission before remitting the net. Guest Pays Hotel means
 * the hotel collects the gross amount and owes the commission to the OTA.
 */
export function otaDeductsCommission(paymentStatus: OtaPaymentStatus | null | undefined) {
  return paymentStatus === "Paid Online" || paymentStatus === "Virtual Card Pending";
}

/**
 * Settings rule per OTA payment category for the amount staff enter:
 * "deduct" takes the OTA commission out of it; "none" means the amount is
 * already net of commission, so all of it is the hotel's.
 */
export type OtaCommissionRule = "deduct" | "none";
export type OtaCommissionRules = Record<OtaPaymentStatus, OtaCommissionRule>;

/** Owner default: online and virtual-card amounts are already net; pay-at-hotel amounts have commission deducted. */
export const DEFAULT_OTA_COMMISSION_RULES: OtaCommissionRules = {
  "Guest Pays Hotel": "deduct",
  "Paid Online": "none",
  "Virtual Card Pending": "none",
};

/** Saved rules merged over the defaults (older settings have none). */
export function otaCommissionRules(value: unknown): OtaCommissionRules {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(DEFAULT_OTA_COMMISSION_RULES).map(([status, rule]) => [
    status,
    saved[status] === "deduct" || saved[status] === "none" ? saved[status] : rule,
  ])) as OtaCommissionRules;
}

export function otaCommissionApplies(paymentStatus: OtaPaymentStatus | null | undefined, rules: OtaCommissionRules = DEFAULT_OTA_COMMISSION_RULES) {
  return !paymentStatus || rules[paymentStatus] !== "none";
}

export type OtaBreakdown = {
  grossCents: number;
  taxCents: number;
  commissionCents: number;
  netCents: number;
  commissionDeducted: boolean;
};

/** Commission is charged on room rent before tax; net is what the hotel keeps. */
export function calculateOtaBreakdown(input: {
  roomRentCents: number;
  taxCents: number;
  commissionPercent: number;
  paymentStatus: OtaPaymentStatus | null | undefined;
  rules?: OtaCommissionRules;
}): OtaBreakdown {
  const grossCents = Math.max(0, input.roomRentCents) + Math.max(0, input.taxCents);
  const commissionCents = otaCommissionApplies(input.paymentStatus, input.rules)
    ? Math.min(grossCents, calculateCommissionCents(input.roomRentCents, input.commissionPercent))
    : 0;
  return {
    grossCents,
    taxCents: Math.max(0, input.taxCents),
    commissionCents,
    netCents: grossCents - commissionCents,
    commissionDeducted: otaDeductsCommission(input.paymentStatus),
  };
}
