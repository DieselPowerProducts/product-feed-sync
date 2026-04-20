import { NextResponse } from "next/server";
import {
  getRuntimeShopifyConnection,
  getShopifyProductsDeleteWebhookStatus,
  getShopifyConfigurationStatus,
  getRuntimeShopifyAccessToken,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = getShopifyConfigurationStatus();
  const token = await getRuntimeShopifyAccessToken();
  const [connection, productsDeleteWebhook] = await Promise.all([
    getRuntimeShopifyConnection(),
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
      productsDelete: productsDeleteWebhook,
    },
  });
}
