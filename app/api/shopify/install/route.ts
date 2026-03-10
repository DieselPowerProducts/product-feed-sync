import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env, hasEnvValue } from "@/lib/env";
import {
  buildShopifyInstallUrl,
  createOauthState,
  getRequestedShopDomain,
  getShopifyCookieNames,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const shop = getRequestedShopDomain(request);

  if (!shop) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing or invalid Shopify store domain. Set SHOPIFY_STORE_DOMAIN or pass ?shop=your-store.myshopify.com.",
      },
      { status: 400 },
    );
  }

  if (
    !hasEnvValue(env.shopifyClientId) ||
    !hasEnvValue(env.shopifyClientSecret)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET in the environment.",
      },
      { status: 400 },
    );
  }

  const state = createOauthState();
  const response = NextResponse.redirect(
    buildShopifyInstallUrl({
      request,
      shop,
      state,
    }),
  );

  response.cookies.set(getShopifyCookieNames().state, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });

  return response;
}
