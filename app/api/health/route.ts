import { NextResponse } from "next/server";
import { getConfigurationStatus } from "@/lib/env";
import { getGoogleMerchantConnectionStatus } from "@/lib/google-merchant";
import {
  getOperatorStoreStatus,
  getPendingShopifyDeletes,
  getSyncSettings,
} from "@/lib/operator-store";
import {
  getRuntimeShopifyConnection,
  getShopifyProductsDeleteWebhookStatus,
  getShopifyConfigurationStatus,
} from "@/lib/shopify";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const now = new Date();
  const [settings, googleMerchant, pendingHardDeletes, productsDeleteWebhook] =
    await Promise.all([
    getSyncSettings(),
    getGoogleMerchantConnectionStatus(),
    getPendingShopifyDeletes(),
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
        pendingHardDeletes: pendingHardDeletes.length,
        webhooks: {
          productsDelete: productsDeleteWebhook,
        },
      },
      googleMerchant,
    },
    nextDecision: decideSyncMode(now, settings),
  });
}
