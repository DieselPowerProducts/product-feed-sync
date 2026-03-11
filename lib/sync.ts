import { env, getConfigurationStatus } from "@/lib/env";
import {
  appendSyncHistory,
  getSyncSettings,
  writeRunArtifact,
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
const DEFAULT_PREVIEW_LIMIT = 5;
const RUN_ARTIFACT_SAMPLE_LIMIT = 50;
const DETAIL_BATCH_SIZE = 5;
const DETAIL_VARIANT_PAGE_SIZE = SHOPIFY_PAGE_SIZE;
const DETAIL_MEDIA_LIMIT = 5;
const DETAIL_METAFIELD_LIMIT = 20;
const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const GOOGLE_MPN_METAFIELD_NAMESPACE = "mm-google-shopping";
const GOOGLE_MPN_METAFIELD_KEY = "mpn";

const GOOGLE_PRODUCT_CATEGORY_IDS: Record<string, number> = {
  "motor vehicle parts": 899,
  "motor vehicle engine parts": 2820,
  "motor vehicle fuel systems": 2727,
  "motor vehicle transmission & drivetrain parts": 2641,
};

const EXCLUDED_TITLE_PHRASES = [
  { phrase: "red head return shipping", reason: "return_shipping_product" },
  { phrase: "return shipping", reason: "return_shipping_product" },
  { phrase: "extend warranty", reason: "warranty_product" },
  { phrase: "warranty", reason: "warranty_product" },
  { phrase: "loop", reason: "loop_product" },
] as const;

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
        }
      }
    }
  }
