import { env, getConfigurationStatus } from "@/lib/env";
import {
  syncMerchantCatalog,
  type MerchantCatalogSyncProgress,
  type MerchantCatalogSyncSummary,
  type MerchantDeleteTarget,
} from "@/lib/google-merchant";
import { resolveGoogleProductCategoryId } from "@/lib/google-taxonomy";
import {
  appendSyncHistory,
  getPendingShopifyDeletes,
  getLatestSuccessfulLiveSyncHistory,
  removePendingShopifyDeletes,
  getSyncSettings,
  writePreviewExportArtifact,
  writeRunArtifact,
  type PendingShopifyDeleteRecord,
  type SyncHistoryPurpose,
  type SyncHistoryEntry,
  type SyncSettings,
} from "@/lib/operator-store";
import { buildShopifyOfferId, parseShopifyOfferId } from "@/lib/shopify-offer-id";
import {
  mapProductAvailability,
  type GoogleAvailability,
} from "@/lib/product-availability";
import {
  resolveAgedQuickShipCustomLabel0,
} from "@/lib/aged-quick-ship";
export { buildFeedRecordFingerprint } from "@/lib/feed-fingerprint";
import {
  fetchShopConnectionDetails,
  getConfiguredShopDomain,
  getRuntimeShopifyAccessToken,
  runShopifyAdminGraphql,
} from "@/lib/shopify";

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const FALLBACK_ANCHOR_DATE = "2026-03-10";
const SHOPIFY_PAGE_SIZE = 250;
const CRON_HOUR_UTC = 12;
const CRON_MINUTE_UTC = 0;
export const DEFAULT_PREVIEW_LIMIT = 5;
export const LIVE_SYNC_CHUNK_PRODUCT_TARGET = 1500;
const RUN_ARTIFACT_INCLUDED_SAMPLE_LIMIT = 50;
const RUN_ARTIFACT_EXCLUDED_SAMPLE_LIMIT = 250;
const DETAIL_BATCH_SIZE = 150;
const DETAIL_VARIANT_PAGE_SIZE = SHOPIFY_PAGE_SIZE;
const DETAIL_MEDIA_LIMIT = SHOPIFY_PAGE_SIZE;
const ENGINE_LABEL_TITLE_TAIL_WORDS = 8;
const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const GOOGLE_MPN_METAFIELD_NAMESPACE = "mm-google-shopping";
const GOOGLE_MPN_METAFIELD_KEY = "mpn";
const SHOPIFY_REFERENCE_GID_PATTERN = /gid:\/\/shopify\//i;

const SHOPIFY_REFERENCE_METAFIELD_FIELDS = `
          value
          type
          references(first: 10) {
            edges {
              node {
                __typename
                ... on Metaobject {
                  handle
                  label: field(key: "label") {
                    value
                  }
                }
                ... on TaxonomyValue {
                  name
                }
              }
            }
          }
`;

// Feed-critical metafields stay explicit so feed output never depends on
// Shopify metafield ordering or pagination.
const EXPLICIT_PRODUCT_FEED_METAFIELDS = `
        lastOrderedAtSales: metafield(namespace: "sales", key: "last_ordered_at") {
          value
        }
        googleProductTypeCustom: metafield(namespace: "custom", key: "google_product_type") {
          value
        }
        googleProductTypeFeed: metafield(namespace: "feed", key: "google_product_type") {
          value
        }
        googleProductTypeGoogle: metafield(namespace: "google", key: "google_product_type") {
          value
        }
        productTypeCustom: metafield(namespace: "custom", key: "product_type") {
          value
        }
        productTypeFeed: metafield(namespace: "feed", key: "product_type") {
          value
        }
        productTypeGoogle: metafield(namespace: "google", key: "product_type") {
          value
        }
        productSubtypeCustom: metafield(namespace: "custom", key: "product_subtype") {
          value
        }
        gtinCustom: metafield(namespace: "custom", key: "gtin") {
          value
        }
        gtinFeed: metafield(namespace: "feed", key: "gtin") {
          value
        }
        gtinGoogle: metafield(namespace: "google", key: "gtin") {
          value
        }
        stateRestrictionsCustom: metafield(namespace: "custom", key: "state_restrictions") {
          value
        }
        stateRestrictionsFeed: metafield(namespace: "feed", key: "state_restrictions") {
          value
        }
        adWordsSpendCustom: metafield(namespace: "custom", key: "ad_words_spend") {
          value
        }
        adWordsSpendFeed: metafield(namespace: "feed", key: "ad_words_spend") {
          value
        }
        quickShipCustom: metafield(namespace: "custom", key: "quick_ship") {
          value
        }
        quickShipFeed: metafield(namespace: "feed", key: "quick_ship") {
          value
        }
        colorCustom: metafield(namespace: "custom", key: "color") {
          value
        }
        colorFeed: metafield(namespace: "feed", key: "color") {
          value
        }
        shopifyColorPattern: metafield(namespace: "shopify", key: "color-pattern") {
${SHOPIFY_REFERENCE_METAFIELD_FIELDS}
        }
        sizeCustom: metafield(namespace: "custom", key: "size") {
          value
        }
        sizeFeed: metafield(namespace: "feed", key: "size") {
          value
        }
        shopifySize: metafield(namespace: "shopify", key: "size") {
${SHOPIFY_REFERENCE_METAFIELD_FIELDS}
        }
        applicationFeed: metafield(namespace: "feed", key: "application") {
          value
        }
`;

const EXPLICIT_VARIANT_FEED_METAFIELDS = `
              googleProductTypeCustom: metafield(namespace: "custom", key: "google_product_type") {
                value
              }
              googleProductTypeFeed: metafield(namespace: "feed", key: "google_product_type") {
                value
              }
              googleProductTypeGoogle: metafield(namespace: "google", key: "google_product_type") {
                value
              }
              productTypeCustom: metafield(namespace: "custom", key: "product_type") {
                value
              }
              productTypeFeed: metafield(namespace: "feed", key: "product_type") {
                value
              }
              productTypeGoogle: metafield(namespace: "google", key: "product_type") {
                value
              }
              productSubtypeCustom: metafield(namespace: "custom", key: "product_subtype") {
                value
              }
              productAvailabilityCustom: metafield(namespace: "custom", key: "product_availability") {
                value
              }
              productAvailabilityDateCustom: metafield(namespace: "custom", key: "product_availability_date") {
                value
              }
              gtinCustom: metafield(namespace: "custom", key: "gtin") {
                value
              }
              gtinFeed: metafield(namespace: "feed", key: "gtin") {
                value
              }
              gtinGoogle: metafield(namespace: "google", key: "gtin") {
                value
              }
              stateRestrictionsCustom: metafield(namespace: "custom", key: "state_restrictions") {
                value
              }
              stateRestrictionsFeed: metafield(namespace: "feed", key: "state_restrictions") {
                value
              }
              adWordsSpendCustom: metafield(namespace: "custom", key: "ad_words_spend") {
                value
              }
              adWordsSpendFeed: metafield(namespace: "feed", key: "ad_words_spend") {
                value
              }
              quickShipCustom: metafield(namespace: "custom", key: "quick_ship") {
                value
              }
              quickShipFeed: metafield(namespace: "feed", key: "quick_ship") {
                value
              }
              colorCustom: metafield(namespace: "custom", key: "color") {
                value
              }
              colorFeed: metafield(namespace: "feed", key: "color") {
                value
              }
              shopifyColorPattern: metafield(namespace: "shopify", key: "color-pattern") {
${SHOPIFY_REFERENCE_METAFIELD_FIELDS}
              }
              sizeCustom: metafield(namespace: "custom", key: "size") {
                value
              }
              sizeFeed: metafield(namespace: "feed", key: "size") {
                value
              }
              shopifySize: metafield(namespace: "shopify", key: "size") {
${SHOPIFY_REFERENCE_METAFIELD_FIELDS}
              }
              applicationFeed: metafield(namespace: "feed", key: "application") {
                value
              }
`;

const SHOPIFY_PRODUCT_SCAN_QUERY = `
  query ScanFeedProducts($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          title
          descriptionHtml
          handle
          vendor
          productType
          status
          tags
          updatedAt
          onlineStoreUrl
          seoHidden: metafield(namespace: "seo", key: "hidden") {
            value
          }
        }
      }
    }
  }
`;

