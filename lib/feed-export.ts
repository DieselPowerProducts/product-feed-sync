import * as XLSX from "xlsx";
import { parseShopifyOfferId } from "@/lib/shopify-offer-id";
import type {
  ExcludedPreviewSample,
  FeedPreviewRecord,
  SyncExportResult,
} from "@/lib/sync";

type FeedExportRow = {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string;
  availability: string;
  condition: string;
  price: string;
  sale_price: string;
  google_product_category: string;
  product_type: string;
  brand: string;
  gtin: string;
  mpn: string;
  identifier_exists: string;
  item_group_id: string;
  custom_label_0: string;
  custom_label_1: string;
  custom_label_2: string;
  custom_label_3: string;
  custom_label_4: string;
  shipping_weight: string;
  shipping_label: string;
  variant_id: string;
  product_id: string;
  cost_of_goods_sold: string;
  age_group: string;
  color: string;
  gender: string;
  size: string;
  size_system: string;
};

type ExcludedExportRow = {
  reason: string;
  details: string;
  title: string;
  handle: string;
  product_id: string;
  variant_id: string;
  offer_id: string;
  sku: string;
  variant_title: string;
  link: string;
};

const FEED_EXPORT_HEADERS: Array<keyof FeedExportRow> = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "additional_image_link",
  "availability",
  "condition",
  "price",
  "sale_price",
  "google_product_category",
  "product_type",
  "brand",
  "gtin",
  "mpn",
  "identifier_exists",
  "item_group_id",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
  "shipping_weight",
  "shipping_label",
  "variant_id",
  "product_id",
  "cost_of_goods_sold",
  "age_group",
  "color",
  "gender",
  "size",
  "size_system",
];

const EXCLUDED_EXPORT_HEADERS: Array<keyof ExcludedExportRow> = [
  "reason",
  "details",
  "title",
  "handle",
  "product_id",
  "variant_id",
  "offer_id",
  "sku",
  "variant_title",
  "link",
];

function formatPriceValue(value: FeedPreviewRecord["productAttributes"]["price"] | null) {
  if (!value) {
    return "";
  }

  const amount = Number(value.amountMicros) / 1_000_000;

  if (!Number.isFinite(amount)) {
    return "";
  }

  return `${amount.toFixed(2)} ${value.currencyCode}`;
}

function formatWeightValue(value: FeedPreviewRecord["productAttributes"]["shippingWeight"]) {
  if (!value) {
    return "";
  }

  const amount = Number.isInteger(value.value)
    ? value.value.toFixed(1)
    : String(value.value);

  return `${amount} ${value.unit}`;
}

function readCustomAttribute(record: FeedPreviewRecord, name: string) {
  return record.customAttributes?.find((attribute) => attribute.name === name)?.value ?? "";
}

function parseOfferId(offerId: string) {
  return parseShopifyOfferId(offerId);
}

function toFeedExportRow(record: FeedPreviewRecord): FeedExportRow {
  const parsedIds = parseOfferId(record.offerId);
  const variantId = readCustomAttribute(record, "variant_id") || parsedIds.variantId;
  const productId = readCustomAttribute(record, "product_id") || parsedIds.productId;

  return {
    id: record.offerId,
    title: record.productAttributes.title,
    description: record.productAttributes.description,
    link: record.productAttributes.link,
    image_link: record.productAttributes.imageLink,
    additional_image_link: record.productAttributes.additionalImageLinks.join(","),
    availability: record.productAttributes.availability.toLowerCase(),
    condition: record.productAttributes.condition.toLowerCase(),
    price: formatPriceValue(record.productAttributes.price),
    sale_price: formatPriceValue(record.productAttributes.salePrice),
    google_product_category: record.productAttributes.googleProductCategory ?? "",
    product_type: record.productAttributes.productTypes[0] ?? "",
    brand: record.productAttributes.brand ?? "",
    gtin: record.productAttributes.gtins[0] ?? "",
    mpn: record.productAttributes.mpn ?? "",
    identifier_exists: record.productAttributes.identifierExists ? "yes" : "no",
    item_group_id: record.productAttributes.itemGroupId,
    custom_label_0: record.productAttributes.customLabel0 ?? "",
    custom_label_1: record.productAttributes.customLabel1 ?? "",
    custom_label_2: record.productAttributes.customLabel2 ?? "",
    custom_label_3: record.productAttributes.customLabel3 ?? "",
    custom_label_4: record.productAttributes.customLabel4 ?? "",
    shipping_weight: formatWeightValue(record.productAttributes.shippingWeight),
    shipping_label: record.productAttributes.shippingLabel,
    variant_id: variantId,
    product_id: productId,
    cost_of_goods_sold: formatPriceValue(record.productAttributes.costOfGoodsSold),
    age_group: record.productAttributes.ageGroup?.toLowerCase() ?? "",
    color: record.productAttributes.color ?? "",
    gender: record.productAttributes.gender?.toLowerCase() ?? "",
    size: record.productAttributes.size ?? "",
    size_system: record.productAttributes.sizeSystem ?? "",
  };
}

