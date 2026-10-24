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
}): OtaBreakdown {
  const grossCents = Math.max(0, input.roomRentCents) + Math.max(0, input.taxCents);
  const commissionCents = Math.min(grossCents, calculateCommissionCents(input.roomRentCents, input.commissionPercent));
  return {
    grossCents,
    taxCents: Math.max(0, input.taxCents),
    commissionCents,
    netCents: grossCents - commissionCents,
    commissionDeducted: otaDeductsCommission(input.paymentStatus),
  };
}
