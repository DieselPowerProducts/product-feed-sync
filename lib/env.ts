import type { NextRequest } from "next/server";

const truthy = new Set(["1", "true", "yes", "on"]);
const falsy = new Set(["0", "false", "no", "off"]);

function hasValue(value?: string) {
  return Boolean(value?.trim());
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();

  if (truthy.has(normalized)) {
    return true;
  }

  if (falsy.has(normalized)) {
    return false;
  }

  return fallback;
}

export const env = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  manualSyncToken: process.env.MANUAL_SYNC_TOKEN ?? "",
  syncAnchorDate: process.env.SYNC_ANCHOR_DATE ?? "2026-03-10",
  deltaIntervalDays: readPositiveInteger(
    process.env.SYNC_DELTA_INTERVAL_DAYS,
    7,
  ),
  fullIntervalDays: readPositiveInteger(process.env.SYNC_FULL_INTERVAL_DAYS, 14),
  defaultDryRun: readBoolean(process.env.SYNC_DEFAULT_DRY_RUN, true),
  lookbackDays: readPositiveInteger(process.env.SYNC_LOOKBACK_DAYS, 8),
  shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN ?? "",
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID ?? "",
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? "",
  shopifyAdminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "",
  shopifyAuthMode: process.env.SHOPIFY_AUTH_MODE ?? "client_credentials",
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-01",
  shopifyScopes:
    process.env.SHOPIFY_SCOPES ??
    "read_inventory,read_metaobjects,read_products",
  googleMerchantAccountId: process.env.GOOGLE_MERCHANT_ACCOUNT_ID ?? "",
  googleMerchantDataSource: process.env.GOOGLE_MERCHANT_DATA_SOURCE ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "",
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "",
  googleServiceAccountPrivateKey:
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "",
};

export function getConfigurationStatus() {
  const shopifyClientCredentialsConfigured =
    hasValue(env.shopifyStoreDomain) &&
    hasValue(env.shopifyClientId) &&
    hasValue(env.shopifyClientSecret);

  const shopifyAdminTokenConfigured = hasValue(env.shopifyAdminAccessToken);

  const shopifyReady =
    shopifyClientCredentialsConfigured || shopifyAdminTokenConfigured;

  const googleReady =
    hasValue(env.googleMerchantAccountId) &&
    hasValue(env.googleMerchantDataSource) &&
    ((hasValue(env.googleClientId) &&
      hasValue(env.googleClientSecret) &&
      hasValue(env.googleRefreshToken)) ||
      (hasValue(env.googleServiceAccountEmail) &&
        hasValue(env.googleServiceAccountPrivateKey)));

  return {
    appUrl: hasValue(env.appUrl),
    cronSecret: hasValue(env.cronSecret),
    manualSyncToken: hasValue(env.manualSyncToken),
    shopifyReady,
    shopifyClientCredentialsConfigured,
    shopifyAdminTokenConfigured,
    googleReady,
  };
}

export function isAuthorizedCronRequest(request: NextRequest) {
  if (!hasValue(env.cronSecret)) {
    return process.env.NODE_ENV !== "production";
  }

  return request.headers.get("authorization") === `Bearer ${env.cronSecret}`;
}

export function isAuthorizedManualRequest(request: NextRequest) {
  if (!hasValue(env.manualSyncToken)) {
    return process.env.NODE_ENV !== "production";
  }

  const authorization = request.headers.get("authorization");
  const headerToken = request.headers.get("x-manual-sync-token");

  return (
    authorization === `Bearer ${env.manualSyncToken}` ||
    headerToken === env.manualSyncToken
  );
}

export function readDryRunValue(value: string | null) {
  if (!value) {
    return env.defaultDryRun;
  }

  return readBoolean(value, env.defaultDryRun);
}

export function hasEnvValue(value?: string | null) {
  return hasValue(value ?? undefined);
}
