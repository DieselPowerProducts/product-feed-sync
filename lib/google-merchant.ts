import crypto from "node:crypto";
import { env, getConfigurationStatus, hasEnvValue } from "@/lib/env";

const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/content";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MERCHANT_API_BASE_URL = "https://merchantapi.googleapis.com";
const MERCHANT_LIST_PAGE_SIZE = 1000;
const MERCHANT_WRITE_CONCURRENCY = 24;
const MERCHANT_ERROR_SAMPLE_LIMIT = 50;
const MERCHANT_DELETE_SAMPLE_LIMIT = 250;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

type GoogleAuthMode = "oauth_refresh_token" | "service_account";

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
  cacheKey: string;
}

interface MerchantDataSourceResponse {
  name: string;
  dataSourceId?: string;
  displayName?: string;
  input?: string;
  primaryProductDataSource?: {
    feedLabel?: string;
    contentLanguage?: string;
    countries?: string[];
  };
}

interface MerchantProductsListResponse {
  products?: MerchantProcessedProduct[];
  nextPageToken?: string;
}

interface MerchantProcessedProduct {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  dataSource?: string;
}

interface MerchantApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export interface MerchantCustomAttribute {
  name: string;
  value: string;
}

export interface MerchantPriceValue {
  amountMicros: string;
  currencyCode: string;
}

export interface MerchantWeightValue {
  value: number;
  unit: string;
}

export interface MerchantProductInputRecord {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  customAttributes?: MerchantCustomAttribute[];
  productAttributes: {
    title: string;
    description: string;
    link: string;
    imageLink: string;
    additionalImageLinks?: string[];
    availability: "IN_STOCK" | "OUT_OF_STOCK";
    price: MerchantPriceValue;
    salePrice?: MerchantPriceValue | null;
    condition: "NEW";
    googleProductCategory?: string | null;
    productTypes?: string[];
    ageGroup?: string | null;
    color?: string | null;
    gender?: string | null;
    brand?: string | null;
    gtins?: string[];
    mpn?: string | null;
    identifierExists: boolean;
    itemGroupId: string;
    size?: string | null;
    sizeSystem?: string | null;
    customLabel0?: string | null;
    customLabel1?: string | null;
    customLabel2?: string | null;
    customLabel3?: string | null;
    customLabel4?: string | null;
    shippingWeight?: MerchantWeightValue | null;
    shippingLabel?: string | null;
    costOfGoodsSold?: MerchantPriceValue | null;
  };
}

export interface MerchantDeleteTarget {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  reason?: string | null;
  productId?: string | null;
  variantId?: string | null;
  title?: string | null;
  variantTitle?: string | null;
}

export interface MerchantSyncError {
  action: "insert" | "delete" | "list_products" | "get_data_source";
  offerId?: string | null;
  status: number | null;
  message: string;
}

export interface MerchantCatalogSyncSummary {
  accountName: string;
  dataSourceName: string;
  authMode: GoogleAuthMode;
  upsertsAttempted: number;
  upsertsSucceeded: number;
  deletesAttempted: number;
  deletesSucceeded: number;
  reconciliationDeletes: number;
  existingProductsScanned: number;
  errorCount: number;
  errors: MerchantSyncError[];
  deleteTargetsSample: MerchantDeleteTarget[];
  deleteTargetKeysSucceeded: string[];
}

export interface GoogleMerchantConnectionStatus {
  configured: boolean;
  connected: boolean;
  authMode: GoogleAuthMode | null;
  accountName: string | null;
  dataSourceName: string | null;
  dataSource: {
    name: string;
    displayName: string | null;
    input: string | null;
    feedLabel: string | null;
    contentLanguage: string | null;
    countries: string[];
  } | null;
  error?: string;
}

class MerchantApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MerchantApiError";
    this.status = status;
  }
}

let cachedAccessToken: CachedAccessToken | null = null;

function getGoogleAuthMode(): GoogleAuthMode | null {
  if (
    hasEnvValue(env.googleClientId) &&
    hasEnvValue(env.googleClientSecret) &&
    hasEnvValue(env.googleRefreshToken)
  ) {
    return "oauth_refresh_token";
  }

  if (
    hasEnvValue(env.googleServiceAccountEmail) &&
    hasEnvValue(env.googleServiceAccountPrivateKey)
  ) {
    return "service_account";
  }

  return null;
}