const SHOPIFY_PRODUCT_DETAILS_QUERY = `
  query FeedProductDetails($ids: [ID!]!, $mediaLimit: Int!, $variantLimit: Int!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        legacyResourceId
        title
        descriptionHtml
        handle
        vendor
        productType
        status
        tags
        updatedAt
        onlineStoreUrl
        seoHidden: metafield(namespace: "seo", key: "hidden") {
          value
        }
        googleMpn: metafield(namespace: "${GOOGLE_MPN_METAFIELD_NAMESPACE}", key: "${GOOGLE_MPN_METAFIELD_KEY}") {
          value
        }
        application: metafield(namespace: "custom", key: "application") {
          value
        }
${EXPLICIT_PRODUCT_FEED_METAFIELDS}
        featuredMedia {
          __typename
          ... on MediaImage {
            image {
              url
            }
          }
        }
        media(first: $mediaLimit) {
          edges {
            node {
              __typename
              ... on MediaImage {
                image {
                  url
                }
              }
            }
          }
        }
        variants(first: $variantLimit) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              legacyResourceId
              title
              sku
              selectedOptions {
                name
                value
              }
              barcode
              price
              compareAtPrice
              googleMpn: metafield(namespace: "${GOOGLE_MPN_METAFIELD_NAMESPACE}", key: "${GOOGLE_MPN_METAFIELD_KEY}") {
                value
              }
              application: metafield(namespace: "custom", key: "application") {
                value
              }
${EXPLICIT_VARIANT_FEED_METAFIELDS}
              image {
                url
              }
              inventoryItem {
                measurement {
                  weight {
                    value
                    unit
                  }
                }
                unitCost {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

const SHOPIFY_PRODUCT_VARIANTS_QUERY = `
  query FeedProductVariants($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      variants(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            legacyResourceId
            title
            sku
            selectedOptions {
              name
              value
            }
            barcode
            price
            compareAtPrice
            googleMpn: metafield(namespace: "${GOOGLE_MPN_METAFIELD_NAMESPACE}", key: "${GOOGLE_MPN_METAFIELD_KEY}") {
              value
            }
            application: metafield(namespace: "custom", key: "application") {
              value
            }
${EXPLICIT_VARIANT_FEED_METAFIELDS}
            image {
              url
            }
            inventoryItem {
              measurement {
                weight {
                  value
                  unit
                }
              }
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

const SHOPIFY_PRODUCTS_COUNT_QUERY = `
  query FeedProductsCount($query: String!) {
    productsCount(query: $query, limit: null) {
      count
      precision
    }
  }
`;

export type SyncMode = "idle" | "delta" | "full";

export interface SyncDecision {
  mode: SyncMode;
  anchorDate: string;
  daysSinceAnchor: number;
  reason: string;
}

export interface UpcomingSyncDates {
  deltaDate: string;
  fullDate: string;
}

export interface GooglePriceValue {
  amountMicros: string;
  currencyCode: string;
}

export interface GoogleWeightValue {
  value: number;
  unit: string;
}

export interface GoogleCustomAttribute {
  name: string;
  value: string;
}

export interface FeedPreviewRecord {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  customAttributes?: GoogleCustomAttribute[];
  productAttributes: {
    title: string;
    description: string;
    link: string;
    imageLink: string;
    additionalImageLinks: string[];
    availability: GoogleAvailability;
    availabilityDate: string | null;
    price: GooglePriceValue;
    salePrice: GooglePriceValue | null;
    condition: "NEW";
    googleProductCategory: string | null;
    productTypes: string[];
    ageGroup: string | null;
    color: string | null;
    gender: string | null;
    brand: string | null;
    gtins: string[];
    mpn: string | null;
    identifierExists: boolean;
    itemGroupId: string;
    size: string | null;
    sizeSystem: string | null;
    customLabel0: string | null;
    customLabel1: string | null;
    customLabel2: string | null;
    customLabel3: string | null;
    customLabel4: string | null;
    shippingWeight: GoogleWeightValue | null;
    shippingLabel: string;
    costOfGoodsSold: GooglePriceValue | null;
  };
}

export interface ExcludedPreviewSample {
  reason: string;
  details?: string[];
  productId: string;
  variantId: string | null;
  offerId: string | null;
  handle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  link?: string | null;
}

export interface DeletePreviewSample extends ExcludedPreviewSample {
  source:
    | "shopify_scan"
    | "shopify_webhook"
    | "merchant_reconciliation";
}

export interface SyncSearchPlan {
  query: string;
  lookbackStart: string | null;
  lookbackEnd?: string | null;
  source:
    | "full_catalog"
    | "live_sync_checkpoint"
    | "lookback_fallback"
    | "webhook_queue";
  productIds?: string[];
  notes: string[];
}

export interface SyncRunArtifact {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  purpose: SyncHistoryPurpose | null;
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  exhaustive: boolean;
  ok: boolean;
  scope: string;
  query: string;
  lookbackStart: string | null;
  lookbackEnd?: string | null;
  exportArtifactId?: string | null;
  notes: string[];
  stats: SyncRunResult["stats"];
  includedSample: FeedPreviewRecord[];
  validationSample: ExcludedPreviewSample[];
  excludedSample: ExcludedPreviewSample[];
  deleteSample?: DeletePreviewSample[];
  deleteSampleMode?: "candidate" | "actual";
  merchant?: SyncRunResult["merchant"];
}

export interface SyncRunResult {
  ok: boolean;
  trigger: "cron" | "manual";
  purpose: SyncHistoryPurpose;
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  exhaustive: boolean;
  scope: string;
  startedAt: string;
  finishedAt: string;
  configuration: ReturnType<typeof getConfigurationStatus>;
  notes: string[];
  query: string;
  lookbackStart: string | null;
  lookbackEnd?: string | null;
  storefrontBaseUrl: string | null;
  stats: {
    pageSize: number;
    pagesScanned: number;
    scanCompleted: boolean;
    totalProducts: number | null;
    productsFetched: number;
    variantsConsidered: number;
    recordsPrepared: number;
    excluded: number;
    validationIssues: number;
    previewLimit: number;
    merchantUpsertsAttempted?: number;
    merchantUpsertsSucceeded?: number;
    merchantDeletesAttempted?: number;
    merchantDeletesSucceeded?: number;
    merchantReconciliationDeletes?: number;
    merchantWriteErrors?: number;
  };
  exclusions: Record<string, number>;
  preview: FeedPreviewRecord[];
  exportArtifactId?: string | null;
  deleteSample?: DeletePreviewSample[];
  merchant?: MerchantCatalogSyncSummary | null;
}

export interface SyncExportResult {
  ok: boolean;
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  exhaustive: boolean;
  startedAt: string;
  finishedAt: string;
  notes: string[];
  query: string;
  lookbackStart: string | null;
  lookbackEnd?: string | null;
  stats: SyncRunResult["stats"];
  exclusions: Record<string, number>;
  rows: FeedPreviewRecord[];
  excludedRows?: ExcludedPreviewSample[];
  validationRows?: ExcludedPreviewSample[];
}

export interface SyncProgressUpdate {
  stage: "counting" | "scanning" | "uploading" | "complete";
  exhaustive: boolean;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  previewRows: number;
  message: string;
  merchantPhase?: MerchantCatalogSyncProgress["phase"];
  merchantCompleted?: number;
  merchantTotal?: number | null;
  merchantErrors?: number;
}

export interface SyncExecutionContext {
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  searchPlan: SyncSearchPlan;
  query: string;
  lookbackStart: string | null;
  lookbackEnd?: string | null;
  searchNotes: string[];
  shop: string;
  accessToken: string;
  storefrontBaseUrl: string | null;
  totalProducts: number | null;
}

export interface SyncChunkScanResult {
  nextCursor: string | null;
  scanCompleted: boolean;
  pagesScanned: number;
  productsFetched: number;
  productsEvaluated: number;
  variantsConsidered: number;
  recordsPrepared: number;
  estimatedTransferBytes: number;
  rows: FeedPreviewRecord[];
  includedSamples: FeedPreviewRecord[];
  excludedRows: ExcludedPreviewSample[];
  validationRows: ExcludedPreviewSample[];
  excludedSamples: ExcludedPreviewSample[];
  validationSamples: ExcludedPreviewSample[];
  deleteCandidates: MerchantDeleteTarget[];
  deleteSamples: DeletePreviewSample[];
  exclusions: Record<string, number>;
}

function getProgressTargetTotal(
  exhaustive: boolean,
  totalProducts: number | null,
) {
  if (exhaustive) {
    return totalProducts;
  }

  if (typeof totalProducts === "number") {
    return Math.min(totalProducts, SHOPIFY_PAGE_SIZE);
  }

  return SHOPIFY_PAGE_SIZE;
}

interface ShopifyPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ShopifyConnectionEdge<T> {
  node: T;
}

interface ShopifyConnection<T> {
  edges?: Array<ShopifyConnectionEdge<T>>;
  pageInfo?: ShopifyPageInfo;
}

interface ShopifyMetaobjectFieldValue {
  value: string | null;
}

interface ShopifyMetafieldReferenceNode {
  __typename: string;
  handle?: string;
  label?: ShopifyMetaobjectFieldValue | null;
  name?: string | null;
}

interface ShopifySingleMetafieldValue {
  value: string | null;
  type?: string | null;
  references?: ShopifyConnection<ShopifyMetafieldReferenceNode> | null;
}

interface ShopifyExplicitFeedMetafields {
  googleProductTypeCustom?: ShopifySingleMetafieldValue | null;
  googleProductTypeFeed?: ShopifySingleMetafieldValue | null;
  googleProductTypeGoogle?: ShopifySingleMetafieldValue | null;
  productTypeCustom?: ShopifySingleMetafieldValue | null;
  productTypeFeed?: ShopifySingleMetafieldValue | null;
  productTypeGoogle?: ShopifySingleMetafieldValue | null;
  productSubtypeCustom?: ShopifySingleMetafieldValue | null;
  productAvailabilityCustom?: ShopifySingleMetafieldValue | null;
  productAvailabilityDateCustom?: ShopifySingleMetafieldValue | null;
  gtinCustom?: ShopifySingleMetafieldValue | null;
  gtinFeed?: ShopifySingleMetafieldValue | null;
  gtinGoogle?: ShopifySingleMetafieldValue | null;
  stateRestrictionsCustom?: ShopifySingleMetafieldValue | null;
  stateRestrictionsFeed?: ShopifySingleMetafieldValue | null;
  adWordsSpendCustom?: ShopifySingleMetafieldValue | null;
  adWordsSpendFeed?: ShopifySingleMetafieldValue | null;
  quickShipCustom?: ShopifySingleMetafieldValue | null;
  quickShipFeed?: ShopifySingleMetafieldValue | null;
  colorCustom?: ShopifySingleMetafieldValue | null;
  colorFeed?: ShopifySingleMetafieldValue | null;
  shopifyColorPattern?: ShopifySingleMetafieldValue | null;
  sizeCustom?: ShopifySingleMetafieldValue | null;
  sizeFeed?: ShopifySingleMetafieldValue | null;
  shopifySize?: ShopifySingleMetafieldValue | null;
  application?: ShopifySingleMetafieldValue | null;
  applicationFeed?: ShopifySingleMetafieldValue | null;
}

interface ShopifyMediaNode {
  __typename: string;
  image?: {
    url?: string | null;
  } | null;
}

interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

interface ShopifyWeight {
  value: number;
  unit: string;
}

interface ShopifySelectedOption {
  name: string;
  value: string;
}

interface ShopifyVariantNode extends ShopifyExplicitFeedMetafields {
  id: string;
  legacyResourceId: string | null;
  title: string;
  sku: string | null;
  selectedOptions?: ShopifySelectedOption[];
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  googleMpn?: ShopifySingleMetafieldValue | null;
  image?: {
    url?: string | null;
  } | null;
  inventoryItem?: {
    measurement?: {
      weight?: ShopifyWeight | null;
    } | null;
    unitCost?: ShopifyMoney | null;
  } | null;
}

interface ShopifyProductNode extends ShopifyExplicitFeedMetafields {
  id: string;
  legacyResourceId: string | null;
  title: string;
  descriptionHtml: string | null;
  handle: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  tags: string[];
  updatedAt: string;
  onlineStoreUrl: string | null;
  seoHidden?: ShopifySingleMetafieldValue | null;
  googleMpn?: ShopifySingleMetafieldValue | null;
  lastOrderedAtSales?: ShopifySingleMetafieldValue | null;
  featuredMedia?: ShopifyMediaNode | null;
  media?: ShopifyConnection<ShopifyMediaNode>;
  variants?: ShopifyConnection<ShopifyVariantNode>;
}

interface ShopifyFeedProductsPayload {
  products?: ShopifyConnection<ShopifyProductNode>;
}

interface ShopifyProductDetailsPayload {
  nodes?: Array<ShopifyProductNode | null>;
}

interface ShopifyProductVariantsPayload {
  product?: {
    variants?: ShopifyConnection<ShopifyVariantNode>;
  } | null;
}

interface ShopifyProductsCountPayload {
  productsCount?: {
    count: number;
    precision: string;
  } | null;
}

function parseAnchorDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return new Date(`${FALLBACK_ANCHOR_DATE}T00:00:00.000Z`);
  }

  return parsed;
}

function getDefaultSyncSettings(): SyncSettings {
  return {
    anchorDate: env.syncAnchorDate,
    deltaIntervalDays: env.deltaIntervalDays,
    fullIntervalDays: env.fullIntervalDays,
    updatedAt: new Date().toISOString(),
  };
}

function toUtcDayNumber(date: Date) {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
      MS_PER_DAY,
  );
}

function connectionNodes<T>(connection?: ShopifyConnection<T> | null): T[] {
  return connection?.edges?.map((edge) => edge.node) ?? [];
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function incrementCounter(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] ?? 0) + 1;
}

function collectExcludedSample<T extends ExcludedPreviewSample>(
  samples: T[],
  sample: T,
  limit = RUN_ARTIFACT_EXCLUDED_SAMPLE_LIMIT,
) {
  if (samples.length >= limit) {
    return;
  }

  samples.push(sample);
}

function resolveLegacyId(legacyId: string | null, gid: string) {
  const value = legacyId?.trim();

  if (value) {
    return value;
  }

  return gid.split("/").pop() ?? gid;
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    );
}

