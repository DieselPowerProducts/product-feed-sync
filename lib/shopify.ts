import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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
  expires_in?: number;
}

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable?: number;
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
}

interface ShopifyWebhookSubscriptionNode {
  id: string;
  topic: string;
  uri: string | null;
}

interface ShopifyWebhookSubscriptionsPayload {
  webhookSubscriptions?: {
    edges?: Array<{
      node?: ShopifyWebhookSubscriptionNode | null;
    }>;
  } | null;
}

interface ShopifyWebhookSubscriptionCreatePayload {
  webhookSubscriptionCreate?: {
    webhookSubscription?: ShopifyWebhookSubscriptionNode | null;
    userErrors?: Array<{
      field?: string[] | null;
      message: string;
    }> | null;
  } | null;
}

export interface ShopifyRuntimeToken {
  accessToken: string;
  source: "env" | "client_credentials";
  scope?: string;
  expiresIn?: number | null;
}

export interface ShopifyGraphqlMetric {
  operationName: string;
  status: number;
  durationMs: number;
  requestedCost: number | null;
  actualCost: number | null;
  throttleAvailable: number | null;
  throttleMax: number | null;
  restoreRate: number | null;
}

export interface ShopifyGraphqlOperationSummary {
  operationName: string;
  calls: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  averageActualCost: number | null;
  maxActualCost: number | null;
  latestThrottleAvailable: number | null;
  throttleMax: number | null;
  restoreRate: number | null;
}

export interface ShopifyGraphqlDiagnosticsSummary {
  totalRequests: number;
  totalDurationMs: number;
  operations: ShopifyGraphqlOperationSummary[];
}

const shopifyGraphqlMetricsStore = new AsyncLocalStorage<ShopifyGraphqlMetric[]>();

function summarizeShopifyGraphqlMetrics(
  metrics: ShopifyGraphqlMetric[],
): ShopifyGraphqlDiagnosticsSummary {
  const groups = new Map<string, ShopifyGraphqlMetric[]>();

  for (const metric of metrics) {
    const existing = groups.get(metric.operationName);

    if (existing) {
      existing.push(metric);
      continue;
    }

    groups.set(metric.operationName, [metric]);
  }

  return {
    totalRequests: metrics.length,
    totalDurationMs: metrics.reduce((sum, metric) => sum + metric.durationMs, 0),
    operations: Array.from(groups.entries())
      .map(([operationName, entries]) => {
        const totalDurationMs = entries.reduce(
          (sum, entry) => sum + entry.durationMs,
          0,
        );
        const actualCosts = entries
          .map((entry) => entry.actualCost)
          .filter((value): value is number => typeof value === "number");
        const latest = entries[entries.length - 1];

        return {
          operationName,
          calls: entries.length,
          totalDurationMs,
          averageDurationMs: totalDurationMs / entries.length,
          maxDurationMs: Math.max(...entries.map((entry) => entry.durationMs)),
          averageActualCost: actualCosts.length
            ? actualCosts.reduce((sum, value) => sum + value, 0) /
              actualCosts.length
            : null,
          maxActualCost: actualCosts.length ? Math.max(...actualCosts) : null,
          latestThrottleAvailable: latest?.throttleAvailable ?? null,
          throttleMax: latest?.throttleMax ?? null,
          restoreRate: latest?.restoreRate ?? null,
        } satisfies ShopifyGraphqlOperationSummary;
      })
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs),
  };
}

export async function captureShopifyGraphqlDiagnostics<T>(run: () => Promise<T>) {
  return shopifyGraphqlMetricsStore.run([], async () => {
    const result = await run();
    const metrics = shopifyGraphqlMetricsStore.getStore() ?? [];

    return {
      result,
      diagnostics: summarizeShopifyGraphqlMetrics(metrics),
    };
  });
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

export function getShopifyProductsDeleteWebhookUrl(request?: NextRequest) {
  return `${getAppOrigin(request)}/api/shopify/webhooks/products-delete`;
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
    authMode: env.shopifyAuthMode,
    shopConfigured: Boolean(shop),
    clientIdConfigured: hasEnvValue(env.shopifyClientId),
    clientSecretConfigured: hasEnvValue(env.shopifyClientSecret),
    adminTokenConfigured: hasEnvValue(env.shopifyAdminAccessToken),
    scopes: getShopifyScopes(),
    storeDomain: shop,
    callbackUrl: getShopifyCallbackUrl(),
    installUrl: getShopifyAuthStartUrl(),
    productsDeleteWebhookUrl: getShopifyProductsDeleteWebhookUrl(),
  };
}

