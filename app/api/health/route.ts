import { NextResponse } from "next/server";
import { env, getConfigurationStatus } from "@/lib/env";
import {
  getRuntimeShopifyConnection,
  getShopifyConfigurationStatus,
} from "@/lib/shopify";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const now = new Date();
  const shopifyConnection = await getRuntimeShopifyConnection();

  return NextResponse.json({
    ok: true,
    service: "dpp-product-feed-sync",
    timestamp: now.toISOString(),
    cadence: {
      cronScheduleUtc: "0 9 * * *",
      anchorDate: env.syncAnchorDate,
      deltaIntervalDays: env.deltaIntervalDays,
      fullIntervalDays: env.fullIntervalDays,
      defaultDryRun: env.defaultDryRun,
    },
    configuration: getConfigurationStatus(),
    integrations: {
      shopify: {
        ...getShopifyConfigurationStatus(),
        connection: shopifyConnection,
      },
    },
    nextDecision: decideSyncMode(now),
  });
}
