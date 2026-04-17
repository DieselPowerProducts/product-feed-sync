import { env, getConfigurationStatus } from "@/lib/env";
import { resolveGoogleProductCategoryId } from "@/lib/google-taxonomy";
import {
  appendSyncHistory,
  getSyncSettings,
  writePreviewExportArtifact,
  writeRunArtifact,
  type SyncHistoryPurpose,
  type SyncHistoryEntry,
  type SyncSettings,
} from "@/lib/operator-store";
import {
  fetchShopConnectionDetails,
  getConfiguredShopDomain,
  getRuntimeShopifyAccessToken,
  runShopifyAdminGraphql,
} from "@/lib/shopify";

const MS_PER_DAY = 86_400_000;
const FALLBACK_ANCHOR_DATE = "2026-03-10";
const SHOPIFY_PAGE_SIZE = 250;
const CRON_HOUR_UTC = 9;
const CRON_MINUTE_UTC = 0;
export const DEFAULT_PREVIEW_LIMIT = 5;
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
              inventoryPolicy
              inventoryQuantity
              availableForSale
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
            inventoryPolicy
            inventoryQuantity
            availableForSale
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
    availability: "IN_STOCK" | "OUT_OF_STOCK";
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
  exportArtifactId?: string | null;
  notes: string[];
  stats: SyncRunResult["stats"];
  includedSample: FeedPreviewRecord[];
  validationSample: ExcludedPreviewSample[];
  excludedSample: ExcludedPreviewSample[];
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
  };
  exclusions: Record<string, number>;
  preview: FeedPreviewRecord[];
  exportArtifactId?: string | null;
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
  stats: SyncRunResult["stats"];
  exclusions: Record<string, number>;
  rows: FeedPreviewRecord[];
  excludedRows?: ExcludedPreviewSample[];
  validationRows?: ExcludedPreviewSample[];
}

