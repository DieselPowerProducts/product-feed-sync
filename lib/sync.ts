import { env, getConfigurationStatus } from "@/lib/env";
import {
  appendSyncHistory,
  getSyncSettings,
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
const MAX_SCAN_PAGES = 4;
const DEFAULT_PREVIEW_LIMIT = 5;
const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);

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

const SHOPIFY_FEED_PRODUCTS_QUERY = `
  query FeedProducts($first: Int!, $after: String, $query: String!) {
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
          featuredMedia {
            __typename
            ... on MediaImage {
              image {
                url
              }
            }
          }
          media(first: 10) {
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
          metafields(first: 50) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
          }
          variants(first: 100) {
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
                weight
                weightUnit
                image {
                  url
                }
                metafields(first: 50) {
                  edges {
                    node {
                      namespace
                      key
                      value
                      type
                    }
                  }
                }
                inventoryItem {
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

export interface FeedPreviewRecord {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string | null;
  availability: "in_stock" | "out_of_stock";
  price: string;
  sale_price: string | null;
  google_product_category: number | string | null;
  product_type: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  identifier_exists: "yes" | "no";
  item_group_id: string;
  custom_label_0: string | null;
  custom_label_1: string | null;
  custom_label_2: string | null;
  custom_label_3: string | null;
  custom_label_4: string | null;
  shipping_weight: string | null;
  shipping_label: string;
  variant_id: string;
  product_id: string;
  cost_of_goods_sold: string | null;
}

export interface SyncRunResult {
  ok: boolean;
  trigger: "cron" | "manual";
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
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
    productsFetched: number;
    variantsConsidered: number;
    recordsPrepared: number;
    excluded: number;
    previewLimit: number;
  };
  exclusions: Record<string, number>;
  preview: FeedPreviewRecord[];
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
  weight: number | null;
  weightUnit: string | null;
  image?: {
    url?: string | null;
  } | null;
  metafields?: ShopifyConnection<ShopifyMetafieldNode>;
  inventoryItem?: {
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
  featuredMedia?: ShopifyMediaNode | null;
  media?: ShopifyConnection<ShopifyMediaNode>;
  metafields?: ShopifyConnection<ShopifyMetafieldNode>;
  variants?: ShopifyConnection<ShopifyVariantNode>;
}

interface ShopifyFeedProductsPayload {
  products?: ShopifyConnection<ShopifyProductNode>;
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

function incrementCounter(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] ?? 0) + 1;
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

function formatMoney(amount: number | null, currencyCode = "USD") {
  return amount === null ? null : `${amount.toFixed(2)} ${currencyCode}`;
}

function formatWeight(value: number | null, unit: string | null) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const normalizedUnit = (unit ?? "POUNDS").toUpperCase();
  const suffix =
    normalizedUnit === "POUNDS"
      ? "lb"
      : normalizedUnit === "OUNCES"
        ? "oz"
        : normalizedUnit === "KILOGRAMS"
          ? "kg"
          : normalizedUnit === "GRAMS"
            ? "g"
            : normalizedUnit.toLowerCase();

  return `${value.toFixed(1)} ${suffix}`;
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
    return Number.parseInt(normalized, 10);
  }

  return GOOGLE_PRODUCT_CATEGORY_IDS[normalized.toLowerCase()] ?? normalized;
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
) {
  if (mode === "full") {
    return "Active Shopify products with online-store URLs, scanned in paginated batches of up to 250.";
  }

  return lookbackStart
    ? `Active Shopify products updated after ${lookbackStart}.`
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
  const mpn =
    readMappedValue(mergedMetafields, [
      "googlempn",
      "google_mpn",
      "mpn",
      "custom.googlempn",
      "custom.google_mpn",
      "feed.googlempn",
      "feed.google_mpn",
    ]) ??
    pickFirstNonEmpty(variant.sku);
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

  return {
    id: `shopify_ZZ_${productId}_${variantId}`,
    title: product.title,
    description: stripHtml(product.descriptionHtml),
    link,
    image_link: primaryImage,
    additional_image_link: additionalImage,
    availability: determineAvailability(variant),
    price: formatMoney(hasSalePrice ? compareAtAmount : priceAmount) ?? "0.00 USD",
    sale_price: hasSalePrice ? formatMoney(priceAmount) : null,
    google_product_category: googleProductCategory,
    product_type: productType,
    brand: pickFirstNonEmpty(product.vendor),
    gtin,
    mpn,
    identifier_exists: gtin || mpn ? "yes" : "no",
    item_group_id: productId,
    custom_label_0: computePriceBucket(priceAmount),
    custom_label_1: computeHighPriceBucket(priceAmount),
    custom_label_2: adWordsSpend,
    custom_label_3: normalizeBooleanish(quickShip) ? "Quick Ship" : null,
    custom_label_4: parseEngineLabel(product.title),
    shipping_weight: formatWeight(variant.weight, variant.weightUnit),
    shipping_label: stateRestrictions ?? "Standard",
    variant_id: variantId,
    product_id: productId,
    cost_of_goods_sold:
      formatMoney(
        parseAmount(variant.inventoryItem?.unitCost?.amount ?? null),
        variant.inventoryItem?.unitCost?.currencyCode ?? "USD",
      ) ?? null,
  };
}

async function buildDryRunPreview(params: {
  mode: Exclude<SyncMode, "idle">;
  previewLimit: number;
  settings: SyncSettings;
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
  const exclusions: Record<string, number> = {};
  let cursor: string | null = null;
  let productsFetched = 0;
  let variantsConsidered = 0;
  let pagesScanned = 0;

  while (pagesScanned < MAX_SCAN_PAGES && preview.length < params.previewLimit) {
    const payload: ShopifyFeedProductsPayload =
      await runShopifyAdminGraphql<ShopifyFeedProductsPayload>({
      shop,
      accessToken: token.accessToken,
      query: SHOPIFY_FEED_PRODUCTS_QUERY,
      variables: {
        first: SHOPIFY_PAGE_SIZE,
        after: cursor,
        query: search.query,
      },
    });
    const products = connectionNodes<ShopifyProductNode>(payload.products);

    if (products.length === 0) {
      break;
    }

    pagesScanned += 1;
    productsFetched += products.length;

    for (const product of products) {
      const exclusionReason = findProductExclusionReason(product);

      if (exclusionReason) {
        incrementCounter(exclusions, exclusionReason);
        continue;
      }

      const productMetafields = collectMetafieldLookup(product.metafields);
      const productMediaUrls = collectMediaUrls(product);

      for (const variant of connectionNodes<ShopifyVariantNode>(product.variants)) {
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
          continue;
        }

        preview.push(record);

        if (preview.length >= params.previewLimit) {
          break;
        }
      }

      if (preview.length >= params.previewLimit) {
        break;
      }
    }

    if (!payload.products?.pageInfo?.hasNextPage) {
      break;
    }

    cursor = payload.products.pageInfo.endCursor;

    if (!cursor) {
      break;
    }
  }

  return {
    query: search.query,
    lookbackStart: search.lookbackStart,
    storefrontBaseUrl,
    preview,
    exclusions,
    pagesScanned,
    productsFetched,
    variantsConsidered,
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
      addDays(todayUtc, getDaysUntilNextRun(now, anchorDate, settings.deltaIntervalDays)),
    ),
    fullDate: formatDateOnly(
      addDays(todayUtc, getDaysUntilNextRun(now, anchorDate, settings.fullIntervalDays)),
    ),
  };
}

function toHistoryEntry(result: SyncRunResult): SyncHistoryEntry {
  return {
    id: `${result.mode}-${result.startedAt}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger: result.trigger,
    mode: result.mode,
    dryRun: result.dryRun,
    ok: result.ok,
    scope: result.scope,
    query: result.query,
    lookbackStart: result.lookbackStart,
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
  },
): Promise<SyncRunResult> {
  const settings = options.settings ?? (await getSyncSettings());
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? settings.defaultDryRun;
  const previewLimit = Math.max(
    1,
    Math.min(25, options.previewLimit ?? settings.previewLimit ?? DEFAULT_PREVIEW_LIMIT),
  );
  const configuration = getConfigurationStatus();

  try {
    const previewRun = await buildDryRunPreview({
      mode,
      previewLimit,
      settings,
    });
    const excluded = Object.values(previewRun.exclusions).reduce(
      (sum, count) => sum + count,
      0,
    );
    const notes = [
      "Dry-run preview fetched live Shopify data and normalized it toward the Google feed shape.",
      "This build paginates Shopify products in batches of up to 250 using GraphQL cursors.",
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

    if (previewRun.pagesScanned === MAX_SCAN_PAGES) {
      notes.push(
        `Preview scanning stopped after ${MAX_SCAN_PAGES} pages. For a true full-catalog export, switch the full-sync path to Shopify Bulk Operations or persist cursors between runs.`,
      );
    }

    const result = {
      ok: true,
      trigger: options.trigger,
      mode,
      dryRun,
      scope: buildSyncScope(mode, previewRun.lookbackStart, settings),
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
        productsFetched: previewRun.productsFetched,
        variantsConsidered: previewRun.variantsConsidered,
        recordsPrepared: previewRun.preview.length,
        excluded,
        previewLimit,
      },
      exclusions: previewRun.exclusions,
      preview: previewRun.preview,
    } satisfies SyncRunResult;

    if (options.persistHistory ?? true) {
      await appendSyncHistory(toHistoryEntry(result));
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
      scope: buildSyncScope(mode, null, settings),
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
      await appendSyncHistory(toHistoryEntry(result));
    }

    return result;
  }
}
