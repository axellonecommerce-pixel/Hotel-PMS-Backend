export type DateRange = { arrivalDate: string; departureDate: string };

export function rangesOverlap(left: DateRange, right: DateRange) {
  return left.arrivalDate < right.departureDate && right.arrivalDate < left.departureDate;
}

export function roomTypeAvailability(input: {
  totalActiveRooms: number;
  outOfOrderRooms: number;
  existingReservations: readonly DateRange[];
  requestedRange: DateRange;
  requestedRooms: number;
}) {
  const reserved = input.existingReservations.filter((range) => rangesOverlap(range, input.requestedRange)).length;
  const available = Math.max(0, input.totalActiveRooms - input.outOfOrderRooms - reserved);
  return { available, allowed: input.requestedRooms > 0 && input.requestedRooms <= available };
}

export type Promotion =
  | { type: "percentage"; valueBasisPoints: number }
  | { type: "fixed"; valueCents: number };

export function applyStackedPromotions(rateCents: number, promotions: readonly Promotion[]) {
  return promotions.reduce((amount, promotion) => {
    if (promotion.type === "fixed") return Math.max(0, amount - promotion.valueCents);
    return Math.max(0, amount - Math.round((amount * promotion.valueBasisPoints) / 10_000));
  }, Math.max(0, rateCents));
}

export function createNightlyPostings(input: {
  reservationRoomId: string;
  nightlyRatesCents: readonly number[];
  promotions: readonly Promotion[];
  taxRateBasisPoints: number;
  taxExempt: boolean;
}) {
  return input.nightlyRatesCents.map((baseRateCents, index) => {
    const roomRentCents = applyStackedPromotions(baseRateCents, input.promotions);
    const taxCents = input.taxExempt
      ? 0
      : Math.round((roomRentCents * input.taxRateBasisPoints) / 10_000);
    return {
      reservationRoomId: input.reservationRoomId,
      nightIndex: index,
      baseRateCents,
      roomRentCents,
      taxRateBasisPoints: input.taxRateBasisPoints,
      taxCents,
      totalCents: roomRentCents + taxCents,
    };
  });
}

export type FolioCharge = {
  id: string;
  folioId: string;
  reservationRoomId?: string | null;
  linkedChargeId?: string | null;
  type: string;
};

export function planRoomChargeMove(
  charges: readonly FolioCharge[],
  reservationRoomId: string,
  destinationFolioId: string,
) {
  const selectedIds = new Set(
    charges
      .filter((charge) => charge.reservationRoomId === reservationRoomId)
      .flatMap((charge) => [charge.id, charge.linkedChargeId].filter(Boolean) as string[]),
  );
  for (const charge of charges) {
    if (charge.linkedChargeId && selectedIds.has(charge.linkedChargeId)) selectedIds.add(charge.id);
  }
  return charges
    .filter((charge) => selectedIds.has(charge.id))
    .map((charge) => ({ chargeId: charge.id, fromFolioId: charge.folioId, toFolioId: destinationFolioId }));
}

export function canDeleteFolio(input: {
  chargeCount: number;
  paymentAllocationCount: number;
  depositActivityCount: number;
}) {
  return input.chargeCount === 0 && input.paymentAllocationCount === 0 && input.depositActivityCount === 0;
}

export function remainingDepositCents(
  originalAmountCents: number,
  transactions: readonly { type: "release" | "charge"; amountCents: number }[],
) {
  return Math.max(0, originalAmountCents - transactions.reduce((sum, item) => sum + item.amountCents, 0));
}

export type InvoiceBalance = { invoiceId: string; dueDate: string; balanceCents: number };

export function allocateCompanyPayment(amountCents: number, invoices: readonly InvoiceBalance[]) {
  let unallocatedCents = Math.max(0, amountCents);
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  for (const invoice of [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    const amount = Math.min(Math.max(0, invoice.balanceCents), unallocatedCents);
    if (amount > 0) allocations.push({ invoiceId: invoice.invoiceId, amountCents: amount });
    unallocatedCents -= amount;
    if (unallocatedCents === 0) break;
  }
  return { allocations, companyCreditCents: unallocatedCents };
}

export function nightAuditBlockers(input: {
  unpaidDepartureCount: number;
  unresolvedDepositCount: number;
  openCashShiftCount: number;
  unresolvedOperationalIssueCount: number;
}) {
  const blockers: string[] = [];
  if (input.unpaidDepartureCount) blockers.push("UNPAID_DEPARTURES");
  if (input.unresolvedDepositCount) blockers.push("UNRESOLVED_DEPOSITS");
  if (input.openCashShiftCount) blockers.push("OPEN_CASH_SHIFTS");
  if (input.unresolvedOperationalIssueCount) blockers.push("OPERATIONAL_ISSUES");
  return blockers;
}

export function planNoShow(input: {
  currentStatus: string;
  requestedFeeCents?: number;
  amountPaidCents?: number;
  reservationRoomIds: readonly string[];
}) {
  if (input.currentStatus !== "Reserved") {
    return { allowed: false, reason: "NOT_RESERVED" as const };
  }
  const feeCents = Math.max(0, Math.round(input.requestedFeeCents ?? 0));
  return {
    allowed: true,
    status: "No Show" as const,
    feeCents,
    balanceCents: Math.max(0, feeCents - Math.max(0, input.amountPaidCents ?? 0)),
    releasedReservationRoomIds: [...input.reservationRoomIds],
  };
}

export function planCancellation(input: {
  currentStatus: string;
  requestedFeeCents?: number;
  amountPaidCents?: number;
  reservationRoomIds: readonly string[];
}) {
  if (input.currentStatus !== "Reserved") return { allowed: false, reason: "NOT_RESERVED" as const };
  return {
    allowed: true,
    status: "Cancelled" as const,
    feeCents: Math.max(0, Math.round(input.requestedFeeCents ?? 0)),
    balanceCents: Math.max(0, Math.round(input.requestedFeeCents ?? 0) - Math.max(0, input.amountPaidCents ?? 0)),
    releasedReservationRoomIds: [...input.reservationRoomIds],
  };
}

export function planReservationReinstatement(input: {
  currentStatus: string;
  requestedRoomCount: number;
  availableRoomCount: number;
  assignedRoomNumbers?: readonly string[];
  unavailableAssignedRoomNumbers?: readonly string[];
}) {
  if (input.currentStatus !== "Cancelled" && input.currentStatus !== "No Show") {
    return { allowed: false, reason: "NOT_RELEASED" as const };
  }
  const unavailableRooms = [...new Set(input.unavailableAssignedRoomNumbers ?? [])];
  if (unavailableRooms.length > 0) {
    return { allowed: false, reason: "ASSIGNED_ROOM_UNAVAILABLE" as const, unavailableRooms };
  }
  if (input.requestedRoomCount < 1 || input.availableRoomCount < input.requestedRoomCount) {
    return {
      allowed: false,
      reason: "ROOM_TYPE_SOLD_OUT" as const,
      requestedRoomCount: input.requestedRoomCount,
      availableRoomCount: Math.max(0, input.availableRoomCount),
    };
  }
  return {
    allowed: true,
    status: "Reserved" as const,
    restoredRoomStatuses: (input.assignedRoomNumbers ?? []).map((roomNumber) => ({ roomNumber, status: "Reserved" as const })),
  };
}