function appendSheet(
  workbook: unknown,
  name: string,
  rows: unknown[],
  header?: string[],
) {
  const worksheet = XLSX.utils.json_to_sheet(rows, header ? { header } : undefined);
  XLSX.utils.book_append_sheet(workbook, worksheet, name);
}

function buildSummaryRows(params: {
  source: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  query: string;
  lookbackStart: string | null;
  stats: {
    productsFetched: number;
    recordsPrepared: number;
    excluded: number;
    validationIssues: number;
    pagesScanned: number;
    totalProducts: number | null;
  };
  notes: string[];
}) {
  return [
    { field: "source", value: params.source },
    { field: "mode", value: params.mode },
    { field: "started_at", value: params.startedAt },
    { field: "finished_at", value: params.finishedAt },
    { field: "query", value: params.query },
    { field: "lookback_start", value: params.lookbackStart ?? "" },
    { field: "products_fetched", value: params.stats.productsFetched },
    { field: "records_prepared", value: params.stats.recordsPrepared },
    { field: "excluded", value: params.stats.excluded },
    { field: "validation_issues", value: params.stats.validationIssues },
    { field: "pages_scanned", value: params.stats.pagesScanned },
    { field: "total_products", value: params.stats.totalProducts ?? "" },
    ...params.notes.map((note, index) => ({
      field: `note_${index + 1}`,
      value: note,
    })),
  ];
}

function buildExclusionRows(exclusions: Record<string, number>) {
  return Object.entries(exclusions).map(([reason, count]) => ({
    reason,
    count,
  }));
}

function buildFeedExportRows(result: SyncExportResult) {
  return result.rows.map(toFeedExportRow);
}

function toExcludedExportRow(row: ExcludedPreviewSample): ExcludedExportRow {
  return {
    reason: row.reason,
    details: row.details?.join(" | ") ?? "",
    title: row.title,
    handle: row.handle,
    product_id: row.productId,
    variant_id: row.variantId ?? "",
    offer_id: row.offerId ?? "",
    sku: row.sku ?? "",
    variant_title: row.variantTitle ?? "",
    link: row.link ?? "",
  };
}

function buildExcludedExportRows(rows: ExcludedPreviewSample[] | undefined) {
  return (rows ?? []).map(toExcludedExportRow);
}

export function buildPreviewExportCsv(result: SyncExportResult) {
  const worksheet = XLSX.utils.json_to_sheet(buildFeedExportRows(result), {
    header: FEED_EXPORT_HEADERS,
  });

  return `\uFEFF${XLSX.utils.sheet_to_csv(worksheet, {
    FS: ",",
    RS: "\r\n",
  })}`;
}

export function buildPreviewExportWorkbook(result: SyncExportResult) {
  const workbook = XLSX.utils.book_new();

  appendSheet(
    workbook,
    "feed_export",
    buildFeedExportRows(result),
    FEED_EXPORT_HEADERS,
  );
  appendSheet(
    workbook,
    "summary",
    buildSummaryRows({
      source: "preview_export",
      mode: result.mode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      query: result.query,
      lookbackStart: result.lookbackStart,
      stats: result.stats,
      notes: result.notes,
    }),
  );
  appendSheet(workbook, "exclusions", buildExclusionRows(result.exclusions));

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

export function buildExcludedExportCsv(
  rows: ExcludedPreviewSample[] | undefined,
) {
  const worksheet = XLSX.utils.json_to_sheet(buildExcludedExportRows(rows), {
    header: EXCLUDED_EXPORT_HEADERS,
  });

  return `\uFEFF${XLSX.utils.sheet_to_csv(worksheet, {
    FS: ",",
    RS: "\r\n",
  })}`;
}

export function buildExcludedExportWorkbook(params: {
  result: SyncExportResult;
  rows: ExcludedPreviewSample[] | undefined;
  source: "excluded_rows" | "validation_rows";
}) {
  const workbook = XLSX.utils.book_new();

  appendSheet(
    workbook,
    params.source,
    buildExcludedExportRows(params.rows),
    EXCLUDED_EXPORT_HEADERS,
  );
  appendSheet(
    workbook,
    "summary",
    buildSummaryRows({
      source: params.source,
      mode: params.result.mode,
      startedAt: params.result.startedAt,
      finishedAt: params.result.finishedAt,
      query: params.result.query,
      lookbackStart: params.result.lookbackStart,
      stats: params.result.stats,
      notes: params.result.notes,
    }),
  );
  appendSheet(workbook, "exclusions", buildExclusionRows(params.result.exclusions));

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
