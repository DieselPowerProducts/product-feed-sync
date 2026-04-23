import { NextResponse } from "next/server";
import {
  getRuntimeShopifyConnection,
  getShopifyProductsCreateWebhookStatus,
  getShopifyProductsDeleteWebhookStatus,
  getShopifyProductsUpdateWebhookStatus,
  getShopifyConfigurationStatus,
  getRuntimeShopifyAccessToken,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = getShopifyConfigurationStatus();
  const token = await getRuntimeShopifyAccessToken();
  const [connection, productsCreateWebhook, productsUpdateWebhook, productsDeleteWebhook] =
    await Promise.all([
    getRuntimeShopifyConnection(),
    getShopifyProductsCreateWebhookStatus().catch((error) => ({
      uri: configuration.productsUpsertWebhookUrl,
      registered: false,
      subscriptionId: null,
      subscriptions: [],
      error:
        error instanceof Error
          ? error.message
          : "Unknown Shopify webhook status error.",
    })),
    getShopifyProductsUpdateWebhookStatus().catch((error) => ({
      uri: configuration.productsUpsertWebhookUrl,
      registered: false,
      subscriptionId: null,
      subscriptions: [],
      error:
        error instanceof Error
          ? error.message
          : "Unknown Shopify webhook status error.",
    })),
    getShopifyProductsDeleteWebhookStatus().catch((error) => ({
      uri: configuration.productsDeleteWebhookUrl,
      registered: false,
      subscriptionId: null,
      subscriptions: [],
      error:
        error instanceof Error
          ? error.message
          : "Unknown Shopify webhook status error.",
    })),
  ]);

  return NextResponse.json({
    ok: connection.connected,
    configuration,
    token: token
      ? {
          source: token.source,
          scope: token.scope ?? null,
          expiresIn: token.expiresIn ?? null,
        }
      : null,
    connection,
    webhooks: {
      productsCreate: productsCreateWebhook,
      productsUpdate: productsUpdateWebhook,
      productsDelete: productsDeleteWebhook,
    },
  });
}
