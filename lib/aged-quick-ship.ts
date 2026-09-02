const MS_PER_DAY = 86_400_000;

export const AGED_QUICK_SHIP_LABEL = "aged quick ship";

export function isAgedQuickShip(params: {
  quickShipValue: string | null | undefined;
  lastOrderedAt: string | null | undefined;
  now?: Date;
}) {
  const quickShipQuantity = Number(params.quickShipValue?.trim());

  if (!Number.isFinite(quickShipQuantity) || quickShipQuantity < 1) {
    return false;
  }

  const lastOrderedAtMs = Date.parse(params.lastOrderedAt?.trim() ?? "");

  if (!Number.isFinite(lastOrderedAtMs)) {
    return false;
  }

  const nowMs = (params.now ?? new Date()).getTime();

  if (!Number.isFinite(nowMs)) {
    return false;
  }

  return nowMs - lastOrderedAtMs > 90 * MS_PER_DAY;
}

export function resolveAgedQuickShipCustomLabel0(params: {
  quickShipValue: string | null | undefined;
  lastOrderedAt: string | null | undefined;
  now?: Date;
}) {
  return isAgedQuickShip(params) ? AGED_QUICK_SHIP_LABEL : null;
}