export function isValidShopifyWebhookRequest(rawBody: string, hmacHeader: string | null) {
  if (!hmacHeader || !hasEnvValue(env.shopifyClientSecret)) {
    return false;
  }

  const expectedHmac = crypto
    .createHmac("sha256", env.shopifyClientSecret)
    .update(rawBody, "utf8")
    .digest("base64");

  if (expectedHmac.length !== hmacHeader.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedHmac, "utf8"),
    Buffer.from(hmacHeader, "utf8"),
  );
}

function connectionNodes<T>(connection: {
  edges?: Array<{
    node?: T | null;
  }>;
} | null | undefined) {
  return (
    connection?.edges?.flatMap((edge) => (edge.node ? [edge.node] : [])) ?? []
  );
}

export async function getShopifyProductsDeleteWebhookStatus() {
  const uri = getShopifyProductsDeleteWebhookUrl();
  const payload = await runShopifyAdminGraphql<ShopifyWebhookSubscriptionsPayload>({
    query: `
      query ProductDeleteWebhookSubscriptions {
        webhookSubscriptions(first: 25, topics: PRODUCTS_DELETE) {
          edges {
            node {
              id
              topic
              uri
            }
          }
        }
      }
    `,
  });
  const subscriptions = connectionNodes(payload.webhookSubscriptions);
  const matchingSubscription =
    subscriptions.find((subscription) => subscription.uri === uri) ?? null;

  return {
    uri,
    registered: Boolean(matchingSubscription),
    subscriptionId: matchingSubscription?.id ?? null,
    subscriptions,
  };
}

export async function ensureShopifyProductsDeleteWebhook() {
  const current = await getShopifyProductsDeleteWebhookStatus();

  if (current.registered) {
    return current;
  }

  const uri = getShopifyProductsDeleteWebhookUrl();
  const payload =
    await runShopifyAdminGraphql<ShopifyWebhookSubscriptionCreatePayload>({
      query: `
        mutation EnsureProductDeleteWebhook(
          $topic: WebhookSubscriptionTopic!
          $webhookSubscription: WebhookSubscriptionInput!
        ) {
          webhookSubscriptionCreate(
            topic: $topic
            webhookSubscription: $webhookSubscription
          ) {
            webhookSubscription {
              id
              topic
              uri
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        topic: "PRODUCTS_DELETE",
        webhookSubscription: {
          uri,
        },
      },
    });
  const userErrors = payload.webhookSubscriptionCreate?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(
      `Shopify webhook registration failed: ${userErrors
        .map((error) =>
          error.field?.length
            ? `${error.field.join(".")}: ${error.message}`
            : error.message,
        )
        .join("; ")}`,
    );
  }

  return {
    uri,
    registered: true,
    subscriptionId: payload.webhookSubscriptionCreate?.webhookSubscription?.id ?? null,
    subscriptions: payload.webhookSubscriptionCreate?.webhookSubscription
      ? [payload.webhookSubscriptionCreate.webhookSubscription]
      : [],
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

export async function exchangeClientCredentialsForAccessToken(params: {
  shop: string;
}) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.shopifyClientId,
    client_secret: env.shopifyClientSecret,
  });

  const response = await fetch(
    `https://${params.shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(
      `Shopify client credentials exchange failed: ${response.status} ${payload}`,
    );
  }

  return (await response.json()) as ShopifyTokenResponse;
}

export async function fetchShopConnectionDetails(params: {
  accessToken: string;
  shop: string;
}): Promise<ShopifyConnectionCheck> {
  try {
    const payload = await runShopifyAdminGraphql<{
      shop?: {
        name: string;
        myshopifyDomain: string;
        primaryDomain?: { url?: string | null } | null;
      };
    }>({
      shop: params.shop,
      accessToken: params.accessToken,
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
    });

    if (!payload.shop) {
      return {
        connected: false,
        error: "Shopify returned no shop payload.",
      };
    }

    return {
      connected: true,
      shop: {
        name: payload.shop.name,
        myshopifyDomain: payload.shop.myshopifyDomain,
        primaryDomainUrl: payload.shop.primaryDomain?.url ?? null,
      },
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Unknown Shopify error.",
    };
  }
}

