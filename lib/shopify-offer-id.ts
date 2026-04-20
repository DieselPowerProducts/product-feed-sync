export function buildShopifyOfferId(productId: string, variantId: string) {
  return `shopify_ZZ_${productId}_${variantId}`;
}

export function parseShopifyOfferId(offerId: string) {
  const match = offerId.match(/^shopify_ZZ_(.+)_(.+)$/);

  return {
    productId: match?.[1] ?? "",
    variantId: match?.[2] ?? "",
  };
}

export function extractShopifyLegacyId(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const tail = trimmed.split("/").pop()?.trim() ?? "";

  return /^\d+$/.test(tail) ? tail : null;
}