function getMerchantAccountName() {
  if (!hasEnvValue(env.googleMerchantAccountId)) {
    throw new Error("Missing GOOGLE_MERCHANT_ACCOUNT_ID.");
  }

  return env.googleMerchantAccountId.startsWith("accounts/")
    ? env.googleMerchantAccountId
    : `accounts/${env.googleMerchantAccountId}`;
}

function getMerchantDataSourceName() {
  if (!hasEnvValue(env.googleMerchantDataSource)) {
    throw new Error("Missing GOOGLE_MERCHANT_DATA_SOURCE.");
  }

  return env.googleMerchantDataSource.startsWith("accounts/")
    ? env.googleMerchantDataSource
    : `${getMerchantAccountName()}/dataSources/${env.googleMerchantDataSource}`;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n");
}

function encodeJwtSegment(input: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function getAccessTokenCacheKey(authMode: GoogleAuthMode) {
  if (authMode === "oauth_refresh_token") {
    return `oauth:${env.googleClientId}:${env.googleRefreshToken.slice(-8)}`;
  }

  return `service:${env.googleServiceAccountEmail}`;
}

async function requestOauthRefreshToken() {
  const body = new URLSearchParams({
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    refresh_token: env.googleRefreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Google OAuth refresh failed with status ${response.status}.`,
    );
  }

  return {
    accessToken: payload.access_token,
    expiresInSeconds: Number(payload.expires_in ?? 3600),
  };
}

async function requestServiceAccountToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeJwtSegment({
    alg: "RS256",
    typ: "JWT",
  });
  const payload = encodeJwtSegment({
    iss: env.googleServiceAccountEmail,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer
    .sign(normalizePrivateKey(env.googleServiceAccountPrivateKey))
    .toString("base64url");
  const assertion = `${header}.${payload}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  const tokenPayload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !tokenPayload.access_token) {
    throw new Error(
      tokenPayload.error_description ||
        tokenPayload.error ||
        `Google service-account token exchange failed with status ${response.status}.`,
    );
  }

  return {
    accessToken: tokenPayload.access_token,
    expiresInSeconds: Number(tokenPayload.expires_in ?? 3600),
  };
}

async function getGoogleAccessToken(forceRefresh = false) {
  const authMode = getGoogleAuthMode();

  if (!authMode) {
    throw new Error(
      "Missing Google Merchant credentials. Configure OAuth refresh-token credentials or a service account.",
    );
  }

  const cacheKey = getAccessTokenCacheKey(authMode);

  if (
    !forceRefresh &&
    cachedAccessToken &&
    cachedAccessToken.cacheKey === cacheKey &&
    Date.now() + TOKEN_REFRESH_SKEW_MS < cachedAccessToken.expiresAt
  ) {
    return {
      accessToken: cachedAccessToken.accessToken,
      authMode,
    };
  }

  const token =
    authMode === "oauth_refresh_token"
      ? await requestOauthRefreshToken()
      : await requestServiceAccountToken();

  cachedAccessToken = {
    accessToken: token.accessToken,
    expiresAt: Date.now() + token.expiresInSeconds * 1000,
    cacheKey,
  };

  return {
    accessToken: token.accessToken,
    authMode,
  };
}

function buildMerchantUrl(path: string, query?: Record<string, string | number | null | undefined>) {
  const url = new URL(path, MERCHANT_API_BASE_URL);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === "") {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function parseMerchantErrorMessage(status: number, body: string) {
  if (!body) {
    return `Merchant API request failed with status ${status}.`;
  }

  try {
    const parsed = JSON.parse(body) as MerchantApiErrorBody;

    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Fall through to the raw response body.
  }

  return body;
}

function getRetryDelayMs(response: Response, attempt: number) {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? "", 10);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  return Math.min(10_000, 750 * 2 ** attempt);
}

async function merchantRequest<T>(
  path: string,
  options?: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    query?: Record<string, string | number | null | undefined>;
    maxRetries?: number;
  },
) {
  const maxRetries = options?.maxRetries ?? 4;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const { accessToken } = await getGoogleAccessToken(attempt > 0);
    const response = await fetch(buildMerchantUrl(path, options?.query), {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options?.body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
            }),
      },
      body:
        options?.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });

    if (response.status === 401 && attempt < maxRetries) {
      cachedAccessToken = null;
      continue;
    }

    if (
      RETRYABLE_STATUS_CODES.has(response.status) &&
      attempt < maxRetries
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelayMs(response, attempt)),
      );
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new MerchantApiError(
        parseMerchantErrorMessage(response.status, body),
        response.status,
      );
    }

    if (response.status === 204) {
      return null as T;
    }

    return (await response.json()) as T;
  }

  throw new Error("Merchant API request exhausted all retry attempts.");
}

function prunePayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const nextValues = value
      .map((entry) => prunePayloadValue(entry))
      .filter((entry) => entry !== undefined);

    return nextValues.length ? nextValues : undefined;
  }

  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value).flatMap(([key, entry]) => {
      const nextValue = prunePayloadValue(entry);
      return nextValue === undefined ? [] : [[key, nextValue] as const];
    });

    return nextEntries.length ? Object.fromEntries(nextEntries) : undefined;
  }

  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  return value;
}

function buildProductInputPayload(record: MerchantProductInputRecord) {
  const payload = prunePayloadValue({
    offerId: record.offerId,
    contentLanguage: record.contentLanguage,
    feedLabel: record.feedLabel,
    productAttributes: record.productAttributes,
    customAttributes: record.customAttributes,
  });

  if (!payload || typeof payload !== "object") {
    throw new Error(`Invalid Merchant API payload for offer ${record.offerId}.`);
  }

  return payload;
}

function buildDeleteKey(target: Pick<MerchantDeleteTarget, "contentLanguage" | "feedLabel" | "offerId">) {
  return `${target.contentLanguage}~${target.feedLabel}~${target.offerId}`;
}

function buildProductInputName(
  target: Pick<MerchantDeleteTarget, "contentLanguage" | "feedLabel" | "offerId">,
) {
  const encodedProductInput = Buffer.from(
    buildDeleteKey(target),
    "utf8",
  ).toString("base64url");

  return `${getMerchantAccountName()}/productInputs/${encodedProductInput}`;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex] as T);
    }
  });

  await Promise.all(workers);
}

async function listConfiguredDataSourceProducts() {
  const accountName = getMerchantAccountName();
  const dataSourceName = getMerchantDataSourceName();
  const matches: MerchantDeleteTarget[] = [];
  let pageToken: string | null = null;

  do {
    const response: MerchantProductsListResponse =
      await merchantRequest<MerchantProductsListResponse>(
      `/products/v1/${accountName}/products`,
      {
        query: {
          pageSize: MERCHANT_LIST_PAGE_SIZE,
          pageToken,
        },
      },
    );

    for (const product of response.products ?? []) {
      if (product.dataSource !== dataSourceName) {
        continue;
      }

      matches.push({
        offerId: product.offerId,
        contentLanguage: product.contentLanguage,
        feedLabel: product.feedLabel,
        reason: "missing_from_full_catalog_reconciliation",
      });
    }

    pageToken = response.nextPageToken ?? null;
  } while (pageToken);

  return matches;
}

export async function getGoogleMerchantConnectionStatus(): Promise<GoogleMerchantConnectionStatus> {
  const configuration = getConfigurationStatus();
  const authMode = getGoogleAuthMode();
  const accountName = hasEnvValue(env.googleMerchantAccountId)
    ? getMerchantAccountName()
    : null;
  const dataSourceName = hasEnvValue(env.googleMerchantDataSource)
    ? getMerchantDataSourceName()
    : null;

  if (!configuration.googleReady || !accountName || !dataSourceName || !authMode) {
    return {
      configured: configuration.googleReady,
      connected: false,
      authMode,
      accountName,
      dataSourceName,
      dataSource: null,
      error: configuration.googleReady
        ? "Google Merchant configuration is incomplete."
        : undefined,
    };
  }

  try {
    const dataSource = await merchantRequest<MerchantDataSourceResponse>(
      `/datasources/v1/${dataSourceName}`,
    );

    return {
      configured: true,
      connected: true,
      authMode,
      accountName,
      dataSourceName,
      dataSource: {
        name: dataSource.name,
        displayName: dataSource.displayName ?? null,
        input: dataSource.input ?? null,
        feedLabel:
          dataSource.primaryProductDataSource?.feedLabel ?? null,
        contentLanguage:
          dataSource.primaryProductDataSource?.contentLanguage ?? null,
        countries: dataSource.primaryProductDataSource?.countries ?? [],
      },
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      authMode,
      accountName,
      dataSourceName,
      dataSource: null,
      error:
        error instanceof Error
          ? error.message
          : "Unknown Google Merchant connection error.",
    };
  }
}

