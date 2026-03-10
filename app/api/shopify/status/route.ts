import { NextResponse } from "next/server";
import {
  getRuntimeShopifyConnection,
  getShopifyConfigurationStatus,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = getShopifyConfigurationStatus();
  const connection = await getRuntimeShopifyConnection();

  return NextResponse.json({
    ok: connection.connected,
    configuration,
    connection,
  });
}
