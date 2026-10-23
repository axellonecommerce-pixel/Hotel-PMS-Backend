type AvailabilityRoomType = {
  id: string;
  baseRateCents?: number;
};

type AvailabilityRateCode = {
  rateAdjustmentPercent?: number;
  roomTypeRates?: Record<string, {
    nightlyRateCents?: number;
    additionalAdultCents?: number;
    childCents?: number;
  }>;
};

/**
 * Computes the sellable nightly amount for one configured room type. An
 * explicit zero is a valid contract rate and must not fall back to the base.
 */
export function calculateAvailabilityRateCents(
  roomType: AvailabilityRoomType,
  rateCode: AvailabilityRateCode | undefined,
  adults: number,
  children: number,
) {
  const configured = rateCode?.roomTypeRates?.[roomType.id];
  const baseRate = configured?.nightlyRateCents ?? Math.round((roomType.baseRateCents ?? 0) * (1 + (rateCode?.rateAdjustmentPercent ?? 0) / 100));
  return Math.max(0, baseRate + Math.max(0, adults - 1) * (configured?.additionalAdultCents ?? 0) + Math.max(0, children) * (configured?.childCents ?? 0));
}