function stripHtml(value: string | null | undefined) {
  return decodeHtmlEntities(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function parseAmount(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMicros(amount: number | null, currencyCode = "USD") {
  if (amount === null) {
    return null;
  }

  return {
    amountMicros: String(Math.round(amount * 1_000_000)),
    currencyCode,
  } satisfies GooglePriceValue;
}

function formatWeight(weight: ShopifyWeight | null | undefined) {
  const value = weight?.value ?? null;

  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const normalizedUnit = (weight?.unit ?? "POUNDS").toUpperCase();
  const unit =
    normalizedUnit === "POUNDS"
      ? "lb"
      : normalizedUnit === "OUNCES"
        ? "oz"
        : normalizedUnit === "KILOGRAMS"
          ? "kg"
          : normalizedUnit === "GRAMS"
            ? "g"
            : normalizedUnit.toLowerCase();

  return {
    value: Number(value.toFixed(3)),
    unit,
  } satisfies GoogleWeightValue;
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = normalizeText(value);

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeBooleanish(value: string | null | undefined) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeLookupToken(value: string | null | undefined) {
  return normalizeText(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function normalizeGoogleProductCategory(value: string | null) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  return resolveGoogleProductCategoryId(normalized);
}

function readExplicitMetafieldValue(
  owners: Array<ShopifyExplicitFeedMetafields | null | undefined>,
  keys: Array<keyof ShopifyExplicitFeedMetafields>,
) {
  for (const owner of owners) {
    for (const key of keys) {
      const value = normalizeText(owner?.[key]?.value ?? null);

      if (value && !SHOPIFY_REFERENCE_GID_PATTERN.test(value)) {
        return value;
      }
    }
  }

  return null;
}

function normalizeProductTypeBreadcrumb(value: string | null | undefined) {
  const segments = normalizeText(value)
    .split(">")
    .map((segment) => normalizeText(segment))
    .filter(Boolean);

  return segments.length > 0 ? segments.join(" > ") : null;
}

function buildProductTypeBreadcrumb(
  productType: string | null,
  productSubtype: string | null,
) {
  const typeValue = normalizeProductTypeBreadcrumb(productType);
  const subtypeValue = normalizeProductTypeBreadcrumb(productSubtype);

  if (!typeValue) {
    return subtypeValue;
  }

  if (!subtypeValue) {
    return typeValue;
  }

  const lastTypeSegment = typeValue.split(">").map((segment) => normalizeText(segment)).at(-1);
  const firstSubtypeSegment = subtypeValue
    .split(">")
    .map((segment) => normalizeText(segment))
    .at(0);

  if (normalizeLookupToken(lastTypeSegment) === normalizeLookupToken(firstSubtypeSegment)) {
    const subtypeTail = subtypeValue
      .split(">")
      .map((segment) => normalizeText(segment))
      .filter(Boolean)
      .slice(1)
      .join(" > ");

    return subtypeTail ? `${typeValue} > ${subtypeTail}` : typeValue;
  }

  return `${typeValue} > ${subtypeValue}`;
}

function collectMediaUrls(product: ShopifyProductNode) {
  const urls = new Set<string>();
  const featuredUrl = product.featuredMedia?.image?.url ?? null;

  if (featuredUrl) {
    urls.add(featuredUrl);
  }

  for (const mediaNode of connectionNodes(product.media)) {
    const url = mediaNode.image?.url ?? null;

    if (url) {
      urls.add(url);
    }
  }

  return Array.from(urls);
}

function normalizeStorefrontUrl(params: {
  fallbackHandle: string;
  onlineStoreUrl: string | null;
  storefrontBaseUrl: string | null;
  variantId: string;
}) {
  const { fallbackHandle, onlineStoreUrl, storefrontBaseUrl, variantId } = params;

  const buildFallback = () => {
    if (!storefrontBaseUrl) {
      return null;
    }

    const base = new URL(storefrontBaseUrl);
    base.pathname = `/products/${fallbackHandle}`;
    base.searchParams.set("variant", variantId);
    return base.toString();
  };

  if (!onlineStoreUrl) {
    return buildFallback();
  }

  try {
    const resolved = new URL(onlineStoreUrl);

    if (storefrontBaseUrl) {
      const storefront = new URL(storefrontBaseUrl);
      resolved.protocol = storefront.protocol;
      resolved.host = storefront.host;
    }

    resolved.searchParams.set("variant", variantId);
    return resolved.toString();
  } catch {
    return buildFallback();
  }
}

function computeHighPriceBucket(price: number) {
  if (price <= 365) {
    return null;
  }

  if (price <= 500) {
    return "365 - 500";
  }

  if (price <= 700) {
    return "500 - 700";
  }

  return "700+";
}

function resolveEngineLabel(haystack: string) {
  const normalizedHaystack = haystack.replace(/\bpower\s*stroke\s*products\b/g, " ");
  const explicitMatches = new Set<string>();

  if (/\bcummins\b/.test(normalizedHaystack)) {
    explicitMatches.add("Cummins");
  }

  if (/\bpower\s*stroke\b|\bpowerstroke\b/.test(normalizedHaystack)) {
    explicitMatches.add("Powerstroke");
  }

  if (/\bduramax\b/.test(normalizedHaystack)) {
    explicitMatches.add("Duramax");
  }

  if (/\beco\s*diesel\b|\becodiesel\b/.test(normalizedHaystack)) {
    explicitMatches.add("Ecodiesel");
  }

  const inferredMatches = new Set<string>();

  if (/\bram\b|\bdodge\b/.test(normalizedHaystack)) {
    inferredMatches.add("Cummins");
  }

  if (/\bford\b/.test(normalizedHaystack)) {
    inferredMatches.add("Powerstroke");
  }

  if (/\bgm\b|\bgmc\b|\bchevy\b|\bchevrolet\b/.test(normalizedHaystack)) {
    inferredMatches.add("Duramax");
  }

  if (explicitMatches.size === 1) {
    return {
      label: explicitMatches.values().next().value ?? null,
      ambiguous: false,
    };
  }

  if (explicitMatches.size > 1) {
    if (inferredMatches.size === 1) {
      const inferred = inferredMatches.values().next().value ?? null;

      return {
        label: inferred && explicitMatches.has(inferred) ? inferred : null,
        ambiguous: true,
      };
    }

    return { label: null, ambiguous: true };
  }

  if (inferredMatches.size === 1) {
    return {
      label: inferredMatches.values().next().value ?? null,
      ambiguous: false,
    };
  }

  return { label: null, ambiguous: false };
}

function parseEngineLabel(params: {
  title: string | null | undefined;
  application: string | null | undefined;
}) {
  const applicationResult = resolveEngineLabel(
    normalizeText(params.application).toLowerCase(),
  );

  if (applicationResult.label || applicationResult.ambiguous) {
    return applicationResult.label;
  }

  const fitmentTail = normalizeText(params.title)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-ENGINE_LABEL_TITLE_TAIL_WORDS)
    .join(" ");

  if (!fitmentTail) {
    return null;
  }

  const titleResult = resolveEngineLabel(fitmentTail);

  return titleResult.label;
}

function normalizeCustomLabel2(value: string | null) {
  const normalized = normalizeLookupToken(value);

  if (!normalized) {
    return null;
  }

  if (normalized === "a" || normalized === "above average") {
    return "a";
  }

  if (normalized === "b" || normalized === "average") {
    return "b";
  }

  if (normalized === "c" || normalized === "below average") {
    return "c";
  }

  return normalizeText(value) || null;
}

function computeMarginCustomLabel2(params: {
  priceAmount: number;
  costAmount: number | null;
}) {
  if (params.priceAmount <= 0 || params.costAmount === null) {
    return null;
  }

  const marginPercent =
    ((params.priceAmount - params.costAmount) / params.priceAmount) * 100;

  if (marginPercent <= 20) {
    return "c";
  }

  if (marginPercent < 30) {
    return "b";
  }

  return "a";
}

function readSelectedOptionValue(
  selectedOptions: ShopifySelectedOption[] | null | undefined,
  names: string[],
) {
  const normalizedNames = new Set(names.map((name) => normalizeLookupToken(name)));

  for (const option of selectedOptions ?? []) {
    if (!normalizedNames.has(normalizeLookupToken(option.name))) {
      continue;
    }

    const value = normalizeText(option.value);

    if (value) {
      return value;
    }
  }

  return null;
}

function toUniqueMerchantFacingValues(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .filter((value) => !SHOPIFY_REFERENCE_GID_PATTERN.test(value)),
    ),
  );
}

function collectSerializedMetafieldValues(
  input: unknown,
  accumulator: string[],
) {
  if (input === null || input === undefined) {
    return;
  }

  if (
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    const value = normalizeText(String(input));

    if (value) {
      accumulator.push(value);
    }

    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      collectSerializedMetafieldValues(item, accumulator);
    }

    return;
  }

  if (typeof input !== "object") {
    return;
  }

  const record = input as Record<string, unknown>;
  const beforePreferredKeys = accumulator.length;

  for (const key of ["value", "name", "label"]) {
    if (key in record) {
      collectSerializedMetafieldValues(record[key], accumulator);
    }
  }

  if (accumulator.length > beforePreferredKeys) {
    return;
  }

  for (const nestedValue of Object.values(record)) {
    collectSerializedMetafieldValues(nestedValue, accumulator);
  }
}

function parseSerializedMetafieldValues(value: string | null | undefined) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    const collected: string[] = [];

    collectSerializedMetafieldValues(parsed, collected);

    return toUniqueMerchantFacingValues(collected);
  } catch {
    // Some Shopify metafields are plain strings instead of serialized JSON.
  }

  return toUniqueMerchantFacingValues([normalized]);
}

function readResolvedMetafieldValues(
  metafield: ShopifySingleMetafieldValue | null | undefined,
) {
  const resolvedValues: string[] = [];

  for (const node of connectionNodes(metafield?.references)) {
    if (node.__typename === "Metaobject") {
      const label = normalizeText(node.label?.value ?? null);

      if (label) {
        resolvedValues.push(label);
      }

      continue;
    }

    if (node.__typename === "TaxonomyValue") {
      const name = normalizeText(node.name);

      if (name) {
        resolvedValues.push(name);
      }
    }
  }

  const uniqueResolvedValues = toUniqueMerchantFacingValues(resolvedValues);

  if (uniqueResolvedValues.length > 0) {
    return uniqueResolvedValues;
  }

  return parseSerializedMetafieldValues(metafield?.value);
}

function formatShopifyColorPatternValue(
  metafield: ShopifySingleMetafieldValue | null | undefined,
) {
  const values = readResolvedMetafieldValues(metafield);

  if (values.length === 0) {
    return null;
  }

  return values.join("/");
}

function formatSingleShopifyAttributeValue(
  metafield: ShopifySingleMetafieldValue | null | undefined,
) {
  const values = readResolvedMetafieldValues(metafield);

  return values.length === 1 ? values[0] : null;
}

function resolveVariantTitleSize(value: string | null | undefined) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  const segments = normalized
    .split("/")
    .map((segment) => normalizeText(segment))
    .filter(Boolean)
    .filter((segment) => normalizeLookupToken(segment) !== "default title");

  if (segments.length === 0) {
    return null;
  }

  return segments.at(-1) ?? null;
}

function isApparelProductType(...values: Array<string | null | undefined>) {
  return values.some((value) => normalizeLookupToken(value).includes("apparel"));
}

function buildShippingLabel(params: {
  stateRestrictions: string | null;
  quickShip: string | null;
  override: string | null;
}) {
  const { stateRestrictions, quickShip, override } = params;

  if (override) {
    return override;
  }

  if (stateRestrictions) {
    return stateRestrictions;
  }

  if (normalizeBooleanish(quickShip)) {
    return "fast_free";
  }

  return "Standard";
}

function normalizeGtin(value: string | null | undefined) {
  const digitsOnly = normalizeText(value).replace(/\D/g, "");

  if (!digitsOnly) {
    return null;
  }

  return VALID_GTIN_LENGTHS.has(digitsOnly.length) ? digitsOnly : null;
}

type FeedValidationIssue = {
  reason: string;
  detail: string;
};

function isValidationExclusionReason(reason: string) {
  return reason.startsWith("validation_");
}

export function countValidationIssues(exclusions: Record<string, number>) {
  return Object.entries(exclusions).reduce((total, [reason, count]) => {
    return total + (isValidationExclusionReason(reason) ? count : 0);
  }, 0);
}

function validateFeedRecord(params: {
  record: FeedPreviewRecord;
  apparelProduct: boolean;
}) {
  const issues: FeedValidationIssue[] = [];
  const { record, apparelProduct } = params;
  const { productAttributes } = record;
  const priceAmount = Number(productAttributes.price.amountMicros) / 1_000_000;

  if (!normalizeText(record.offerId)) {
    issues.push({
      reason: "validation_missing_required_id",
      detail: "Missing required Google field: id",
    });
  }

  if (!normalizeText(productAttributes.title)) {
    issues.push({
      reason: "validation_missing_required_title",
      detail: "Missing required Google field: title",
    });
  }

  if (!normalizeText(productAttributes.description)) {
    issues.push({
      reason: "validation_missing_required_description",
      detail: "Missing required Google field: description",
    });
  }

  if (!normalizeText(productAttributes.link)) {
    issues.push({
      reason: "validation_missing_required_link",
      detail: "Missing required Google field: link",
    });
  }

  if (!normalizeText(productAttributes.imageLink)) {
    issues.push({
      reason: "validation_missing_required_image_link",
      detail: "Missing required Google field: image_link",
    });
  }

  if (!normalizeText(productAttributes.availability)) {
    issues.push({
      reason: "validation_missing_required_availability",
      detail: "Missing required Google field: availability",
    });
  }

  if (
    productAttributes.availability === "BACKORDER" &&
    !normalizeText(productAttributes.availabilityDate)
  ) {
    issues.push({
      reason: "validation_missing_required_availability_date",
      detail: "Missing required Google field for backorder: availability_date",
    });
  }

  if (!productAttributes.price || !Number.isFinite(priceAmount)) {
    issues.push({
      reason: "validation_missing_required_price",
      detail: "Missing required Google field: price",
    });
  } else if (priceAmount <= 0) {
    issues.push({
      reason: "validation_invalid_non_positive_price",
      detail: "Google does not allow a price of 0 for standard products.",
    });
  }

  if (!normalizeText(productAttributes.brand)) {
    issues.push({
      reason: "validation_missing_required_brand",
      detail: "Missing required Google field: brand",
    });
  }

  if (!normalizeText(productAttributes.condition)) {
    issues.push({
      reason: "validation_missing_required_condition",
      detail: "Missing required Google field: condition",
    });
  }

  if (apparelProduct && !normalizeText(productAttributes.color)) {
    issues.push({
      reason: "validation_missing_required_apparel_color",
      detail: "Missing required Google field for apparel: color",
    });
  }

  if (apparelProduct && !normalizeText(productAttributes.size)) {
    issues.push({
      reason: "validation_missing_required_apparel_size",
      detail: "Missing required Google field for apparel: size",
    });
  }

  return issues;
}