`;

const SHOPIFY_PRODUCT_DETAILS_QUERY = `
  query FeedProductDetails($ids: [ID!]!, $mediaLimit: Int!, $metafieldLimit: Int!) {
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
        googleMpn: metafield(namespace: "${GOOGLE_MPN_METAFIELD_NAMESPACE}", key: "${GOOGLE_MPN_METAFIELD_KEY}") {
          value
        }
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
        metafields(first: $metafieldLimit) {
          edges {
            node {
              namespace
              key
              value
              type
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
            barcode
            price
            compareAtPrice
            inventoryPolicy
            inventoryQuantity
            availableForSale
            googleMpn: metafield(namespace: "${GOOGLE_MPN_METAFIELD_NAMESPACE}", key: "${GOOGLE_MPN_METAFIELD_KEY}") {
              value
            }
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

export interface FeedPreviewRecord {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
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
    brand: string | null;
    gtins: string[];
    mpn: string | null;
    identifierExists: boolean;
    itemGroupId: string;
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
  productId: string;
  variantId: string | null;
  offerId: string | null;
  handle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
}

export interface SyncRunArtifact {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  exhaustive: boolean;
  ok: boolean;
  scope: string;
  query: string;
  lookbackStart: string | null;
  notes: string[];
  stats: SyncRunResult["stats"];
  includedSample: FeedPreviewRecord[];
  excludedSample: ExcludedPreviewSample[];
}

export interface SyncRunResult {
  ok: boolean;
  trigger: "cron" | "manual";
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
    previewLimit: number;
  };
  exclusions: Record<string, number>;
  preview: FeedPreviewRecord[];
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

interface ShopifyMetafieldNode {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

interface ShopifySingleMetafieldValue {
  value: string | null;
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

interface ShopifyVariantNode {
  id: string;
  legacyResourceId: string | null;
  title: string;
  sku: string | null;
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
  metafields?: ShopifyConnection<ShopifyMetafieldNode>;
  inventoryItem?: {
    measurement?: {
      weight?: ShopifyWeight | null;
    } | null;
    unitCost?: ShopifyMoney | null;
  } | null;
}

interface ShopifyProductNode {
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
  googleMpn?: ShopifySingleMetafieldValue | null;
  featuredMedia?: ShopifyMediaNode | null;
  media?: ShopifyConnection<ShopifyMediaNode>;
  metafields?: ShopifyConnection<ShopifyMetafieldNode>;
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
    previewLimit: DEFAULT_PREVIEW_LIMIT,
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
) {
  if (samples.length >= RUN_ARTIFACT_SAMPLE_LIMIT) {
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

function normalizeGoogleProductCategory(value: string | null) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  const mappedId = GOOGLE_PRODUCT_CATEGORY_IDS[normalized.toLowerCase()];
  return mappedId ? String(mappedId) : normalized;
}

function collectMetafieldLookup(
  ...metafieldSets: Array<ShopifyConnection<ShopifyMetafieldNode> | null | undefined>
) {
  const lookup = new Map<string, string>();

  for (const metafield of metafieldSets.flatMap((set) => connectionNodes(set))) {
    const value = normalizeText(metafield.value);

    if (!value) {
      continue;
    }

    const namespacedKey = `${metafield.namespace}.${metafield.key}`.toLowerCase();
    const simpleKey = metafield.key.toLowerCase();

    if (!lookup.has(namespacedKey)) {
      lookup.set(namespacedKey, value);
    }

    if (!lookup.has(simpleKey)) {
      lookup.set(simpleKey, value);
    }
  }

  return lookup;
}

function readMappedValue(lookup: Map<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = lookup.get(key.toLowerCase());

    if (value) {
      return value;
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
  if (variant.availableForSale) {
    return "in_stock" as const;
  }

  if ((variant.inventoryQuantity ?? 0) > 0) {
    return "in_stock" as const;
  }

  if ((variant.inventoryPolicy ?? "").toUpperCase() === "CONTINUE") {
    return "in_stock" as const;
  }

  return "out_of_stock" as const;
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

function parseEngineLabel(title: string) {
  const normalizedTitle = title.toLowerCase();

  if (normalizedTitle.includes("cummins")) {
    return "Cummins";
  }

  if (normalizedTitle.includes("powerstroke")) {
    return "Powerstroke";
  }

  if (normalizedTitle.includes("duramax")) {
    return "Duramax";
  }

  if (normalizedTitle.includes("ecodiesel")) {
    return "Ecodiesel";
  }

  return null;
}

function normalizeGtin(value: string | null | undefined) {
  const digitsOnly = normalizeText(value).replace(/\D/g, "");

  if (!digitsOnly) {
    return null;
  }

  return VALID_GTIN_LENGTHS.has(digitsOnly.length) ? digitsOnly : null;
}

function findProductExclusionReason(product: ShopifyProductNode) {
  const normalizedTags = product.tags.map((tag) => tag.trim().toLowerCase());

  if (normalizedTags.includes("google_exclude")) {
    return "google_exclude_tag";
  }

  const haystack = [
    product.title,
    product.vendor,
    product.productType,
    normalizedTags.join(" "),
  ]
    .map((value) => normalizeText(value))
    .join(" ")
    .toLowerCase();

  for (const rule of EXCLUDED_TITLE_PHRASES) {
    if (haystack.includes(rule.phrase)) {
      return rule.reason;
    }
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
) {
  if (mode === "full") {
    return {
      query: "status:active",
      lookbackStart: null,
    };
  }

  const lookbackStart = new Date(Date.now() - settings.lookbackDays * MS_PER_DAY);

  return {
    query: `status:active updated_at:>'${lookbackStart.toISOString()}'`,
    lookbackStart: lookbackStart.toISOString(),
  };
}

function buildPreviewRecord(params: {
  product: ShopifyProductNode;
  variant: ShopifyVariantNode;
  storefrontBaseUrl: string | null;
  productMetafields: Map<string, string>;
  productMediaUrls: string[];
}): FeedPreviewRecord | { excluded: string } {
  const { product, variant, storefrontBaseUrl, productMetafields, productMediaUrls } =
    params;

  const variantId = resolveLegacyId(variant.legacyResourceId, variant.id);
  const productId = resolveLegacyId(product.legacyResourceId, product.id);
  const variantMetafields = collectMetafieldLookup(variant.metafields);
  const primaryImage =
    pickFirstNonEmpty(variant.image?.url ?? null, productMediaUrls[0] ?? null) ??
    null;

  if (!primaryImage) {
    return { excluded: "missing_image" };
  }

  const priceAmount = parseAmount(variant.price);

  if (priceAmount === null || priceAmount <= 0) {
    return { excluded: "zero_price" };
  }

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
    return { excluded: "missing_online_store_url" };
  }

  const additionalImage =
    productMediaUrls.find((url) => url !== primaryImage) ?? null;
  const mergedMetafields = new Map(productMetafields);

  for (const [key, value] of variantMetafields.entries()) {
    if (!mergedMetafields.has(key)) {
      mergedMetafields.set(key, value);
    }
  }

  const googleProductCategory = normalizeGoogleProductCategory(
    readMappedValue(mergedMetafields, [
      "google_product_type",
      "custom.google_product_type",
      "feed.google_product_type",
    ]),
  );
  const productType =
    readMappedValue(mergedMetafields, [
      "product_type",
      "custom.product_type",
      "feed.product_type",
    ]) ?? normalizeText(product.productType) ?? null;
  const gtin =
    normalizeGtin(variant.barcode) ??
    normalizeGtin(readMappedValue(mergedMetafields, ["gtin"]));
  const mpn = pickFirstNonEmpty(
    variant.googleMpn?.value ?? null,
    product.googleMpn?.value ?? null,
  );
  const stateRestrictions = readMappedValue(mergedMetafields, [
    "state_restrictions",
    "custom.state_restrictions",
    "feed.state_restrictions",
  ]);
  const adWordsSpend = readMappedValue(mergedMetafields, [
    "ad_words_spend",
    "custom.ad_words_spend",
    "feed.ad_words_spend",
  ]);
  const quickShip = readMappedValue(mergedMetafields, [
    "quick_ship",
    "custom.quick_ship",
    "feed.quick_ship",
  ]);
  const brand = pickFirstNonEmpty(product.vendor);
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

  return {
    offerId: `shopify_ZZ_${productId}_${variantId}`,
    contentLanguage: env.googleContentLanguage || "en",
    feedLabel: env.googleFeedLabel || "US",
    productAttributes: {
      title: product.title,
      description: stripHtml(product.descriptionHtml),
      link,
      imageLink: primaryImage,
      additionalImageLinks: additionalImage ? [additionalImage] : [],
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
      brand,
      gtins,
      mpn,
      identifierExists: Boolean(gtin || mpn),
      itemGroupId: productId,
      customLabel0: computePriceBucket(priceAmount),
      customLabel1: computeHighPriceBucket(priceAmount),
      customLabel2: adWordsSpend,
      customLabel3: normalizeBooleanish(quickShip) ? "Quick Ship" : null,
      customLabel4: parseEngineLabel(product.title),
      shippingWeight: formatWeight(variant.inventoryItem?.measurement?.weight),
      shippingLabel: stateRestrictions ?? "Standard",
      costOfGoodsSold,
    },
  };
}

async function fetchAllProductVariants(params: {
  shop: string;
  accessToken: string;
  productId: string;
}) {
  const variants: ShopifyVariantNode[] = [];
  let cursor: string | null = null;

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
  onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
}) {
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
  const search = buildSearchQuery(params.mode, params.settings);
  const preview: FeedPreviewRecord[] = [];
  const excludedSamples: ExcludedPreviewSample[] = [];
  const exclusions: Record<string, number> = {};
  let totalProducts: number | null = null;
  let cursor: string | null = null;
  let productsFetched = 0;
  let variantsConsidered = 0;
  let recordsPrepared = 0;
  let pagesScanned = 0;
  let scanCompleted = false;
  let progressTargetTotal = getProgressTargetTotal(params.exhaustive, totalProducts);

  if (params.onProgress) {
    await params.onProgress({
      stage: "counting",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message: "Counting matching Shopify products.",
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
      message: "Starting Shopify catalog scan.",
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
        incrementCounter(exclusions, exclusionReason);
        collectExcludedSample(excludedSamples, {
          reason: exclusionReason,
          productId: resolveLegacyId(product.legacyResourceId, product.id),
          variantId: null,
          offerId: null,
          handle: product.handle,
          title: product.title,
          variantTitle: null,
          sku: null,
        });
        continue;
      }

      candidateIds.push(product.id);
    }

    const shouldHydrateDetails = preview.length < params.artifactSampleLimit;

    for (const batchIds of chunkArray(candidateIds, DETAIL_BATCH_SIZE)) {
      if (!shouldHydrateDetails) {
        break;
      }

      const detailPayload: ShopifyProductDetailsPayload =
        await runShopifyAdminGraphql<ShopifyProductDetailsPayload>({
          shop,
          accessToken: token.accessToken,
          query: SHOPIFY_PRODUCT_DETAILS_QUERY,
          variables: {
            ids: batchIds,
            mediaLimit: DETAIL_MEDIA_LIMIT,
            metafieldLimit: DETAIL_METAFIELD_LIMIT,
          },
        });

      const detailedProducts =
        detailPayload.nodes?.filter(
          (product): product is ShopifyProductNode => Boolean(product),
        ) ?? [];

      for (const product of detailedProducts) {
        const productId = resolveLegacyId(product.legacyResourceId, product.id);
        const productMetafields = collectMetafieldLookup(product.metafields);
        const productMediaUrls = collectMediaUrls(product);
        const variants = await fetchAllProductVariants({
          shop,
          accessToken: token.accessToken,
          productId: product.id,
        });

        for (const variant of variants) {
          variantsConsidered += 1;

          const record = buildPreviewRecord({
            product,
            variant,
            storefrontBaseUrl,
            productMetafields,
            productMediaUrls,
          });

          if ("excluded" in record) {
            incrementCounter(exclusions, record.excluded);
            collectExcludedSample(excludedSamples, {
              reason: record.excluded,
              productId: productId,
              variantId: resolveLegacyId(variant.legacyResourceId, variant.id),
              offerId: `shopify_ZZ_${productId}_${resolveLegacyId(variant.legacyResourceId, variant.id)}`,
              handle: product.handle,
              title: product.title,
              variantTitle: variant.title,
              sku: variant.sku ?? null,
            });
            continue;
          }

          recordsPrepared += 1;

          if (preview.length < params.artifactSampleLimit) {
            preview.push(record);
          }

          if (!params.exhaustive && preview.length >= params.artifactSampleLimit) {
            break;
          }
        }

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

    if (params.onProgress) {
      await params.onProgress({
        stage: "scanning",
        exhaustive: params.exhaustive,
        totalProducts: progressTargetTotal,
        productsScanned: params.exhaustive
          ? productsFetched
          : Math.min(productsFetched, progressTargetTotal ?? SHOPIFY_PAGE_SIZE),
        pagesScanned,
        previewRows: preview.length,
        message: params.exhaustive
          ? `Scanned ${productsFetched.toLocaleString()} products so far.`
          : "Sampling matching Shopify products.",
      });
    }
  }

  if (params.onProgress) {
    await params.onProgress({
      stage: "complete",
      exhaustive: params.exhaustive,
      totalProducts: progressTargetTotal,
      productsScanned: params.exhaustive
        ? productsFetched
        : Math.min(productsFetched, progressTargetTotal ?? SHOPIFY_PAGE_SIZE),
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
    preview: preview.slice(0, params.previewLimit),
    includedSamples: preview.slice(0, params.artifactSampleLimit),
    excludedSamples,
    exclusions,
    pagesScanned,
    scanCompleted,
    totalProducts,
    productsFetched,
    variantsConsidered,
    recordsPrepared,
  };
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

function getDaysUntilFollowingRun(
  now: Date,
  anchorDate: Date,
  intervalDays: number,
) {
  const daysUntilNextRun = getDaysUntilNextRun(now, anchorDate, intervalDays);
  return daysUntilNextRun === 0 ? intervalDays : daysUntilNextRun;
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
        getDaysUntilFollowingRun(now, anchorDate, settings.deltaIntervalDays),
      ),
    ),
    fullDate: formatDateOnly(
      addDays(
        todayUtc,
        getDaysUntilFollowingRun(now, anchorDate, settings.fullIntervalDays),
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
    mode: result.mode,
    dryRun: result.dryRun,
    ok: result.ok,
    scope: `${result.scope}${result.exhaustive ? " [exhaustive]" : ""}`,
    query: result.query,
    lookbackStart: result.lookbackStart,
    artifactId,
    notes: result.notes.slice(0, 8),
    stats: result.stats,
  };
}

export async function runSync(
  mode: Exclude<SyncMode, "idle">,
  options: {
    trigger: "cron" | "manual";
    dryRun?: boolean;
    previewLimit?: number;
    persistHistory?: boolean;
    settings?: SyncSettings;
    exhaustive?: boolean;
    onProgress?: (update: SyncProgressUpdate) => Promise<void> | void;
  },
): Promise<SyncRunResult> {
  const settings = options.settings ?? (await getSyncSettings());
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? settings.defaultDryRun;
  const exhaustive = options.exhaustive ?? (options.trigger === "cron" || mode === "full");
  const previewLimit = Math.max(
    1,
    Math.min(25, options.previewLimit ?? settings.previewLimit ?? DEFAULT_PREVIEW_LIMIT),
  );
  const artifactSampleLimit =
    options.persistHistory ?? true ? RUN_ARTIFACT_SAMPLE_LIMIT : previewLimit;
  const configuration = getConfigurationStatus();

  try {
    const previewRun = await buildDryRunPreview({
      mode,
      previewLimit,
      artifactSampleLimit,
      settings,
      exhaustive,
      onProgress: options.onProgress,
    });
    const excluded = Object.values(previewRun.exclusions).reduce(
      (sum, count) => sum + count,
      0,
    );
    const notes = [
      "Dry-run preview fetched live Shopify data and normalized it toward the Google Merchant API productInputs shape.",
      "This build paginates Shopify products in batches of up to 250 using GraphQL cursors.",
      `Product core details are hydrated in batches of ${DETAIL_BATCH_SIZE} products, and each product's variants are paged separately in batches of up to ${DETAIL_VARIANT_PAGE_SIZE}.`,
      "No Google Merchant API writes run yet. The next step is posting the validated records to a Merchant API data source.",
    ];

    if (dryRun) {
      notes.unshift(
        "Dry run is enabled. This is the safest mode for previewing mappings before any live feed writes.",
      );
    } else {
      notes.unshift(
        "Dry run is disabled, but this build still does not perform Google writes yet.",
      );
    }

    if (exhaustive) {
      notes.push(
        previewRun.scanCompleted
          ? "Exhaustive scan reached the end of the matching Shopify catalog."
          : "Exhaustive scan stopped before reaching the end of the catalog.",
      );
      notes.push(
        `The preview table still shows only ${previewLimit} normalized rows even after the exhaustive scan completes.`,
      );
    } else {
      notes.push(
        "Sample preview stops as soon as enough normalized rows have been collected for the requested preview size.",
      );
    }

    const result = {
      ok: true,
      trigger: options.trigger,
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
        previewLimit,
      },
      exclusions: previewRun.exclusions,
      preview: previewRun.preview,
    } satisfies SyncRunResult;

    if (options.persistHistory ?? true) {
      const artifactId = result.startedAt.replaceAll(":", "-");
      const artifact: SyncRunArtifact = {
        id: artifactId,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        trigger: result.trigger,
        mode: result.mode,
        dryRun: result.dryRun,
        exhaustive: result.exhaustive,
        ok: result.ok,
        scope: result.scope,
        query: result.query,
        lookbackStart: result.lookbackStart,
        notes: result.notes,
        stats: result.stats,
        includedSample: previewRun.includedSamples,
        excludedSample: previewRun.excludedSamples,
      };

      await writeRunArtifact(artifactId, artifact);
      await appendSyncHistory(toHistoryEntry(result, artifactId));
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sync execution error.";
    const search = buildSearchQuery(mode, settings);

    const result = {
      ok: false,
      trigger: options.trigger,
      mode,
      dryRun,
      exhaustive,
      scope: buildSyncScope(mode, null, settings, exhaustive),
      startedAt,
      finishedAt: new Date().toISOString(),
      configuration,
      notes: [
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
        previewLimit,
      },
      exclusions: {},
      preview: [],
    } satisfies SyncRunResult;

    if (options.persistHistory ?? true) {
      const artifactId = result.startedAt.replaceAll(":", "-");
      const artifact: SyncRunArtifact = {
        id: artifactId,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        trigger: result.trigger,
        mode: result.mode,
        dryRun: result.dryRun,
        exhaustive: result.exhaustive,
        ok: result.ok,
        scope: result.scope,
        query: result.query,
        lookbackStart: result.lookbackStart,
        notes: result.notes,
        stats: result.stats,
        includedSample: [],
        excludedSample: [],
      };

      await writeRunArtifact(artifactId, artifact);
      await appendSyncHistory(toHistoryEntry(result, artifactId));
    }

    return result;
  }
}