export async function getRuntimeShopifyConnection() {
  const token = await getRuntimeShopifyAccessToken();

  if (!token) {
    return {
      connected: false,
      error:
        "Missing Shopify runtime credentials. Provide SHOPIFY_ADMIN_ACCESS_TOKEN or configure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET for client credentials mode.",
    } satisfies ShopifyConnectionCheck;
  }

  return fetchShopConnectionDetails({
    shop: getConfiguredShopDomain()!,
    accessToken: token.accessToken,
  });
}

export async function getRuntimeShopifyAccessToken(): Promise<ShopifyRuntimeToken | null> {
  const shop = getConfiguredShopDomain();

  if (!shop) {
    return null;
  }

  if (hasEnvValue(env.shopifyAdminAccessToken)) {
    return {
      accessToken: env.shopifyAdminAccessToken,
      source: "env",
      expiresIn: null,
    };
  }

  if (
    env.shopifyAuthMode !== "oauth" &&
    hasEnvValue(env.shopifyClientId) &&
    hasEnvValue(env.shopifyClientSecret)
  ) {
    const token = await exchangeClientCredentialsForAccessToken({
      shop,
    });

    return {
      accessToken: token.access_token,
      source: "client_credentials",
      scope: token.scope,
      expiresIn: token.expires_in ?? null,
    };
  }

  return null;
}

export async function runShopifyAdminGraphql<T>(params: {
  query: string;
  variables?: Record<string, unknown>;
  shop?: string;
  accessToken?: string;
}) {
  const startedAt = Date.now();
  const shop = params.shop ?? getConfiguredShopDomain();

  if (!shop) {
    throw new Error(
      "Missing or invalid Shopify store domain. Set SHOPIFY_STORE_DOMAIN.",
    );
  }

  const accessToken =
    params.accessToken ?? (await getRuntimeShopifyAccessToken())?.accessToken;

  if (!accessToken) {
    throw new Error(
      "Missing Shopify runtime credentials. Provide SHOPIFY_ADMIN_ACCESS_TOKEN or configure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET for client credentials mode.",
    );
  }

  const response = await fetch(
    `https://${shop}/admin/api/${env.shopifyApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: params.query,
        variables: params.variables ?? {},
      }),
      cache: "no-store",
    },
  );

  const body = await response.text();
  const durationMs = Date.now() - startedAt;
  const payload = body
    ? (JSON.parse(body) as ShopifyGraphqlResponse<T>)
    : ({} as ShopifyGraphqlResponse<T>);
  const operationMatch = params.query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
  const operationName = operationMatch?.[2] ?? "anonymous";
  const cost = payload.extensions?.cost;

  if (cost) {
    const throttle = cost.throttleStatus;
    console.info(
      `[shopify-graphql] ${operationName} status=${response.status} duration_ms=${durationMs} requested_cost=${cost.requestedQueryCost ?? "unknown"} actual_cost=${cost.actualQueryCost ?? "unknown"} throttle_available=${throttle?.currentlyAvailable ?? "unknown"} throttle_max=${throttle?.maximumAvailable ?? "unknown"} restore_rate=${throttle?.restoreRate ?? "unknown"}`,
    );
  } else {
    console.info(
      `[shopify-graphql] ${operationName} status=${response.status} duration_ms=${durationMs}`,
    );
  }

  const metrics = shopifyGraphqlMetricsStore.getStore();

  if (metrics) {
    metrics.push({
      operationName,
      status: response.status,
      durationMs,
      requestedCost: cost?.requestedQueryCost ?? null,
      actualCost: cost?.actualQueryCost ?? null,
      throttleAvailable: cost?.throttleStatus?.currentlyAvailable ?? null,
      throttleMax: cost?.throttleStatus?.maximumAvailable ?? null,
      restoreRate: cost?.throttleStatus?.restoreRate ?? null,
    });
  }

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed: ${response.status} ${body}`);
  }

  if (payload.errors?.length) {
    throw new Error(
      `Shopify GraphQL returned errors: ${payload.errors
        .map((entry) => entry.message)
        .join("; ")}`,
    );
  }

  if (!payload.data) {
    throw new Error("Shopify GraphQL returned no data.");
  }

  return payload.data;
}