function findProductExclusionReason(product: ShopifyProductNode) {
  const normalizedStatus = normalizeText(product.status)?.toLowerCase() ?? null;
  const normalizedTags = product.tags.map((tag) => tag.trim().toLowerCase());

  if (normalizedStatus && normalizedStatus !== "active") {
    return `shopify_status_${normalizedStatus}`;
  }

  if (normalizedTags.includes("google_exclude")) {
    return "google_exclude_tag";
  }

  if (normalizeBooleanish(product.seoHidden?.value ?? null)) {
    return "seo_hidden_metafield";
  }

  return null;
}

function buildDeleteTarget(params: {
  product: ShopifyProductNode;
  variant: ShopifyVariantNode;
  reason: string;
}): MerchantDeleteTarget {
  const productId = resolveLegacyId(
    params.product.legacyResourceId,
    params.product.id,
  );
  const variantId = resolveLegacyId(
    params.variant.legacyResourceId,
    params.variant.id,
  );

  return {
    offerId: buildShopifyOfferId(productId, variantId),
    contentLanguage: env.googleContentLanguage || "en",
    feedLabel: env.googleFeedLabel || "US",
    reason: params.reason,
    productId,
    variantId,
    title: params.product.title,
    variantTitle: params.variant.title,
  };
}

export function buildDeleteTargetKey(
  target: Pick<MerchantDeleteTarget, "contentLanguage" | "feedLabel" | "offerId">,
) {
  return `${target.contentLanguage}~${target.feedLabel}~${target.offerId}`;
}

export function toDeletePreviewSample(
  target: MerchantDeleteTarget,
  source: DeletePreviewSample["source"],
): DeletePreviewSample {
  const parsedIds = parseShopifyOfferId(target.offerId);

  return {
    reason: target.reason ?? "merchant_delete",
    productId: target.productId ?? parsedIds.productId,
    variantId: target.variantId ?? (parsedIds.variantId || null),
    offerId: target.offerId,
    handle: "",
    title: target.title ?? target.offerId,
    variantTitle: target.variantTitle ?? null,
    sku: null,
    link: null,
    source,
  };
}

export function toPendingDeleteTarget(record: PendingShopifyDeleteRecord): MerchantDeleteTarget {
  return {
    offerId: record.offerId,
    contentLanguage: record.contentLanguage,
    feedLabel: record.feedLabel,
    reason: record.reason,
    productId: record.productId,
    variantId: record.variantId,
    title: record.title,
    variantTitle: record.variantTitle,
  };
}

export function toPendingDeletePreviewSample(
  record: PendingShopifyDeleteRecord,
): DeletePreviewSample {
  return {
    reason: record.reason,
    productId: record.productId,
    variantId: record.variantId,
    offerId: record.offerId,
    handle: record.handle,
    title: record.title,
    variantTitle: record.variantTitle,
    sku: record.sku,
    link: record.link ?? null,
    source: "shopify_webhook",
  };
}

export function buildSyncScope(
  mode: Exclude<SyncMode, "idle">,
  searchPlan: SyncSearchPlan,
  settings: SyncSettings,
  exhaustive: boolean,
) {
  void settings;

  if (mode === "full") {
    return exhaustive
      ? "All Shopify products are scanned across active, draft, and archived statuses so current feed rows can be inserted and inactive rows can be deleted from Merchant Center."
      : "Shopify products are sampled across all statuses from the full catalog for previewing.";
  }

  if (
    searchPlan.source === "live_sync_checkpoint" &&
    searchPlan.lookbackStart &&
    searchPlan.lookbackEnd
  ) {
    return exhaustive
      ? `Shopify products changed after ${searchPlan.lookbackStart} and at or before ${searchPlan.lookbackEnd} are scanned exhaustively using the last successful live-sync checkpoint, including inactive or excluded products that now need Merchant deletes.`
      : `Shopify products changed after ${searchPlan.lookbackStart} and at or before ${searchPlan.lookbackEnd} are sampled using the last successful live-sync checkpoint.`;
  }

  return exhaustive
    ? "Shopify delta scope is using the stored live-sync checkpoint."
    : "Shopify delta preview is using the stored live-sync checkpoint.";
}

function buildLiveSyncCheckpointQuery(
  lookbackStart: string,
  lookbackEnd: string,
) {
  return `updated_at:>'${lookbackStart}' updated_at:<='${lookbackEnd}'`;
}

async function buildSearchQuery(
  mode: Exclude<SyncMode, "idle">,
  settings: SyncSettings,
  options?: {
    dryRun: boolean;
    now?: Date;
    allowDeltaFallback?: boolean;
  },
): Promise<SyncSearchPlan> {
  void settings;
  const effectiveNow = options?.now ?? new Date();

  if (mode === "full") {
    return {
      query: "",
      lookbackStart: null,
      lookbackEnd: null,
      source: "full_catalog",
      notes: [
        "Full sync scans all Shopify product statuses. Feed inserts still only include active, non-excluded, valid rows.",
      ],
    };
  }

  const latestLiveSync = await getLatestSuccessfulLiveSyncHistory();

  if (!latestLiveSync) {
    throw new Error(
      "Delta sync requires a successful live baseline. Run a live full sync first.",
    );
  }

  const lookbackStart = new Date(
    Date.parse(latestLiveSync.finishedAt) - 5 * MS_PER_MINUTE,
  ).toISOString();
  const lookbackEnd = effectiveNow.toISOString();

  return {
    query: buildLiveSyncCheckpointQuery(lookbackStart, lookbackEnd),
    lookbackStart,
    lookbackEnd,
    source: "live_sync_checkpoint",
    notes: [
      `Delta scope uses Shopify products changed after ${lookbackStart} and at or before ${lookbackEnd}, based on the last successful live sync checkpoint with a 5-minute overlap safety buffer.`,
      "Changes made after this run started are intentionally held for the next delta run.",
    ],
  };
}

function buildPreviewRecord(params: {
  product: ShopifyProductNode;
  variant: ShopifyVariantNode;
  totalVariants: number;
  storefrontBaseUrl: string | null;
  productMediaUrls: string[];
}):
  | FeedPreviewRecord
  | {
      excluded: string;
      details?: string[];
      link?: string | null;
    } {
  const { product, variant, totalVariants, storefrontBaseUrl, productMediaUrls } =
    params;

  const variantId = resolveLegacyId(variant.legacyResourceId, variant.id);
  const productId = resolveLegacyId(product.legacyResourceId, product.id);
  const link = normalizeStorefrontUrl({
    fallbackHandle: product.handle,
    onlineStoreUrl: product.onlineStoreUrl,
    storefrontBaseUrl,
    variantId,
  });
  const primaryImage =
    pickFirstNonEmpty(variant.image?.url ?? null, productMediaUrls[0] ?? null) ??
    null;

  if (!primaryImage) {
    return {
      excluded: "validation_missing_required_image_link",
      details: ["Missing required Google field: image_link"],
      link: null,
    };
  }

  const priceAmount = parseAmount(variant.price) ?? 0;

  const compareAtAmount = parseAmount(variant.compareAtPrice);
  const hasSalePrice =
    compareAtAmount !== null && compareAtAmount > 0 && compareAtAmount > priceAmount;
  const currencyCode = env.googleFeedCurrency || "USD";

  if (!link) {
    return {
      excluded: "validation_missing_required_link",
      details: ["Missing required Google field: link"],
      link: null,
    };
  }

  const additionalImageLinks = productMediaUrls
    .filter((url) => url !== primaryImage)
    .slice(0, 10);
  const metafieldOwners = [variant, product];

  const googleProductCategory = normalizeGoogleProductCategory(
    readExplicitMetafieldValue(metafieldOwners, [
      "googleProductTypeCustom",
      "googleProductTypeFeed",
      "googleProductTypeGoogle",
    ]),
  );
  const productType =
    readExplicitMetafieldValue(metafieldOwners, [
      "productTypeCustom",
      "productTypeFeed",
      "productTypeGoogle",
    ]) ?? normalizeText(product.productType) ?? null;
  const productSubtype = readExplicitMetafieldValue(metafieldOwners, [
    "productSubtypeCustom",
  ]);
  const gtin =
    normalizeGtin(variant.barcode) ??
    normalizeGtin(
      readExplicitMetafieldValue(metafieldOwners, [
        "gtinCustom",
        "gtinFeed",
        "gtinGoogle",
      ]),
    );
  const mpn = pickFirstNonEmpty(
    variant.googleMpn?.value ?? null,
    product.googleMpn?.value ?? null,
  );
  const stateRestrictions = readExplicitMetafieldValue(metafieldOwners, [
    "stateRestrictionsCustom",
    "stateRestrictionsFeed",
  ]);
  const adWordsSpend = readExplicitMetafieldValue(metafieldOwners, [
    "adWordsSpendCustom",
    "adWordsSpendFeed",
  ]);
  const quickShip = readExplicitMetafieldValue(metafieldOwners, [
    "quickShipCustom",
    "quickShipFeed",
  ]);
  const application = readExplicitMetafieldValue(metafieldOwners, [
    "application",
    "applicationFeed",
  ]);
  const brand = pickFirstNonEmpty(product.vendor);
  const apparelProduct = isApparelProductType(productType, product.productType);
  const shopifyColorPattern = formatShopifyColorPatternValue(
    variant.shopifyColorPattern ?? product.shopifyColorPattern ?? null,
  );
  const explicitColor = readExplicitMetafieldValue(metafieldOwners, [
    "colorCustom",
    "colorFeed",
  ]);
  const selectedColor = readSelectedOptionValue(variant.selectedOptions, [
    "color",
    "colour",
  ]);
  const explicitSize = readExplicitMetafieldValue(metafieldOwners, [
    "sizeCustom",
    "sizeFeed",
  ]);
  const selectedSize = readSelectedOptionValue(variant.selectedOptions, ["size"]);
  const variantTitleSize = resolveVariantTitleSize(variant.title);
  const shopifySize =
    totalVariants === 1
      ? formatSingleShopifyAttributeValue(
          variant.shopifySize ?? product.shopifySize ?? null,
        )
      : null;
  const color = apparelProduct
    ? pickFirstNonEmpty(
        shopifyColorPattern,
        selectedColor,
        explicitColor,
      )
    : null;
  const size = apparelProduct
    ? totalVariants > 1
      ? pickFirstNonEmpty(selectedSize, variantTitleSize, explicitSize)
      : pickFirstNonEmpty(shopifySize, explicitSize, selectedSize, variantTitleSize)
    : null;
  const productTypeValue = buildProductTypeBreadcrumb(productType, productSubtype);
  const productTypeValues = productTypeValue ? [productTypeValue] : [];
  const gtins = gtin ? [gtin] : [];
  const salePrice = hasSalePrice ? formatMicros(priceAmount, currencyCode) : null;
  const price = formatMicros(
    hasSalePrice ? compareAtAmount : priceAmount,
    currencyCode,
  );
  const costAmount = parseAmount(variant.inventoryItem?.unitCost?.amount ?? null);
  const costOfGoodsSold = formatMicros(
    costAmount,
    variant.inventoryItem?.unitCost?.currencyCode ?? currencyCode,
  );
  const customLabel2 =
    normalizeCustomLabel2(adWordsSpend) ??
    computeMarginCustomLabel2({
      priceAmount,
      costAmount,
    });
  const customLabel0 = resolveAgedQuickShipCustomLabel0({
    quickShipValue: variant.quickShipCustom?.value ?? null,
    lastOrderedAt: product.lastOrderedAtSales?.value ?? null,
  });
  const availabilityMapping = mapProductAvailability({
    metafieldAvailability: variant.productAvailabilityCustom?.value ?? null,
    metafieldAvailabilityDate:
      variant.productAvailabilityDateCustom?.value ?? null,
  });
  const record = {
    offerId: buildShopifyOfferId(productId, variantId),
    contentLanguage: env.googleContentLanguage || "en",
    feedLabel: env.googleFeedLabel || "US",
    customAttributes: [
      {
        name: "variant_id",
        value: variantId,
      },
      {
        name: "product_id",
        value: productId,
      },
    ],
    productAttributes: {
      title: product.title,
      description: stripHtml(product.descriptionHtml),
      link,
      imageLink: primaryImage,
      additionalImageLinks,
      availability: availabilityMapping.availability,
      availabilityDate: availabilityMapping.availabilityDate,
      price: price ?? {
        amountMicros: "0",
        currencyCode,
      },
      salePrice,
      condition: "NEW",
      googleProductCategory,
      productTypes: productTypeValues,
      ageGroup: apparelProduct ? "ADULT" : null,
      color,
      gender: apparelProduct ? "UNISEX" : null,
      brand,
      gtins,
      mpn,
      identifierExists: Boolean(gtin || mpn),
      itemGroupId: productId,
      size,
      sizeSystem: apparelProduct ? "US" : null,
      customLabel0,
      customLabel1: computeHighPriceBucket(priceAmount),
      customLabel2,
      customLabel3: normalizeBooleanish(quickShip) ? "Quick Ship" : null,
      customLabel4: parseEngineLabel({
        title: product.title,
        application,
      }),
      shippingWeight: formatWeight(variant.inventoryItem?.measurement?.weight),
      shippingLabel: buildShippingLabel({
        stateRestrictions,
        quickShip,
        override: availabilityMapping.shippingLabelOverride,
      }),
      costOfGoodsSold,
    },
  } satisfies FeedPreviewRecord;
  const validationIssues = validateFeedRecord({
    record,
    apparelProduct,
  });

  if (validationIssues.length) {
    return {
      excluded: validationIssues[0]?.reason ?? "validation_unknown",
      details: validationIssues.map((issue) => issue.detail),
      link,
    };
  }

  return record;
}