export interface SyncProgressUpdate {
  stage: "counting" | "scanning" | "complete";
  exhaustive: boolean;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  previewRows: number;
  message: string;
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
  inventoryPolicy: string | null;
  inventoryQuantity: number | null;
  availableForSale: boolean;
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
    defaultDryRun: env.defaultDryRun,
    lookbackDays: env.lookbackDays,
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

function collectExcludedSample(
  samples: ExcludedPreviewSample[],
  sample: ExcludedPreviewSample,
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

function determineAvailability(variant: ShopifyVariantNode) {
  return variant.availableForSale ? ("in_stock" as const) : ("out_of_stock" as const);
}

function computePriceBucket(price: number) {
  if (price <= 200) {
    return "0 - 200";
  }

  if (price <= 365) {
    return "200 - 365";
  }

  return "365+";
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
}) {
  const { stateRestrictions, quickShip } = params;

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

function countValidationIssues(exclusions: Record<string, number>) {
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
  const normalizedTags = product.tags.map((tag) => tag.trim().toLowerCase());

  if (normalizedTags.includes("google_exclude")) {
    return "google_exclude_tag";
  }

  if (normalizeBooleanish(product.seoHidden?.value ?? null)) {
    return "seo_hidden_metafield";
  }

  return null;
}

function buildSyncScope(
  mode: Exclude<SyncMode, "idle">,
  lookbackStart: string | null,
  settings: SyncSettings,
  exhaustive: boolean,
) {
  if (mode === "full") {
    return exhaustive
      ? "Active Shopify products with online-store URLs, scanned across all matching pages in paginated batches of up to 250."
      : "Active Shopify products with online-store URLs, sampled from the full catalog in paginated batches of up to 250.";
  }

  return lookbackStart
    ? exhaustive
      ? `Active Shopify products updated after ${lookbackStart}, scanned across all matching pages.`
      : `Active Shopify products updated after ${lookbackStart}, sampled until the preview row target is met.`
    : `Products created or updated in the last ${settings.lookbackDays} day(s).`;
}

function buildSearchQuery(
  mode: Exclude<SyncMode, "idle">,
  settings: SyncSettings,
  now = new Date(),
) {
  if (mode === "full") {
    return {
      query: "status:active",
      lookbackStart: null,
    };
  }

  const lookbackStart = new Date(
    now.getTime() - settings.lookbackDays * MS_PER_DAY,
  );

  return {
    query: `status:active updated_at:>'${lookbackStart.toISOString()}'`,
    lookbackStart: lookbackStart.toISOString(),
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
  const link = normalizeStorefrontUrl({
    fallbackHandle: product.handle,
    onlineStoreUrl: product.onlineStoreUrl,
    storefrontBaseUrl,
    variantId,
  });

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
  const productTypeValues = productType ? [productType] : [];
  const gtins = gtin ? [gtin] : [];
  const salePrice = hasSalePrice ? formatMicros(priceAmount, currencyCode) : null;
  const price = formatMicros(
    hasSalePrice ? compareAtAmount : priceAmount,
    currencyCode,
  );
  const costOfGoodsSold = formatMicros(
    parseAmount(variant.inventoryItem?.unitCost?.amount ?? null),
    variant.inventoryItem?.unitCost?.currencyCode ?? currencyCode,
  );
  const record = {
    offerId: `shopify_ZZ_${productId}_${variantId}`,
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
      availability:
        determineAvailability(variant) === "in_stock" ? "IN_STOCK" : "OUT_OF_STOCK",
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
      customLabel0: computePriceBucket(priceAmount),
      customLabel1: computeHighPriceBucket(priceAmount),
      customLabel2: normalizeCustomLabel2(adWordsSpend),
      customLabel3: normalizeBooleanish(quickShip) ? "Quick Ship" : null,
      customLabel4: parseEngineLabel({
        title: product.title,
        application,
      }),
      shippingWeight: formatWeight(variant.inventoryItem?.measurement?.weight),
      shippingLabel: buildShippingLabel({
        stateRestrictions,
        quickShip,
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

async function buildDryRunPreview(params: {
  mode: Exclude<SyncMode, "idle">;
  previewLimit: number;
  artifactSampleLimit: number;
  settings: SyncSettings;
  exhaustive: boolean;
  effectiveNow?: Date;
  collectAllRecords?: boolean;
  onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
}) {
  const createProgressMessage = (
    stage: "counting" | "scanning",
    totalProductsValue: number | null,
  ) => {
    if (params.mode === "full") {
      if (stage === "counting") {
        return "Counting active Shopify products in the full catalog.";
      }

      if (typeof totalProductsValue === "number") {
        return `Found ${totalProductsValue.toLocaleString()} matching products. Scanning and normalizing the full catalog.`;
      }

      return "Scanning and normalizing the full catalog.";
    }

    if (stage === "counting") {
      return `Counting Shopify products updated in the last ${params.settings.lookbackDays} day(s).`;
    }

    if (typeof totalProductsValue === "number") {
      return `Found ${totalProductsValue.toLocaleString()} products in the current delta window. Scanning and normalizing matches.`;
    }

    return `Scanning Shopify products updated in the last ${params.settings.lookbackDays} day(s).`;
  };

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
  const search = buildSearchQuery(
    params.mode,
    params.settings,
    params.effectiveNow,
  );
  const preview: FeedPreviewRecord[] = [];
  const allRecords: FeedPreviewRecord[] = [];
  const allExcludedRows: ExcludedPreviewSample[] = [];
  const allValidationRows: ExcludedPreviewSample[] = [];
  const validationSamples: ExcludedPreviewSample[] = [];
  const excludedSamples: ExcludedPreviewSample[] = [];
  const exclusions: Record<string, number> = {};
  let totalProducts: number | null = null;
  let cursor: string | null = null;
  let productsFetched = 0;
  let variantsConsidered = 0;
  let recordsPrepared = 0;
  let pagesScanned = 0;
  let productsEvaluated = 0;
  let scanCompleted = false;
  let progressTargetTotal = getProgressTargetTotal(params.exhaustive, totalProducts);
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
      message: createProgressMessage("scanning", totalProducts),
    });
  };

  if (params.onProgress) {
    await params.onProgress({
      stage: "counting",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message: createProgressMessage("counting", totalProducts),
    });
  }

  try {
    const countPayload = await runShopifyAdminGraphql<ShopifyProductsCountPayload>({
      shop,
      accessToken: token.accessToken,
      query: SHOPIFY_PRODUCTS_COUNT_QUERY,
      variables: {
        query: search.query,
      },
    });

    totalProducts = countPayload.productsCount?.count ?? null;
  } catch {
    totalProducts = null;
  }

  progressTargetTotal = getProgressTargetTotal(params.exhaustive, totalProducts);

  if (params.onProgress) {
    await params.onProgress({
      stage: "scanning",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message: createProgressMessage("scanning", totalProducts),
    });
  }

  while (params.exhaustive || preview.length < params.artifactSampleLimit) {
    const payload: ShopifyFeedProductsPayload =
      await runShopifyAdminGraphql<ShopifyFeedProductsPayload>({
        shop,
        accessToken: token.accessToken,
        query: SHOPIFY_PRODUCT_SCAN_QUERY,
        variables: {
          first: SHOPIFY_PAGE_SIZE,
          after: cursor,
          query: search.query,
        },
      });
    const products = connectionNodes<ShopifyProductNode>(payload.products);

    if (products.length === 0) {
      scanCompleted = true;
      break;
    }

    pagesScanned += 1;
    productsFetched += products.length;

    const candidateIds: string[] = [];

    for (const product of products) {
      const exclusionReason = findProductExclusionReason(product);

      if (exclusionReason) {
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
        if (params.collectAllRecords) {
          allExcludedRows.push(excludedRow);
        }
        if (isValidationExclusionReason(exclusionReason)) {
          collectExcludedSample(validationSamples, excludedRow);
          if (params.collectAllRecords) {
            allValidationRows.push(excludedRow);
          }
        }
        productsEvaluated += 1;
        continue;
      }

      candidateIds.push(product.id);
    }

    const shouldHydrateDetails =
      params.collectAllRecords || preview.length < params.artifactSampleLimit;

    const detailPayloads = shouldHydrateDetails
      ? await Promise.all(
          chunkArray(candidateIds, DETAIL_BATCH_SIZE).map((batchIds) =>
            runShopifyAdminGraphql<ShopifyProductDetailsPayload>({
              shop,
              accessToken: token.accessToken,
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
      const detailedProducts =
        detailPayload.nodes?.filter(
          (product): product is ShopifyProductNode => Boolean(product),
        ) ?? [];

      for (const product of detailedProducts) {
        const productId = resolveLegacyId(product.legacyResourceId, product.id);
        const productMediaUrls = collectMediaUrls(product);
        const initialVariants = connectionNodes<ShopifyVariantNode>(product.variants);
        const variants = product.variants?.pageInfo?.hasNextPage
          ? await fetchAllProductVariants({
              shop,
              accessToken: token.accessToken,
              productId: product.id,
              initialVariants,
              afterCursor: product.variants.pageInfo.endCursor ?? null,
            })
          : initialVariants;

        for (const variant of variants) {
          variantsConsidered += 1;

          const record = buildPreviewRecord({
            product,
            variant,
            totalVariants: variants.length,
            storefrontBaseUrl,
            productMediaUrls,
          });

          if ("excluded" in record) {
            const excludedRow = {
              reason: record.excluded,
              details: record.details,
              productId: productId,
              variantId: resolveLegacyId(variant.legacyResourceId, variant.id),
              offerId: `shopify_ZZ_${productId}_${resolveLegacyId(variant.legacyResourceId, variant.id)}`,
              handle: product.handle,
              title: product.title,
              variantTitle: variant.title,
              sku: variant.sku ?? null,
              link: record.link ?? null,
            } satisfies ExcludedPreviewSample;
            incrementCounter(exclusions, record.excluded);
            collectExcludedSample(excludedSamples, excludedRow);
            if (params.collectAllRecords) {
              allExcludedRows.push(excludedRow);
            }
            if (isValidationExclusionReason(record.excluded)) {
              collectExcludedSample(validationSamples, excludedRow);
              if (params.collectAllRecords) {
                allValidationRows.push(excludedRow);
              }
            }
            continue;
          }

          recordsPrepared += 1;

          if (params.collectAllRecords) {
            allRecords.push(record);
          }

          if (preview.length < params.artifactSampleLimit) {
            preview.push(record);
          }

          if (!params.exhaustive && preview.length >= params.artifactSampleLimit) {
            break;
          }
        }

        productsEvaluated += 1;
        await sendScanningProgress();

        if (!params.exhaustive && preview.length >= params.artifactSampleLimit) {
          break;
        }
      }

      if (!params.exhaustive && preview.length >= params.artifactSampleLimit) {
        break;
      }
    }

    if (!payload.products?.pageInfo?.hasNextPage) {
      scanCompleted = true;
      break;
    }

    cursor = payload.products.pageInfo.endCursor;

    if (!cursor) {
      scanCompleted = true;
      break;
    }

    await sendScanningProgress();
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
    query: search.query,
    lookbackStart: search.lookbackStart,
    storefrontBaseUrl,
    allRecords,
    allExcludedRows,
    allValidationRows,
    preview: preview.slice(0, params.previewLimit),
    includedSamples: preview.slice(0, params.artifactSampleLimit),
    validationSamples,
    excludedSamples,
    exclusions,
    validationIssues: countValidationIssues(exclusions),
    pagesScanned,
    scanCompleted,
    totalProducts,
    productsFetched,
    variantsConsidered,
    recordsPrepared,
  };
}

function buildSyncNotes(params: {
  dryRun: boolean;
  exhaustive: boolean;
  previewLimit: number;
  scanCompleted: boolean;
  validationIssues: number;
}) {
  const notes = [
    "Dry-run preview fetched live Shopify data and normalized it toward the Google Merchant API productInputs shape.",
    "This build paginates Shopify products in batches of up to 250 using GraphQL cursors.",
    `Product core details are hydrated in batches of ${DETAIL_BATCH_SIZE} products, and each product's variants are paged separately in batches of up to ${DETAIL_VARIANT_PAGE_SIZE}.`,
    "No Google Merchant API writes run yet. The next step is posting the validated records to a Merchant API data source.",
  ];

  if (params.dryRun) {
    notes.unshift(
      "Dry run is enabled. This is the safest mode for previewing mappings before any live feed writes.",
    );
  } else {
    notes.unshift(
      "Dry run is disabled, but this build still does not perform Google writes yet.",
    );
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
      `Feed validation blocked ${params.validationIssues} row(s) because required Google fields were missing or invalid. Open the run sample for the affected products.`,
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
  const daysSinceAnchor = Math.max(
    0,
    toUtcDayNumber(now) - toUtcDayNumber(anchorDate),
  );
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
  const daysSinceAnchor = Math.max(
    0,
    toUtcDayNumber(now) - toUtcDayNumber(anchorDate),
  );

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
    onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
  },
): Promise<SyncRunResult> {
  const settings = options.settings ?? (await getSyncSettings());
  const startedAt = new Date().toISOString();
  const purpose = options.purpose ?? "sync";
  const dryRun = options.dryRun ?? settings.defaultDryRun;
  const exhaustive = options.exhaustive ?? (options.trigger === "cron" || mode === "full");
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
      effectiveNow: options.effectiveNow,
      collectAllRecords: options.prepareExportArtifact,
      onProgress: options.onProgress,
    });
    const excluded = Object.values(previewRun.exclusions).reduce(
      (sum, count) => sum + count,
      0,
    );
    const notes = buildSyncNotes({
      dryRun,
      exhaustive,
      previewLimit,
      scanCompleted: previewRun.scanCompleted,
      validationIssues: previewRun.validationIssues,
    });
    if (options.effectiveNow) {
      notes.unshift(
        `This test run used an effective timestamp of ${options.effectiveNow.toISOString()} for delta-window calculation and scheduling simulation.`,
      );
    }

    const result = {
      ok: true,
      trigger: options.trigger,
      purpose,
      mode,
      dryRun,
      exhaustive,
      scope: buildSyncScope(mode, previewRun.lookbackStart, settings, exhaustive),
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration,
      notes,
      query: previewRun.query,
      lookbackStart: previewRun.lookbackStart,
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
      },
      exclusions: previewRun.exclusions,
      preview: previewRun.preview,
      exportArtifactId,
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
        exportArtifactId: result.exportArtifactId ?? null,
        notes: result.notes,
        stats: result.stats,
        includedSample: previewRun.includedSamples,
        validationSample: previewRun.validationSamples,
        excludedSample: previewRun.excludedSamples,
      };

      await writeRunArtifact(artifactId, artifact);
      await appendSyncHistory(toHistoryEntry(result, artifactId));
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sync execution error.";
    const search = buildSearchQuery(mode, settings, options.effectiveNow);

    const result = {
      ok: false,
      trigger: options.trigger,
      purpose,
      mode,
      dryRun,
      exhaustive,
      scope: buildSyncScope(mode, null, settings, exhaustive),
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration,
      notes: [
        ...(options.effectiveNow
          ? [
              `This test run used an effective timestamp of ${options.effectiveNow.toISOString()} for delta-window calculation and scheduling simulation.`,
            ]
          : []),
        `Shopify preview fetch failed: ${message}`,
        "The current code only supports read-only Shopify dry runs. No Google writes were attempted.",
      ],
      query: search.query,
      lookbackStart: search.lookbackStart,
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
        exportArtifactId: result.exportArtifactId ?? null,
        notes: result.notes,
        stats: result.stats,
        includedSample: [],
        validationSample: [],
        excludedSample: [],
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
  const dryRun = options?.dryRun ?? settings.defaultDryRun;
  const exhaustive = true;

  const previewRun = await buildDryRunPreview({
    mode,
    previewLimit: DEFAULT_PREVIEW_LIMIT,
    artifactSampleLimit: 1,
    settings,
    exhaustive,
    collectAllRecords: true,
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
    }),
    query: previewRun.query,
    lookbackStart: previewRun.lookbackStart,
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