export async function syncMerchantCatalog(params: {
  upserts: MerchantProductInputRecord[];
  deletes: MerchantDeleteTarget[];
  reconcileWithExistingProducts?: boolean;
}) {
  const authMode = getGoogleAuthMode();

  if (!authMode) {
    throw new Error(
      "Missing Google Merchant credentials. Configure OAuth refresh-token credentials or a service account.",
    );
  }

  const accountName = getMerchantAccountName();
  const dataSourceName = getMerchantDataSourceName();
  const upsertMap = new Map<string, MerchantProductInputRecord>();

  for (const record of params.upserts) {
    upsertMap.set(buildDeleteKey(record), record);
  }

  const deleteMap = new Map<string, MerchantDeleteTarget>();

  for (const target of params.deletes) {
    deleteMap.set(buildDeleteKey(target), target);
  }

  let existingProductsScanned = 0;
  let reconciliationDeletes = 0;

  if (params.reconcileWithExistingProducts) {
    const existingProducts = await listConfiguredDataSourceProducts();
    existingProductsScanned = existingProducts.length;

    for (const target of existingProducts) {
      const key = buildDeleteKey(target);

      if (!upsertMap.has(key)) {
        deleteMap.set(key, target);
      }
    }

    reconciliationDeletes = Array.from(deleteMap.values()).filter(
      (target) => target.reason === "missing_from_full_catalog_reconciliation",
    ).length;
  }

  const upserts = Array.from(upsertMap.values());
  const deletes = Array.from(deleteMap.entries())
    .filter(([key]) => !upsertMap.has(key))
    .map(([, value]) => value);
  const errors: MerchantSyncError[] = [];
  let errorCount = 0;
  let upsertsSucceeded = 0;
  let deletesSucceeded = 0;
  const deleteTargetKeysSucceeded: string[] = [];

  const collectError = (error: MerchantSyncError) => {
    errorCount += 1;

    if (errors.length < MERCHANT_ERROR_SAMPLE_LIMIT) {
      errors.push(error);
    }
  };

  await runWithConcurrency(
    upserts,
    MERCHANT_WRITE_CONCURRENCY,
    async (record) => {
      try {
        await merchantRequest(
          `/products/v1/${accountName}/productInputs:insert`,
          {
            method: "POST",
            query: {
              dataSource: dataSourceName,
            },
            body: buildProductInputPayload(record),
          },
        );
        upsertsSucceeded += 1;
      } catch (error) {
        collectError({
          action: "insert",
          offerId: record.offerId,
          status: error instanceof MerchantApiError ? error.status : null,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Merchant insert error.",
        });
      }
    },
  );

  await runWithConcurrency(
    deletes,
    MERCHANT_WRITE_CONCURRENCY,
    async (target) => {
      try {
        await merchantRequest(
          `/products/v1/${buildProductInputName(target)}`,
          {
            method: "DELETE",
            query: {
              dataSource: dataSourceName,
            },
          },
        );
        deletesSucceeded += 1;
        deleteTargetKeysSucceeded.push(buildDeleteKey(target));
      } catch (error) {
        if (error instanceof MerchantApiError && error.status === 404) {
          deletesSucceeded += 1;
          deleteTargetKeysSucceeded.push(buildDeleteKey(target));
          return;
        }

        collectError({
          action: "delete",
          offerId: target.offerId,
          status: error instanceof MerchantApiError ? error.status : null,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Merchant delete error.",
        });
      }
    },
  );

  return {
    accountName,
    dataSourceName,
    authMode,
    upsertsAttempted: upserts.length,
    upsertsSucceeded,
    deletesAttempted: deletes.length,
    deletesSucceeded,
    reconciliationDeletes,
    existingProductsScanned,
    errorCount,
    errors,
    deleteTargetsSample: deletes.slice(0, MERCHANT_DELETE_SAMPLE_LIMIT),
    deleteTargetKeysSucceeded,
  } satisfies MerchantCatalogSyncSummary;
}