async function fetchAllProductVariants(params: {
  shop: string;
  accessToken: string;
  productId: string;
  initialVariants?: ShopifyVariantNode[];
  afterCursor?: string | null;
}) {
  const variants: ShopifyVariantNode[] = params.initialVariants
    ? [...params.initialVariants]
    : [];
  let cursor: string | null = params.afterCursor ?? null;

  while (true) {
    const payload: ShopifyProductVariantsPayload =
      await runShopifyAdminGraphql<ShopifyProductVariantsPayload>({
        shop: params.shop,
        accessToken: params.accessToken,
        query: SHOPIFY_PRODUCT_VARIANTS_QUERY,
        variables: {
          productId: params.productId,
          first: DETAIL_VARIANT_PAGE_SIZE,
          after: cursor,
        },
      });

    const page = connectionNodes<ShopifyVariantNode>(payload.product?.variants);

    if (page.length === 0) {
      break;
    }

    variants.push(...page);

    const nextCursor: string | null =
      payload.product?.variants?.pageInfo?.endCursor ?? null;

    if (!payload.product?.variants?.pageInfo?.hasNextPage || !nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return variants;
}

function buildShopifyProductGid(productId: string) {
  return `gid://shopify/Product/${productId}`;
}

async function fetchProductDetailsByLegacyIds(params: {
  shop: string;
  accessToken: string;
  productIds: string[];
}) {
  if (!params.productIds.length) {
    return [] as ShopifyProductNode[];
  }

  const detailPayloads = await Promise.all(
    chunkArray(
      params.productIds.map((productId) => buildShopifyProductGid(productId)),
      DETAIL_BATCH_SIZE,
    ).map((batchIds) =>
      runShopifyAdminGraphql<ShopifyProductDetailsPayload>({
        shop: params.shop,
        accessToken: params.accessToken,
        query: SHOPIFY_PRODUCT_DETAILS_QUERY,
        variables: {
          ids: batchIds,
          mediaLimit: DETAIL_MEDIA_LIMIT,
          variantLimit: DETAIL_VARIANT_PAGE_SIZE,
        },
      }),
    ),
  );

  return detailPayloads.flatMap(
    (detailPayload) =>
      detailPayload.nodes?.filter(
        (product): product is ShopifyProductNode => Boolean(product),
      ) ?? [],
  );
}

async function processQueuedProductIds(params: {
  context: SyncExecutionContext;
  productIds: string[];
  artifactSampleLimit: number;
  collectAllRecords?: boolean;
  captureDeleteCandidates?: boolean;
}) {
  const rows: FeedPreviewRecord[] = [];
  const includedSamples: FeedPreviewRecord[] = [];
  const excludedRows: ExcludedPreviewSample[] = [];
  const validationRows: ExcludedPreviewSample[] = [];
  const excludedSamples: ExcludedPreviewSample[] = [];
  const validationSamples: ExcludedPreviewSample[] = [];
  const deleteCandidates: MerchantDeleteTarget[] = [];
  const deleteSamples: DeletePreviewSample[] = [];
  const exclusions: Record<string, number> = {};
  let productsEvaluated = 0;
  let variantsConsidered = 0;
  let recordsPrepared = 0;

  const detailedProducts = await fetchProductDetailsByLegacyIds({
    shop: params.context.shop,
    accessToken: params.context.accessToken,
    productIds: params.productIds,
  });

  for (const product of detailedProducts) {
    const productId = resolveLegacyId(product.legacyResourceId, product.id);
    const productMediaUrls = collectMediaUrls(product);
    const productExclusionReason = findProductExclusionReason(product);
    const initialVariants = connectionNodes<ShopifyVariantNode>(product.variants);
    const variants = product.variants?.pageInfo?.hasNextPage
      ? await fetchAllProductVariants({
          shop: params.context.shop,
          accessToken: params.context.accessToken,
          productId: product.id,
          initialVariants,
          afterCursor: product.variants.pageInfo.endCursor ?? null,
        })
      : initialVariants;

    if (productExclusionReason) {
      if (variants.length === 0) {
        const excludedRow = {
          reason: productExclusionReason,
          productId,
          variantId: null,
          offerId: null,
          handle: product.handle,
          title: product.title,
          variantTitle: null,
          sku: null,
          link: product.onlineStoreUrl ?? null,
        } satisfies ExcludedPreviewSample;
        incrementCounter(exclusions, productExclusionReason);
        collectExcludedSample(excludedSamples, excludedRow);
        excludedRows.push(excludedRow);
      }

      for (const variant of variants) {
        variantsConsidered += 1;
        const deleteTarget = buildDeleteTarget({
          product,
          variant,
          reason: productExclusionReason,
        });
        const excludedRow = {
          reason: productExclusionReason,
          productId,
          variantId: deleteTarget.variantId ?? null,
          offerId: deleteTarget.offerId,
          handle: product.handle,
          title: product.title,
          variantTitle: variant.title,
          sku: variant.sku ?? null,
          link: product.onlineStoreUrl ?? null,
        } satisfies ExcludedPreviewSample;

        incrementCounter(exclusions, productExclusionReason);
        collectExcludedSample(excludedSamples, excludedRow);
        excludedRows.push(excludedRow);
        if (params.captureDeleteCandidates) {
          deleteCandidates.push(deleteTarget);
          collectExcludedSample(deleteSamples, {
            ...excludedRow,
            source: "shopify_scan",
          } satisfies DeletePreviewSample);
        }
      }

      productsEvaluated += 1;
      continue;
    }

    for (const variant of variants) {
      variantsConsidered += 1;

      const record = buildPreviewRecord({
        product,
        variant,
        totalVariants: variants.length,
        storefrontBaseUrl: params.context.storefrontBaseUrl,
        productMediaUrls,
      });

      if ("excluded" in record) {
        const excludedRow = {
          reason: record.excluded,
          details: record.details,
          productId,
          variantId: resolveLegacyId(variant.legacyResourceId, variant.id),
          offerId: buildShopifyOfferId(
            productId,
            resolveLegacyId(variant.legacyResourceId, variant.id),
          ),
          handle: product.handle,
          title: product.title,
          variantTitle: variant.title,
          sku: variant.sku ?? null,
          link: record.link ?? null,
        } satisfies ExcludedPreviewSample;
        incrementCounter(exclusions, record.excluded);
        collectExcludedSample(excludedSamples, excludedRow);
        excludedRows.push(excludedRow);
        if (isValidationExclusionReason(record.excluded)) {
          collectExcludedSample(validationSamples, excludedRow);
          validationRows.push(excludedRow);
        }
        if (params.captureDeleteCandidates) {
          const deleteTarget = buildDeleteTarget({
            product,
            variant,
            reason: record.excluded,
          });
          deleteCandidates.push(deleteTarget);
          collectExcludedSample(deleteSamples, {
            ...excludedRow,
            source: "shopify_scan",
          } satisfies DeletePreviewSample);
        }
        continue;
      }

      recordsPrepared += 1;

      if (params.collectAllRecords) {
        rows.push(record);
      }

      if (includedSamples.length < params.artifactSampleLimit) {
        includedSamples.push(record);
      }
    }

    productsEvaluated += 1;
  }

  return {
    rows,
    includedSamples,
    excludedRows,
    validationRows,
    excludedSamples,
    validationSamples,
    deleteCandidates,
    deleteSamples,
    exclusions,
    productsEvaluated,
    variantsConsidered,
    recordsPrepared,
  };
}

export async function prepareSyncExecutionContext(params: {
  mode: Exclude<SyncMode, "idle">;
  settings: SyncSettings;
  dryRun: boolean;
  effectiveNow?: Date;
  allowDeltaFallback?: boolean;
}) {
  const searchPlan = await buildSearchQuery(params.mode, params.settings, {
    dryRun: params.dryRun,
    now: params.effectiveNow,
    allowDeltaFallback: params.allowDeltaFallback,
  });
  const shop = getConfiguredShopDomain();

  if (!shop) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN.");
  }

  const token = await getRuntimeShopifyAccessToken();

  if (!token) {
    throw new Error(
      "Missing Shopify runtime credentials. Provide SHOPIFY_ADMIN_ACCESS_TOKEN or configure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    );
  }

  const connection = await fetchShopConnectionDetails({
    shop,
    accessToken: token.accessToken,
  });
  const storefrontBaseUrl = connection.connected
    ? connection.shop?.primaryDomainUrl ?? null
    : null;
  let totalProducts: number | null =
    searchPlan.source === "webhook_queue"
      ? searchPlan.productIds?.length ?? 0
      : null;

  if (searchPlan.source !== "webhook_queue") {
    try {
      const countPayload = await runShopifyAdminGraphql<ShopifyProductsCountPayload>({
        shop,
        accessToken: token.accessToken,
        query: SHOPIFY_PRODUCTS_COUNT_QUERY,
        variables: {
          query: searchPlan.query,
        },
      });

      totalProducts = countPayload.productsCount?.count ?? null;
    } catch {
      totalProducts = null;
    }
  }

  return {
    mode: params.mode,
    dryRun: params.dryRun,
    searchPlan,
    query: searchPlan.query,
    lookbackStart: searchPlan.lookbackStart,
    lookbackEnd: searchPlan.lookbackEnd ?? null,
    searchNotes: searchPlan.notes,
    shop,
    accessToken: token.accessToken,
    storefrontBaseUrl,
    totalProducts,
  } satisfies SyncExecutionContext;
}

export async function scanSyncExecutionChunk(params: {
  context: SyncExecutionContext;
  cursor?: string | null;
  maxProducts?: number;
  artifactSampleLimit?: number;
  collectAllRecords?: boolean;
  captureDeleteCandidates?: boolean;
}) {
  const rows: FeedPreviewRecord[] = [];
  const includedSamples: FeedPreviewRecord[] = [];
  const excludedRows: ExcludedPreviewSample[] = [];
  const validationRows: ExcludedPreviewSample[] = [];
  const excludedSamples: ExcludedPreviewSample[] = [];
  const validationSamples: ExcludedPreviewSample[] = [];
  const deleteCandidates: MerchantDeleteTarget[] = [];
  const deleteSamples: DeletePreviewSample[] = [];
  const exclusions: Record<string, number> = {};
  const artifactSampleLimit = Math.max(
    1,
    params.artifactSampleLimit ?? RUN_ARTIFACT_INCLUDED_SAMPLE_LIMIT,
  );
  const maxProducts = Math.max(1, params.maxProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET);
  let cursor = params.cursor ?? null;
  let productsFetched = 0;
  let productsEvaluated = 0;
  let variantsConsidered = 0;
  let recordsPrepared = 0;
  let pagesScanned = 0;
  let scanCompleted = false;
  let estimatedTransferBytes = 0;

  if (params.context.searchPlan.source === "webhook_queue") {
    const queuedProductIds = params.context.searchPlan.productIds ?? [];
    const startIndex =
      cursor && !Number.isNaN(Number.parseInt(cursor, 10))
        ? Number.parseInt(cursor, 10)
        : 0;
    const chunkProductIds = queuedProductIds.slice(
      startIndex,
      startIndex + maxProducts,
    );

    if (chunkProductIds.length === 0) {
      return {
        nextCursor: null,
        scanCompleted: true,
        pagesScanned: 0,
        productsFetched: 0,
        productsEvaluated: 0,
        variantsConsidered: 0,
        recordsPrepared: 0,
        estimatedTransferBytes: 0,
        rows,
        includedSamples,
        excludedRows,
        validationRows,
        excludedSamples,
        validationSamples,
        deleteCandidates,
        deleteSamples,
        exclusions,
      } satisfies SyncChunkScanResult;
    }

    const processed = await processQueuedProductIds({
      context: params.context,
      productIds: chunkProductIds,
      artifactSampleLimit,
      collectAllRecords: params.collectAllRecords,
      captureDeleteCandidates: params.captureDeleteCandidates,
    });
    const nextIndex = startIndex + chunkProductIds.length;

    return {
      nextCursor:
        nextIndex < queuedProductIds.length ? String(nextIndex) : null,
      scanCompleted: nextIndex >= queuedProductIds.length,
      pagesScanned: 1,
      productsFetched: chunkProductIds.length,
      productsEvaluated: processed.productsEvaluated,
      variantsConsidered: processed.variantsConsidered,
      recordsPrepared: processed.recordsPrepared,
      estimatedTransferBytes: 0,
      rows: processed.rows,
      includedSamples: processed.includedSamples,
      excludedRows: processed.excludedRows,
      validationRows: processed.validationRows,
      excludedSamples: processed.excludedSamples,
      validationSamples: processed.validationSamples,
      deleteCandidates: processed.deleteCandidates,
      deleteSamples: processed.deleteSamples,
      exclusions: processed.exclusions,
    } satisfies SyncChunkScanResult;
  }

  while (productsFetched < maxProducts) {
    const payload: ShopifyFeedProductsPayload =
      await runShopifyAdminGraphql<ShopifyFeedProductsPayload>({
        shop: params.context.shop,
        accessToken: params.context.accessToken,
        query: SHOPIFY_PRODUCT_SCAN_QUERY,
        variables: {
          first: SHOPIFY_PAGE_SIZE,
          after: cursor,
          query: params.context.query,
        },
      });
    estimatedTransferBytes += Buffer.byteLength(JSON.stringify(payload), "utf8");
    const products = connectionNodes<ShopifyProductNode>(payload.products);

    if (products.length === 0) {
      scanCompleted = true;
      break;
    }

    pagesScanned += 1;
    productsFetched += products.length;

    const shouldHydrateDetails =
      params.collectAllRecords ||
      params.captureDeleteCandidates ||
      includedSamples.length < artifactSampleLimit;
    const candidateIds: string[] = [];

    for (const product of products) {
      const exclusionReason = findProductExclusionReason(product);

      if (exclusionReason && !shouldHydrateDetails) {
        const excludedRow = {
          reason: exclusionReason,
          productId: resolveLegacyId(product.legacyResourceId, product.id),
          variantId: null,
          offerId: null,
          handle: product.handle,
          title: product.title,
          variantTitle: null,
          sku: null,
          link: product.onlineStoreUrl ?? null,
        } satisfies ExcludedPreviewSample;
        incrementCounter(exclusions, exclusionReason);
        collectExcludedSample(excludedSamples, excludedRow);
        excludedRows.push(excludedRow);
        if (isValidationExclusionReason(exclusionReason)) {
          collectExcludedSample(validationSamples, excludedRow);
          validationRows.push(excludedRow);
        }
        productsEvaluated += 1;
        continue;
      }

      candidateIds.push(product.id);
    }

    const detailPayloads = shouldHydrateDetails
      ? await Promise.all(
          chunkArray(candidateIds, DETAIL_BATCH_SIZE).map((batchIds) =>
            runShopifyAdminGraphql<ShopifyProductDetailsPayload>({
              shop: params.context.shop,
              accessToken: params.context.accessToken,
              query: SHOPIFY_PRODUCT_DETAILS_QUERY,
              variables: {
                ids: batchIds,
                mediaLimit: DETAIL_MEDIA_LIMIT,
                variantLimit: DETAIL_VARIANT_PAGE_SIZE,
              },
            }),
          ),
        )
      : [];

    for (const detailPayload of detailPayloads) {
      estimatedTransferBytes += Buffer.byteLength(
        JSON.stringify(detailPayload),
        "utf8",
      );
      const detailedProducts =
        detailPayload.nodes?.filter(
          (product): product is ShopifyProductNode => Boolean(product),
        ) ?? [];

      for (const product of detailedProducts) {
        const productId = resolveLegacyId(product.legacyResourceId, product.id);
        const productMediaUrls = collectMediaUrls(product);
        const productExclusionReason = findProductExclusionReason(product);
        const initialVariants = connectionNodes<ShopifyVariantNode>(product.variants);
        const variants = product.variants?.pageInfo?.hasNextPage
          ? await fetchAllProductVariants({
              shop: params.context.shop,
              accessToken: params.context.accessToken,
              productId: product.id,
              initialVariants,
              afterCursor: product.variants.pageInfo.endCursor ?? null,
            })
          : initialVariants;

        if (productExclusionReason) {
          if (variants.length === 0) {
            const excludedRow = {
              reason: productExclusionReason,
              productId,
              variantId: null,
              offerId: null,
              handle: product.handle,
              title: product.title,
              variantTitle: null,
              sku: null,
              link: product.onlineStoreUrl ?? null,
            } satisfies ExcludedPreviewSample;
            incrementCounter(exclusions, productExclusionReason);
            collectExcludedSample(excludedSamples, excludedRow);
            excludedRows.push(excludedRow);
          }

          for (const variant of variants) {
            variantsConsidered += 1;
            const deleteTarget = buildDeleteTarget({
              product,
              variant,
              reason: productExclusionReason,
            });
            const excludedRow = {
              reason: productExclusionReason,
              productId,
              variantId: deleteTarget.variantId ?? null,
              offerId: deleteTarget.offerId,
              handle: product.handle,
              title: product.title,
              variantTitle: variant.title,
              sku: variant.sku ?? null,
              link: product.onlineStoreUrl ?? null,
            } satisfies ExcludedPreviewSample;

            incrementCounter(exclusions, productExclusionReason);
            collectExcludedSample(excludedSamples, excludedRow);
            excludedRows.push(excludedRow);
            if (params.captureDeleteCandidates) {
              deleteCandidates.push(deleteTarget);
              collectExcludedSample(deleteSamples, {
                ...excludedRow,
                source: "shopify_scan",
              } satisfies DeletePreviewSample);
            }
          }

          productsEvaluated += 1;
          continue;
        }

        for (const variant of variants) {
          variantsConsidered += 1;

          const record = buildPreviewRecord({
            product,
            variant,
            totalVariants: variants.length,
            storefrontBaseUrl: params.context.storefrontBaseUrl,
            productMediaUrls,
          });

          if ("excluded" in record) {
            const excludedRow = {
              reason: record.excluded,
              details: record.details,
              productId,
              variantId: resolveLegacyId(variant.legacyResourceId, variant.id),
              offerId: buildShopifyOfferId(
                productId,
                resolveLegacyId(variant.legacyResourceId, variant.id),
              ),
              handle: product.handle,
              title: product.title,
              variantTitle: variant.title,
              sku: variant.sku ?? null,
              link: record.link ?? null,
            } satisfies ExcludedPreviewSample;
            incrementCounter(exclusions, record.excluded);
            collectExcludedSample(excludedSamples, excludedRow);
            excludedRows.push(excludedRow);
            if (isValidationExclusionReason(record.excluded)) {
              collectExcludedSample(validationSamples, excludedRow);
              validationRows.push(excludedRow);
            }
            if (params.captureDeleteCandidates) {
              const deleteTarget = buildDeleteTarget({
                product,
                variant,
                reason: record.excluded,
              });
              deleteCandidates.push(deleteTarget);
              collectExcludedSample(deleteSamples, {
                ...excludedRow,
                source: "shopify_scan",
              } satisfies DeletePreviewSample);
            }
            continue;
          }

          recordsPrepared += 1;

          if (params.collectAllRecords) {
            rows.push(record);
          }

          if (includedSamples.length < artifactSampleLimit) {
            includedSamples.push(record);
          }
        }

        productsEvaluated += 1;
      }
    }

    if (!payload.products?.pageInfo?.hasNextPage) {
      scanCompleted = true;
      cursor = null;
      break;
    }

    cursor = payload.products.pageInfo.endCursor;

    if (!cursor) {
      scanCompleted = true;
      break;
    }
  }

  return {
    nextCursor: cursor,
    scanCompleted,
    pagesScanned,
    productsFetched,
    productsEvaluated,
    variantsConsidered,
    recordsPrepared,
    estimatedTransferBytes,
    rows,
    includedSamples,
    excludedRows,
    validationRows,
    excludedSamples,
    validationSamples,
    deleteCandidates,
    deleteSamples,
    exclusions,
  } satisfies SyncChunkScanResult;
}

function createDryRunProgressMessage(params: {
  mode: Exclude<SyncMode, "idle">;
  searchPlan: SyncSearchPlan;
  stage: "counting" | "scanning";
  totalProducts: number | null;
}) {
  if (params.mode === "full") {
    if (params.stage === "counting") {
      return "Counting Shopify products across the full catalog.";
    }

    if (typeof params.totalProducts === "number") {
      return `Found ${params.totalProducts.toLocaleString()} Shopify products across all statuses. Scanning the full catalog.`;
    }

    return "Scanning and normalizing the full catalog.";
  }

  const queuedCount = params.searchPlan.productIds?.length ?? 0;

  if (params.stage === "counting") {
    return queuedCount > 0
      ? `Counting ${queuedCount.toLocaleString()} Shopify products queued by create/update webhooks for delta processing.`
      : "Checking the Shopify webhook queue for queued delta product updates.";
  }

  return queuedCount > 0
    ? `Scanning ${queuedCount.toLocaleString()} Shopify products queued by create/update webhooks for delta processing.`
    : "No Shopify create/update webhooks are queued right now. Delta scanning will only confirm whether webhook-driven deletes are pending.";
}

async function buildDryRunPreview(params: {
  mode: Exclude<SyncMode, "idle">;
  previewLimit: number;
  artifactSampleLimit: number;
  settings: SyncSettings;
  exhaustive: boolean;
  dryRun: boolean;
  effectiveNow?: Date;
  collectAllRecords?: boolean;
  captureDeleteCandidates?: boolean;
  allowDeltaFallback?: boolean;
  onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
}) {
  if (params.onProgress) {
    await params.onProgress({
      stage: "counting",
      exhaustive: params.exhaustive,
      totalProducts: getProgressTargetTotal(params.exhaustive, null),
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message:
        params.mode === "full"
          ? "Counting Shopify products across the full catalog."
          : "Checking the Shopify webhook queue for queued delta product updates.",
    });
  }

  const context = await prepareSyncExecutionContext({
    mode: params.mode,
    settings: params.settings,
    dryRun: params.dryRun,
    effectiveNow: params.effectiveNow,
    allowDeltaFallback: params.allowDeltaFallback,
  });
  const previewTarget = Math.max(params.previewLimit, params.artifactSampleLimit);
  const preview: FeedPreviewRecord[] = [];
  const allRecords: FeedPreviewRecord[] = [];
  const allExcludedRows: ExcludedPreviewSample[] = [];
  const allValidationRows: ExcludedPreviewSample[] = [];
  const validationSamples: ExcludedPreviewSample[] = [];
  const excludedSamples: ExcludedPreviewSample[] = [];
  const deleteSamples: DeletePreviewSample[] = [];
  const deleteCandidates: MerchantDeleteTarget[] = [];
  const exclusions: Record<string, number> = {};
  let cursor: string | null = null;
  let productsFetched = 0;
  let productsEvaluated = 0;
  let variantsConsidered = 0;
  let recordsPrepared = 0;
  let pagesScanned = 0;
  let scanCompleted = false;
  const progressTargetTotal = getProgressTargetTotal(
    params.exhaustive,
    context.totalProducts,
  );
  let lastProgressEvaluated = 0;

  const sendScanningProgress = async (force = false) => {
    if (!params.onProgress) {
      return;
    }

    if (!force && productsEvaluated - lastProgressEvaluated < 25) {
      return;
    }

    lastProgressEvaluated = productsEvaluated;

    await params.onProgress({
      stage: "scanning",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: params.exhaustive
        ? productsEvaluated
        : Math.min(productsEvaluated, progressTargetTotal ?? SHOPIFY_PAGE_SIZE),
      pagesScanned,
      previewRows: preview.length,
      message: createDryRunProgressMessage({
        mode: params.mode,
        searchPlan: context.searchPlan,
        stage: "scanning",
        totalProducts: context.totalProducts,
      }),
    });
  };

  if (params.onProgress) {
    await params.onProgress({
      stage: "scanning",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message: createDryRunProgressMessage({
        mode: params.mode,
        searchPlan: context.searchPlan,
        stage: "scanning",
        totalProducts: context.totalProducts,
      }),
    });
  }

  const maxProductsPerChunk = params.exhaustive
    ? LIVE_SYNC_CHUNK_PRODUCT_TARGET
    : SHOPIFY_PAGE_SIZE;

  while (params.exhaustive || preview.length < previewTarget) {
    const chunk = await scanSyncExecutionChunk({
      context,
      cursor,
      maxProducts: maxProductsPerChunk,
      artifactSampleLimit: params.artifactSampleLimit,
      collectAllRecords: params.collectAllRecords,
      captureDeleteCandidates: params.captureDeleteCandidates,
    });

    cursor = chunk.nextCursor;
    scanCompleted = chunk.scanCompleted;
    pagesScanned += chunk.pagesScanned;
    productsFetched += chunk.productsFetched;
    productsEvaluated += chunk.productsEvaluated;
    variantsConsidered += chunk.variantsConsidered;
    recordsPrepared += chunk.recordsPrepared;

    for (const [reason, count] of Object.entries(chunk.exclusions)) {
      exclusions[reason] = (exclusions[reason] ?? 0) + count;
    }

    if (params.collectAllRecords) {
      allRecords.push(...chunk.rows);
      allExcludedRows.push(...chunk.excludedRows);
      allValidationRows.push(...chunk.validationRows);
    }

    for (const record of chunk.includedSamples) {
      if (preview.length >= previewTarget) {
        break;
      }

      preview.push(record);
    }

    chunk.validationSamples.forEach((row) => {
      collectExcludedSample(validationSamples, row);
    });
    chunk.excludedSamples.forEach((row) => {
      collectExcludedSample(excludedSamples, row);
    });
    chunk.deleteSamples.forEach((row) => {
      collectExcludedSample(deleteSamples, row);
    });
    deleteCandidates.push(...chunk.deleteCandidates);

    await sendScanningProgress();

    if (scanCompleted || !cursor) {
      scanCompleted = true;
      break;
    }
  }

  await sendScanningProgress(true);

  if (params.onProgress) {
    await params.onProgress({
      stage: "complete",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: params.exhaustive
        ? productsEvaluated
        : Math.min(productsEvaluated, progressTargetTotal ?? SHOPIFY_PAGE_SIZE),
      pagesScanned,
      previewRows: preview.length,
      message: scanCompleted
        ? "Catalog scan completed."
        : "Catalog scan stopped before reaching the end of the catalog.",
    });
  }

  return {
    searchPlan: context.searchPlan,
    query: context.query,
    lookbackStart: context.lookbackStart,
    lookbackEnd: context.lookbackEnd ?? null,
    searchNotes: context.searchNotes,
    storefrontBaseUrl: context.storefrontBaseUrl,
    allRecords,
    allExcludedRows,
    allValidationRows,
    deleteCandidates,
    deleteSamples,
    preview: preview.slice(0, params.previewLimit),
    includedSamples: preview.slice(0, params.artifactSampleLimit),
    validationSamples,
    excludedSamples,
    exclusions,
    validationIssues: countValidationIssues(exclusions),
    pagesScanned,
    scanCompleted,
    totalProducts: context.totalProducts,
    productsFetched,
    variantsConsidered,
    recordsPrepared,
  };
}

export function buildSyncNotes(params: {
  dryRun: boolean;
  exhaustive: boolean;
  previewLimit: number;
  scanCompleted: boolean;
  validationIssues: number;
  searchNotes: string[];
  merchant?: MerchantCatalogSyncSummary | null;
  testSavePurpose?: boolean;
}) {
  const notes = [
    ...params.searchNotes,
    "Shopify data is normalized into the Google Merchant API productInputs shape before any live write is attempted.",
    "This build paginates Shopify products in batches of up to 250 using GraphQL cursors.",
    `Product core details are hydrated in batches of ${DETAIL_BATCH_SIZE} products, and each product's variants are paged separately in batches of up to ${DETAIL_VARIANT_PAGE_SIZE}.`,
    "Merchant Center can take several minutes to reflect productInput inserts or deletes after the API call succeeds.",
  ];

  if (params.testSavePurpose) {
    notes.unshift(
      "Test-save runs always stay in dry-run mode and only prepare QA exports.",
    );
  } else if (params.dryRun) {
    notes.unshift(
      "Dry run is enabled. Shopify is scanned live, but no Merchant Center writes are attempted.",
    );
  } else {
    const merchantSummary = params.merchant;
    const writeSummary = merchantSummary
      ? `Live Merchant sync wrote ${merchantSummary.upsertsSucceeded}/${merchantSummary.upsertsAttempted} upserts and ${merchantSummary.deletesSucceeded}/${merchantSummary.deletesAttempted} deletes to ${merchantSummary.dataSourceName}.`
      : "Live Merchant sync mode is enabled.";

    notes.unshift(writeSummary);

    if (merchantSummary?.reconciliationDeletes) {
      notes.push(
        `Full-catalog reconciliation identified ${merchantSummary.reconciliationDeletes} Merchant rows that were missing from the current Shopify feed and queued them for deletion.`,
      );
    }

    if (merchantSummary && merchantSummary.errorCount > 0) {
      notes.unshift(
        `Merchant API returned ${merchantSummary.errorCount} write error(s). Review the run sample before trusting this sync.`,
      );
    } else {
      notes.push("Merchant API writes completed without request-level errors.");
    }
  }

  if (params.exhaustive) {
    notes.push(
      params.scanCompleted
        ? "Exhaustive scan reached the end of the matching Shopify catalog."
        : "Exhaustive scan stopped before reaching the end of the catalog.",
    );
    notes.push(
      `The preview table still shows only ${params.previewLimit} normalized rows even after the exhaustive scan completes.`,
    );
  } else {
    notes.push(
      "Sample preview stops as soon as enough normalized rows have been collected for the requested preview size.",
    );
  }

  if (params.validationIssues > 0) {
    notes.unshift(
      `Feed validation blocked ${params.validationIssues} row(s) from insert/update payloads because required Google fields were missing or invalid.`,
    );
  }

  return notes;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function getDaysUntilNextRun(
  now: Date,
  anchorDate: Date,
  intervalDays: number,
) {
  const daysSinceAnchor = toUtcDayNumber(now) - toUtcDayNumber(anchorDate);

  if (daysSinceAnchor < 0) {
    return Math.abs(daysSinceAnchor);
  }

  const remainder = daysSinceAnchor % intervalDays;

  return remainder === 0 ? 0 : intervalDays - remainder;
}

function getCronRunTimeForUtcDate(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      CRON_HOUR_UTC,
      CRON_MINUTE_UTC,
      0,
      0,
    ),
  );
}

function getDaysUntilDisplayedNextRun(
  now: Date,
  anchorDate: Date,
  intervalDays: number,
) {
  const daysUntilNextRun = getDaysUntilNextRun(now, anchorDate, intervalDays);

  if (daysUntilNextRun !== 0) {
    return daysUntilNextRun;
  }

  const todayCronTime = getCronRunTimeForUtcDate(now);
  return now.getTime() < todayCronTime.getTime() ? 0 : intervalDays;
}

export function decideSyncMode(
  now = new Date(),
  settings: SyncSettings = getDefaultSyncSettings(),
): SyncDecision {
  const anchorDate = parseAnchorDate(settings.anchorDate);
  const daysSinceAnchor = toUtcDayNumber(now) - toUtcDayNumber(anchorDate);

  if (daysSinceAnchor < 0) {
    return {
      mode: "idle",
      anchorDate: anchorDate.toISOString().slice(0, 10),
      daysSinceAnchor,
      reason: `Scheduled syncs will begin on the anchor date ${anchorDate.toISOString().slice(0, 10)}.`,
    };
  }

  if (daysSinceAnchor % settings.fullIntervalDays === 0) {
    return {
      mode: "full",
      anchorDate: anchorDate.toISOString().slice(0, 10),
      daysSinceAnchor,
      reason: `Full refresh is due every ${settings.fullIntervalDays} days.`,
    };
  }

  if (daysSinceAnchor % settings.deltaIntervalDays === 0) {
    return {
      mode: "delta",
      anchorDate: anchorDate.toISOString().slice(0, 10),
      daysSinceAnchor,
      reason: `Delta sync is due every ${settings.deltaIntervalDays} days.`,
    };
  }

  return {
    mode: "idle",
    anchorDate: anchorDate.toISOString().slice(0, 10),
    daysSinceAnchor,
    reason: "No scheduled sync is due today.",
  };
}

export function getUpcomingSyncDates(
  now = new Date(),
  settings: SyncSettings = getDefaultSyncSettings(),
): UpcomingSyncDates {
  const anchorDate = parseAnchorDate(settings.anchorDate);
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  return {
    deltaDate: formatDateOnly(
      addDays(
        todayUtc,
        getDaysUntilDisplayedNextRun(now, anchorDate, settings.deltaIntervalDays),
      ),
    ),
    fullDate: formatDateOnly(
      addDays(
        todayUtc,
        getDaysUntilDisplayedNextRun(now, anchorDate, settings.fullIntervalDays),
      ),
    ),
  };
}

function toHistoryEntry(
  result: SyncRunResult,
  artifactId: string | null,
): SyncHistoryEntry {
  return {
    id: `${result.mode}-${result.startedAt}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger: result.trigger,
    purpose: result.purpose,
    mode: result.mode,
    dryRun: result.dryRun,
    ok: result.ok,
    scope: `${result.scope}${result.exhaustive ? " [exhaustive]" : ""}`,
    query: result.query,
    lookbackStart: result.lookbackStart,
    lookbackEnd: result.lookbackEnd ?? null,
    artifactId,
    exportArtifactId: result.exportArtifactId ?? null,
    notes: result.notes.slice(0, 8),
    stats: result.stats,
  };
}

export async function runSync(
  mode: Exclude<SyncMode, "idle">,
  options: {
    trigger: "cron" | "manual";
    purpose?: SyncHistoryPurpose;
    dryRun?: boolean;
    previewLimit?: number;
    persistHistory?: boolean;
    settings?: SyncSettings;
    exhaustive?: boolean;
    prepareExportArtifact?: boolean;
    effectiveNow?: Date;
    allowDeltaFallback?: boolean;
    onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
  },
): Promise<SyncRunResult> {
  const settings = options.settings ?? (await getSyncSettings());
  const startedAt = new Date().toISOString();
  const effectiveNow = options.effectiveNow ?? new Date(startedAt);
  const purpose = options.purpose ?? "sync";
  const dryRun = purpose === "test-save" ? true : options.dryRun ?? false;
  const exhaustive = dryRun
    ? options.exhaustive ??
      (options.trigger === "cron" ||
        mode === "full" ||
        Boolean(options.prepareExportArtifact))
    : true;
  const previewLimit = Math.max(
    1,
    Math.min(25, options.previewLimit ?? DEFAULT_PREVIEW_LIMIT),
  );
  const artifactSampleLimit =
    options.persistHistory ?? true
      ? RUN_ARTIFACT_INCLUDED_SAMPLE_LIMIT
      : previewLimit;
  const configuration = getConfigurationStatus();
  const exportArtifactId = options.prepareExportArtifact
    ? `${mode}-${startedAt.replaceAll(":", "-")}`
    : null;

  try {
    const previewRun = await buildDryRunPreview({
      mode,
      previewLimit,
      artifactSampleLimit,
      settings,
      exhaustive,
      dryRun,
      effectiveNow,
      collectAllRecords: options.prepareExportArtifact || !dryRun,
      captureDeleteCandidates:
        !dryRun || purpose === "test-save" || (options.persistHistory ?? true),
      allowDeltaFallback: options.allowDeltaFallback,
      onProgress: options.onProgress,
    });
    const excluded = Object.values(previewRun.exclusions).reduce(
      (sum, count) => sum + count,
      0,
    );
    const pendingHardDeleteRecords = await getPendingShopifyDeletes();
    const pendingHardDeleteTargets = pendingHardDeleteRecords.map(
      toPendingDeleteTarget,
    );
    const pendingHardDeleteSamples = pendingHardDeleteRecords.map(
      toPendingDeletePreviewSample,
    );
    const deleteSampleLookup = new Map<string, DeletePreviewSample>();

    previewRun.deleteCandidates.forEach((target, index) => {
      deleteSampleLookup.set(
        buildDeleteTargetKey(target),
        previewRun.deleteSamples[index] ?? toDeletePreviewSample(target, "shopify_scan"),
      );
    });

    pendingHardDeleteTargets.forEach((target, index) => {
      deleteSampleLookup.set(
        buildDeleteTargetKey(target),
        pendingHardDeleteSamples[index] ??
          toDeletePreviewSample(target, "shopify_webhook"),
      );
    });

    const combinedDeleteTargets = [
      ...previewRun.deleteCandidates,
      ...pendingHardDeleteTargets,
    ];
    const sendMerchantProgress = async (
      update: MerchantCatalogSyncProgress,
    ) => {
      if (!options.onProgress) {
        return;
      }

      await options.onProgress({
        stage: "uploading",
        exhaustive,
        totalProducts: previewRun.totalProducts,
        productsScanned: previewRun.productsFetched,
        pagesScanned: previewRun.pagesScanned,
        previewRows: previewRun.preview.length,
        message: update.message,
        merchantPhase: update.phase,
        merchantCompleted: update.completed,
        merchantTotal: update.total,
        merchantErrors: update.errors,
      });
    };
    const merchant = dryRun
      ? null
      : await syncMerchantCatalog({
          upserts: previewRun.allRecords,
          deletes: combinedDeleteTargets,
          reconcileWithExistingProducts: mode === "full",
          onProgress: sendMerchantProgress,
        });
    const deleteSample = merchant
      ? merchant.deleteTargetsSample
          .map((target) => {
            const key = buildDeleteTargetKey(target);
            const existing = deleteSampleLookup.get(key);

            if (existing) {
              return existing;
            }

            return toDeletePreviewSample(
              target,
              target.reason === "missing_from_full_catalog_reconciliation"
                ? "merchant_reconciliation"
                : "shopify_scan",
            );
          })
          .slice(0, RUN_ARTIFACT_EXCLUDED_SAMPLE_LIMIT)
      : Array.from(deleteSampleLookup.values()).slice(
          0,
          RUN_ARTIFACT_EXCLUDED_SAMPLE_LIMIT,
        );

    if (merchant?.deleteTargetKeysSucceeded.length) {
      await removePendingShopifyDeletes(
        pendingHardDeleteTargets.filter((target) =>
          merchant.deleteTargetKeysSucceeded.includes(buildDeleteTargetKey(target)),
        ),
      );
    }
    const notes = buildSyncNotes({
      dryRun,
      exhaustive,
      previewLimit,
      scanCompleted: previewRun.scanCompleted,
      validationIssues: previewRun.validationIssues,
      searchNotes: previewRun.searchNotes,
      merchant,
      testSavePurpose: purpose === "test-save",
    });
    if (pendingHardDeleteTargets.length) {
      notes.unshift(
        `${pendingHardDeleteTargets.length} hard-deleted Shopify variant(s) were queued from webhook events and included in this run's Merchant delete scope.`,
      );
    }
    if (options.effectiveNow) {
      notes.unshift(
        `This test run used an effective timestamp of ${effectiveNow.toISOString()} for delta-window calculation and scheduling simulation.`,
      );
    }

    const result = {
      ok: merchant ? merchant.errorCount === 0 : true,
      trigger: options.trigger,
      purpose,
      mode,
      dryRun,
      exhaustive,
      scope: buildSyncScope(mode, previewRun.searchPlan, settings, exhaustive),
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration,
      notes,
      query: previewRun.query,
      lookbackStart: previewRun.lookbackStart,
      lookbackEnd: previewRun.lookbackEnd ?? null,
      storefrontBaseUrl: previewRun.storefrontBaseUrl,
      stats: {
        pageSize: SHOPIFY_PAGE_SIZE,
        pagesScanned: previewRun.pagesScanned,
        scanCompleted: previewRun.scanCompleted,
        totalProducts: previewRun.totalProducts,
        productsFetched: previewRun.productsFetched,
        variantsConsidered: previewRun.variantsConsidered,
        recordsPrepared: previewRun.recordsPrepared,
        excluded,
        validationIssues: previewRun.validationIssues,
        previewLimit,
        merchantUpsertsAttempted: merchant?.upsertsAttempted,
        merchantUpsertsSucceeded: merchant?.upsertsSucceeded,
        merchantDeletesAttempted: merchant?.deletesAttempted,
        merchantDeletesSucceeded: merchant?.deletesSucceeded,
        merchantReconciliationDeletes: merchant?.reconciliationDeletes,
        merchantWriteErrors: merchant?.errorCount,
      },
      exclusions: previewRun.exclusions,
      preview: previewRun.preview,
      exportArtifactId,
      deleteSample,
      merchant,
    } satisfies SyncRunResult;

    if (exportArtifactId) {
      await writePreviewExportArtifact(exportArtifactId, {
        ok: true,
        mode,
        dryRun,
        exhaustive,
        startedAt,
        finishedAt: result.finishedAt,
        notes,
        query: previewRun.query,
        lookbackStart: previewRun.lookbackStart,
        lookbackEnd: previewRun.lookbackEnd ?? null,
        stats: result.stats,
        exclusions: previewRun.exclusions,
        rows: previewRun.allRecords,
        excludedRows: previewRun.allExcludedRows,
        validationRows: previewRun.allValidationRows,
      } satisfies SyncExportResult);
    }

    if (options.persistHistory ?? true) {
      const artifactId = result.startedAt.replaceAll(":", "-");
      const artifact: SyncRunArtifact = {
        id: artifactId,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        trigger: result.trigger,
        purpose: result.purpose,
        mode: result.mode,
        dryRun: result.dryRun,
        exhaustive: result.exhaustive,
        ok: result.ok,
        scope: result.scope,
        query: result.query,
        lookbackStart: result.lookbackStart,
        lookbackEnd: result.lookbackEnd ?? null,
        exportArtifactId: result.exportArtifactId ?? null,
        notes: result.notes,
        stats: result.stats,
        includedSample: previewRun.includedSamples,
        validationSample: previewRun.validationSamples,
        excludedSample: previewRun.excludedSamples,
        deleteSample: result.deleteSample ?? [],
        deleteSampleMode: "candidate",
        merchant: result.merchant ?? null,
      };

      await writeRunArtifact(artifactId, artifact);
      await appendSyncHistory(toHistoryEntry(result, artifactId));
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sync execution error.";
    const search = await buildSearchQuery(mode, settings, {
      dryRun,
      now: effectiveNow,
      allowDeltaFallback: options.allowDeltaFallback,
    }).catch(() => ({
      query: mode === "full" ? "" : "",
      lookbackStart: null,
      lookbackEnd: null,
      source: mode === "full" ? "full_catalog" : "live_sync_checkpoint",
      notes: [],
    } satisfies SyncSearchPlan));

    const result = {
      ok: false,
      trigger: options.trigger,
      purpose,
      mode,
      dryRun,
      exhaustive,
      scope: buildSyncScope(mode, search, settings, exhaustive),
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration,
      notes: [
        ...(options.effectiveNow
          ? [
              `This test run used an effective timestamp of ${effectiveNow.toISOString()} for delta-window calculation and scheduling simulation.`,
            ]
          : []),
        ...search.notes,
        `Sync execution failed: ${message}`,
        ...(dryRun
          ? ["No Merchant Center writes were attempted because this run stayed in dry-run mode."]
          : ["Merchant Center writes may be partial if the failure happened after some requests were sent."]),
      ],
      query: search.query,
      lookbackStart: search.lookbackStart,
      lookbackEnd: search.lookbackEnd ?? null,
      storefrontBaseUrl: null,
      stats: {
        pageSize: SHOPIFY_PAGE_SIZE,
        pagesScanned: 0,
        scanCompleted: false,
        totalProducts: null,
        productsFetched: 0,
        variantsConsidered: 0,
        recordsPrepared: 0,
        excluded: 0,
        validationIssues: 0,
        previewLimit,
      },
      exclusions: {},
      preview: [],
      exportArtifactId: null,
      merchant: null,
    } satisfies SyncRunResult;

    if (options.persistHistory ?? true) {
      const artifactId = result.startedAt.replaceAll(":", "-");
      const artifact: SyncRunArtifact = {
        id: artifactId,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        trigger: result.trigger,
        purpose: result.purpose,
        mode: result.mode,
        dryRun: result.dryRun,
        exhaustive: result.exhaustive,
        ok: result.ok,
        scope: result.scope,
        query: result.query,
        lookbackStart: result.lookbackStart,
        lookbackEnd: result.lookbackEnd ?? null,
        exportArtifactId: result.exportArtifactId ?? null,
        notes: result.notes,
        stats: result.stats,
        includedSample: [],
        validationSample: [],
        excludedSample: [],
        deleteSample: [],
        deleteSampleMode: "candidate",
      };

      await writeRunArtifact(artifactId, artifact);
      await appendSyncHistory(toHistoryEntry(result, artifactId));
    }

    return result;
  }
}

