import { NextResponse } from "next/server";
import { getConfigurationStatus } from "@/lib/env";
import { getGoogleMerchantConnectionStatus } from "@/lib/google-merchant";
import { getOperatorStoreStatus, getSyncSettings } from "@/lib/operator-store";
import {
  getRuntimeShopifyConnection,
  getShopifyConfigurationStatus,
} from "@/lib/shopify";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const now = new Date();
  const [settings, googleMerchant] = await Promise.all([
    getSyncSettings(),
    getGoogleMerchantConnectionStatus(),
  ]);
  const shopifyConnection = await getRuntimeShopifyConnection();

  return NextResponse.json({
    ok: true,
    service: "dpp-product-feed-sync",
    timestamp: now.toISOString(),
    cadence: {
      cronSchedulesUtc: {
        sync: ["0 9 * * *"],
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
      },
      googleMerchant,
    },
    nextDecision: decideSyncMode(now, settings),
  });
}
