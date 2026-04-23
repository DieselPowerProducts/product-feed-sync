import { NextResponse } from "next/server";
import { getConfigurationStatus } from "@/lib/env";
import { getGoogleMerchantConnectionStatus } from "@/lib/google-merchant";
import {
  getOperatorStoreStatus,
  getPendingShopifyUpserts,
  getPendingShopifyDeletes,
  getSyncSettings,
} from "@/lib/operator-store";
import {
  getRuntimeShopifyConnection,
  getShopifyProductsCreateWebhookStatus,
  getShopifyProductsDeleteWebhookStatus,
  getShopifyProductsUpdateWebhookStatus,
  getShopifyConfigurationStatus,
} from "@/lib/shopify";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const now = new Date();
  const [
    settings,
    googleMerchant,
    pendingProductUpdates,
    pendingHardDeletes,
    productsCreateWebhook,
    productsUpdateWebhook,
    productsDeleteWebhook,
  ] =
    await Promise.all([
      getSyncSettings(),
      getGoogleMerchantConnectionStatus(),
      getPendingShopifyUpserts(),
      getPendingShopifyDeletes(),
      getShopifyProductsCreateWebhookStatus().catch((error) => ({
        uri: getShopifyConfigurationStatus().productsUpsertWebhookUrl,
        registered: false,
        subscriptionId: null,
        subscriptions: [],
        error:
          error instanceof Error
            ? error.message
            : "Unknown Shopify webhook status error.",
      })),
      getShopifyProductsUpdateWebhookStatus().catch((error) => ({
        uri: getShopifyConfigurationStatus().productsUpsertWebhookUrl,
        registered: false,
        subscriptionId: null,
        subscriptions: [],
        error:
          error instanceof Error
            ? error.message
            : "Unknown Shopify webhook status error.",
      })),
      getShopifyProductsDeleteWebhookStatus().catch((error) => ({
        uri: getShopifyConfigurationStatus().productsDeleteWebhookUrl,
        registered: false,
        subscriptionId: null,
        subscriptions: [],
        error:
          error instanceof Error
            ? error.message
            : "Unknown Shopify webhook status error.",
      })),
    ]);
  const shopifyConnection = await getRuntimeShopifyConnection();

  return NextResponse.json({
    ok: true,
    service: "dpp-product-feed-sync",
    timestamp: now.toISOString(),
    cadence: {
      cronSchedulesUtc: {
        sync: ["0 9 * * *", "0 10 * * *", "0 11 * * *", "0 12 * * *"],
      },
      anchorDate: settings.anchorDate,
      deltaIntervalDays: settings.deltaIntervalDays,
      fullIntervalDays: settings.fullIntervalDays,
    },
    configuration: getConfigurationStatus(),
    storage: getOperatorStoreStatus(),
    integrations: {
      shopify: {
        ...getShopifyConfigurationStatus(),
        connection: shopifyConnection,
        pendingProductUpdates: pendingProductUpdates.length,
        pendingHardDeletes: pendingHardDeletes.length,
        webhooks: {
          productsCreate: productsCreateWebhook,
          productsUpdate: productsUpdateWebhook,
          productsDelete: productsDeleteWebhook,
        },
      },
      googleMerchant,
    },
    nextDecision: decideSyncMode(now, settings),
  });
}
