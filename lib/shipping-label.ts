export const FAST_FREE_PRICE_THRESHOLD = 199;

export function buildShippingLabel(params: {
  stateRestrictions: string | null;
  quickShip: boolean;
  priceAmount: number;
  override: string | null;
}) {
  const { stateRestrictions, quickShip, priceAmount, override } = params;

  if (override) {
    return override;
  }

  if (stateRestrictions) {
    return stateRestrictions;
  }

  if (quickShip && priceAmount > FAST_FREE_PRICE_THRESHOLD) {
    return "fast_free";
  }

  return "Standard";
}
