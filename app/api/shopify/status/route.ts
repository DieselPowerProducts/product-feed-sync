import { NextResponse } from "next/server";
import {
  getRuntimeShopifyConnection,
  getShopifyConfigurationStatus,
  getRuntimeShopifyAccessToken,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = getShopifyConfigurationStatus();
  const token = await getRuntimeShopifyAccessToken();
  const connection = await getRuntimeShopifyConnection();

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
  });
}