export async function runSyncExport(
  mode: Exclude<SyncMode, "idle">,
  options?: {
    dryRun?: boolean;
    settings?: SyncSettings;
  },
): Promise<SyncExportResult> {
  const settings = options?.settings ?? (await getSyncSettings());
  const startedAt = new Date().toISOString();
  const effectiveNow = new Date(startedAt);
  const dryRun = options?.dryRun ?? false;
  const exhaustive = true;

  const previewRun = await buildDryRunPreview({
    mode,
    previewLimit: DEFAULT_PREVIEW_LIMIT,
    artifactSampleLimit: 1,
    settings,
    exhaustive,
    dryRun,
    effectiveNow,
    collectAllRecords: true,
    allowDeltaFallback: true,
  });
  const excluded = Object.values(previewRun.exclusions).reduce(
    (sum, count) => sum + count,
    0,
  );

  return {
    ok: true,
    mode,
    dryRun,
    exhaustive,
    startedAt,
    finishedAt: new Date().toISOString(),
    notes: buildSyncNotes({
      dryRun,
      exhaustive,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
      scanCompleted: previewRun.scanCompleted,
      validationIssues: previewRun.validationIssues,
      searchNotes: previewRun.searchNotes,
      merchant: null,
    }),
    query: previewRun.query,
    lookbackStart: previewRun.lookbackStart,
    lookbackEnd: previewRun.lookbackEnd ?? null,
    stats: {
      pageSize: SHOPIFY_PAGE_SIZE,
      pagesScanned: previewRun.pagesScanned,
      scanCompleted: previewRun.scanCompleted,
      totalProducts: previewRun.totalProducts,
      productsFetched: previewRun.productsFetched,
      variantsConsidered: previewRun.variantsConsidered,
      recordsPrepared: previewRun.recordsPrepared,
      excluded,
      validationIssues: previewRun.validationIssues,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
    },
    exclusions: previewRun.exclusions,
    rows: previewRun.allRecords,
    excludedRows: previewRun.allExcludedRows,
    validationRows: previewRun.allValidationRows,
  };
}
