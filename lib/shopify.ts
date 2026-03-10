import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { env, hasEnvValue } from "@/lib/env";

const SHOPIFY_STATE_COOKIE = "shopify_oauth_state";
const SHOPIFY_CONNECTED_SHOP_COOKIE = "shopify_connected_shop";
const SHOPIFY_VERIFIED_AT_COOKIE = "shopify_verified_at";
const shopDomainPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export interface ShopifyConnectionCheck {
  connected: boolean;
  shop?: {
    name: string;
    myshopifyDomain: string;
    primaryDomainUrl: string | null;
  };
  error?: string;
}

interface ShopifyTokenResponse {
  access_token: string;
  scope?: string;
}

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export function getShopifyCookieNames() {
  return {
    state: SHOPIFY_STATE_COOKIE,
    connectedShop: SHOPIFY_CONNECTED_SHOP_COOKIE,
    verifiedAt: SHOPIFY_VERIFIED_AT_COOKIE,
  };
}

export function normalizeShopDomain(value?: string | null) {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const withSuffix = normalized.includes(".")
    ? normalized
    : `${normalized}.myshopify.com`;

  return shopDomainPattern.test(withSuffix) ? withSuffix : null;
}

export function getConfiguredShopDomain() {
  return normalizeShopDomain(env.shopifyStoreDomain);
}

export function getRequestedShopDomain(request: NextRequest) {
  return (
    normalizeShopDomain(request.nextUrl.searchParams.get("shop")) ??
    getConfiguredShopDomain()
  );
}

export function getAppOrigin(request?: NextRequest) {
  if (hasEnvValue(env.appUrl)) {
    return env.appUrl.replace(/\/$/, "");
  }

  return request?.nextUrl.origin ?? "http://localhost:3000";
}

export function getShopifyCallbackUrl(request?: NextRequest) {
  return `${getAppOrigin(request)}/api/shopify/callback`;
}

export function getShopifyAuthStartUrl(request?: NextRequest) {
  return `${getAppOrigin(request)}/api/shopify/install`;
}

export function getShopifyScopes() {
  return env.shopifyScopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
}

export function getShopifyConfigurationStatus() {
  const shop = getConfiguredShopDomain();

  return {
    appUrlConfigured: hasEnvValue(env.appUrl),
    shopConfigured: Boolean(shop),
    clientIdConfigured: hasEnvValue(env.shopifyClientId),
    clientSecretConfigured: hasEnvValue(env.shopifyClientSecret),
    adminTokenConfigured: hasEnvValue(env.shopifyAdminAccessToken),
    scopes: getShopifyScopes(),
    storeDomain: shop,
    callbackUrl: getShopifyCallbackUrl(),
    installUrl: getShopifyAuthStartUrl(),
  };
}

export function createOauthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function buildShopifyInstallUrl(params: {
  request?: NextRequest;
  shop: string;
  state: string;
}) {
  const searchParams = new URLSearchParams({
    client_id: env.shopifyClientId,
    scope: getShopifyScopes().join(","),
    redirect_uri: getShopifyCallbackUrl(params.request),
    state: params.state,
  });

  return `https://${params.shop}/admin/oauth/authorize?${searchParams.toString()}`;
}

function buildHmacMessage(searchParams: URLSearchParams) {
  return Array.from(searchParams.entries())
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function isValidShopifyCallback(request: NextRequest) {
  const providedHmac = request.nextUrl.searchParams.get("hmac");

  if (!providedHmac || !hasEnvValue(env.shopifyClientSecret)) {
    return false;
  }

  const message = buildHmacMessage(request.nextUrl.searchParams);
  const expectedHmac = crypto
    .createHmac("sha256", env.shopifyClientSecret)
    .update(message)
    .digest("hex");

  if (providedHmac.length !== expectedHmac.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(providedHmac, "utf8"),
    Buffer.from(expectedHmac, "utf8"),
  );
}

export async function exchangeCodeForAccessToken(params: {
  code: string;
  shop: string;
}) {
  const response = await fetch(
    `https://${params.shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: env.shopifyClientId,
        client_secret: env.shopifyClientSecret,
        code: params.code,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify token exchange failed: ${response.status} ${body}`);
  }

  return (await response.json()) as ShopifyTokenResponse;
}

export async function fetchShopConnectionDetails(params: {
  accessToken: string;
  shop: string;
}): Promise<ShopifyConnectionCheck> {
  const response = await fetch(
    `https://${params.shop}/admin/api/${env.shopifyApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": params.accessToken,
      },
      body: JSON.stringify({
        query: `
          query ShopIdentity {
            shop {
              name
              myshopifyDomain
              primaryDomain {
                url
              }
            }
          }
        `,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const body = await response.text();

    return {
      connected: false,
      error: `Shopify connection test failed: ${response.status} ${body}`,
    };
  }

  const payload =
    (await response.json()) as ShopifyGraphqlResponse<{
      shop?: {
        name: string;
        myshopifyDomain: string;
        primaryDomain?: { url?: string | null } | null;
      };
    }>;

  if (payload.errors?.length) {
    return {
      connected: false,
      error: payload.errors.map((entry) => entry.message).join("; "),
    };
  }

  if (!payload.data?.shop) {
    return {
      connected: false,
      error: "Shopify returned no shop payload.",
    };
  }

  return {
    connected: true,
    shop: {
      name: payload.data.shop.name,
      myshopifyDomain: payload.data.shop.myshopifyDomain,
      primaryDomainUrl: payload.data.shop.primaryDomain?.url ?? null,
    },
  };
}

export async function getRuntimeShopifyConnection() {
  const shop = getConfiguredShopDomain();

  if (!shop || !hasEnvValue(env.shopifyAdminAccessToken)) {
    return {
      connected: false,
      error: "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN.",
    } satisfies ShopifyConnectionCheck;
  }

  return fetchShopConnectionDetails({
    shop,
    accessToken: env.shopifyAdminAccessToken,
  });
}
