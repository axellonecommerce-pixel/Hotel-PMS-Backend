export type ConfiguredRateCode = {
  name: string;
  active?: boolean;
};

/**
 * Properties created before configurable rate codes existed can continue to
 * use RACK. Once a property has configured codes, only an active code from
 * that property may be used for a reservation.
 */
export function canUseRateCode(rateCodeName: string, rateCodes: ConfiguredRateCode[]) {
  if (!rateCodes.length) return rateCodeName === "RACK";
  return rateCodes.some((rateCode) => rateCode.name === rateCodeName && rateCode.active !== false);
}
