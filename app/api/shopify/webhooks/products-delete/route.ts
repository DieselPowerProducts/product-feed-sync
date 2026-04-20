import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  appendPendingShopifyDeletes,
  type PendingShopifyDeleteRecord,
} from "@/lib/operator-store";
import { buildShopifyOfferId, extractShopifyLegacyId } from "@/lib/shopify-offer-id";
import { isValidShopifyWebhookRequest } from "@/lib/shopify";

interface ShopifyDeletedVariantPayload {
  id?: string | number | null;
  title?: string | null;
  sku?: string | null;
  admin_graphql_api_id?: string | null;
}

interface ShopifyDeletedVariantGidPayload {
  admin_graphql_api_id?: string | null;
}

interface ShopifyProductsDeleteWebhookPayload {
  id?: string | number | null;
  title?: string | null;
  handle?: string | null;
  variants?: ShopifyDeletedVariantPayload[] | null;
  variant_gids?: ShopifyDeletedVariantGidPayload[] | null;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

  if (!isValidShopifyWebhookRequest(rawBody, hmacHeader)) {
    return new NextResponse("Invalid Shopify webhook signature.", { status: 401 });
  }

  const topic = request.headers.get("x-shopify-topic");

  if (topic !== "products/delete") {
    return new NextResponse("Unexpected Shopify webhook topic.", { status: 202 });
  }

  let payload: ShopifyProductsDeleteWebhookPayload;

  try {
    payload = JSON.parse(rawBody) as ShopifyProductsDeleteWebhookPayload;
  } catch {
    return new NextResponse("Invalid Shopify webhook JSON payload.", { status: 400 });
  }

  const productId = extractShopifyLegacyId(payload.id);

  if (!productId) {
    return NextResponse.json({
      ok: true,
      queuedDeletes: 0,
      reason: "No Shopify product ID was present in the webhook payload.",
    });
  }

  const variantMetaById = new Map<
    string,
    {
      title: string | null;
      sku: string | null;
    }
  >();
  const variantIds = new Set<string>();

  for (const variant of payload.variants ?? []) {
    const variantId =
      extractShopifyLegacyId(variant.id) ??
      extractShopifyLegacyId(variant.admin_graphql_api_id);

    if (!variantId) {
      continue;
    }

    variantIds.add(variantId);
    variantMetaById.set(variantId, {
      title: variant.title ?? null,
      sku: variant.sku ?? null,
    });
  }

  for (const variant of payload.variant_gids ?? []) {
    const variantId = extractShopifyLegacyId(variant.admin_graphql_api_id);

    if (variantId) {
      variantIds.add(variantId);
    }
  }

  const queuedAt = new Date().toISOString();
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const entries: PendingShopifyDeleteRecord[] = Array.from(variantIds).map(
    (variantId) => {
      const variantMeta = variantMetaById.get(variantId);

      return {
        offerId: buildShopifyOfferId(productId, variantId),
        contentLanguage: env.googleContentLanguage || "en",
        feedLabel: env.googleFeedLabel || "US",
        reason: "shopify_hard_delete",
        productId,
        variantId,
        title: payload.title?.trim() || `Deleted Shopify product ${productId}`,
        variantTitle: variantMeta?.title ?? null,
        handle: payload.handle?.trim() ?? "",
        sku: variantMeta?.sku ?? null,
        link: null,
        queuedAt,
        source: "shopify_webhook",
        webhookId,
        shopDomain,
      };
    },
  );

  await appendPendingShopifyDeletes(entries);

  return NextResponse.json({
    ok: true,
    queuedDeletes: entries.length,
  });
}
