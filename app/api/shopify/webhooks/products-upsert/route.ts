import { NextResponse } from "next/server";
import {
  appendPendingShopifyUpserts,
  type PendingShopifyUpsertRecord,
} from "@/lib/operator-store";
import { extractShopifyLegacyId } from "@/lib/shopify-offer-id";
import { isValidShopifyWebhookRequest } from "@/lib/shopify";

interface ShopifyProductsUpsertWebhookPayload {
  id?: string | number | null;
  title?: string | null;
  handle?: string | null;
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

  if (topic !== "products/create" && topic !== "products/update") {
    return new NextResponse("Unexpected Shopify webhook topic.", { status: 202 });
  }

  let payload: ShopifyProductsUpsertWebhookPayload;

  try {
    payload = JSON.parse(rawBody) as ShopifyProductsUpsertWebhookPayload;
  } catch {
    return new NextResponse("Invalid Shopify webhook JSON payload.", { status: 400 });
  }

  const productId = extractShopifyLegacyId(payload.id);

  if (!productId) {
    return NextResponse.json({
      ok: true,
      queuedUpserts: 0,
      reason: "No Shopify product ID was present in the webhook payload.",
    });
  }

  const queuedAt = new Date().toISOString();
  const entry = {
    productId,
    title: payload.title?.trim() || `Shopify product ${productId}`,
    handle: payload.handle?.trim() ?? "",
    reason: topic === "products/create" ? "shopify_create" : "shopify_update",
    queuedAt,
    source: "shopify_webhook",
    topic,
    webhookId: request.headers.get("x-shopify-webhook-id"),
    eventId: request.headers.get("x-shopify-event-id"),
    triggeredAt: request.headers.get("x-shopify-triggered-at"),
    shopDomain: request.headers.get("x-shopify-shop-domain"),
  } satisfies PendingShopifyUpsertRecord;

  await appendPendingShopifyUpserts([entry]);

  return NextResponse.json({
    ok: true,
    queuedUpserts: 1,
  });
}
