export type GoogleAvailability = "IN_STOCK" | "OUT_OF_STOCK" | "BACKORDER";

export type ShopifyProductAvailability =
  | "in_stock"
  | "out_of_stock"
  | "backorder"
  | "build_to_order"
  | "unknown";

export interface ProductAvailabilityMapping {
  source: ShopifyProductAvailability;
  availability: GoogleAvailability;
  availabilityDate: string | null;
  shippingLabelOverride: string | null;
}

const DEFAULT_BACKORDER_DAYS = 60;
export const BUILD_TO_ORDER_SHIPPING_LABEL = "1-12 Weeks";
const AVAILABILITY_TIME_ZONE = "America/Los_Angeles";
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function normalizeAvailabilityToken(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

export function normalizeProductAvailability(
  value: string | null | undefined,
): ShopifyProductAvailability {
  switch (normalizeAvailabilityToken(value)) {
    case "in stock":
      return "in_stock";
    case "out of stock":
      return "out_of_stock";
    case "backorder":
    case "back order":
      return "backorder";
    case "build to order":
    case "built to order":
      return "build_to_order";
    default:
      return "unknown";
  }
}

function getDatePartsInTimeZone(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AVAILABILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function isValidDateOnly(value: string) {
  const match = value.match(DATE_ONLY_PATTERN);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function extractDateOnly(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  const match = normalized.match(DATE_ONLY_PATTERN);

  if (!match) {
    return null;
  }

  const dateOnly = `${match[1]}-${match[2]}-${match[3]}`;
  return isValidDateOnly(dateOnly) ? dateOnly : null;
}

function addCalendarDaysInPacific(now: Date, days: number) {
  const { year, month, day } = getDatePartsInTimeZone(now);
  const target = new Date(Date.UTC(year, month - 1, day + days));
  return target.toISOString().slice(0, 10);
}

function getPacificOffset(dateOnly: string) {
  // Noon UTC is safely after the Pacific DST transition hour for any date.
  const probe = new Date(`${dateOnly}T12:00:00Z`);
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: AVAILABILITY_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(probe)
    .find((part) => part.type === "timeZoneName")?.value;
  const offset = timeZoneName?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];

  if (!offset) {
    throw new Error(`Unable to resolve ${AVAILABILITY_TIME_ZONE} offset.`);
  }

  return offset;
}

export function buildGoogleAvailabilityDate(params: {
  metafieldDate: string | null | undefined;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const today = addCalendarDaysInPacific(now, 0);
  const maximumDate = addCalendarDaysInPacific(now, 365);
  const explicitDate = extractDateOnly(params.metafieldDate);
  const dateOnly =
    explicitDate && explicitDate > today && explicitDate <= maximumDate
      ? explicitDate
      : addCalendarDaysInPacific(now, DEFAULT_BACKORDER_DAYS);

  return `${dateOnly}T13:00:00${getPacificOffset(dateOnly)}`;
}

export function mapProductAvailability(params: {
  metafieldAvailability: string | null | undefined;
  metafieldAvailabilityDate: string | null | undefined;
  availableForSale: boolean;
  now?: Date;
}): ProductAvailabilityMapping {
  const source = normalizeProductAvailability(params.metafieldAvailability);

  switch (source) {
    case "in_stock":
      return {
        source,
        availability: "IN_STOCK",
        availabilityDate: null,
        shippingLabelOverride: null,
      };
    case "out_of_stock":
      return {
        source,
        availability: "OUT_OF_STOCK",
        availabilityDate: null,
        shippingLabelOverride: null,
      };
    case "backorder":
      return {
        source,
        availability: "BACKORDER",
        availabilityDate: buildGoogleAvailabilityDate({
          metafieldDate: params.metafieldAvailabilityDate,
          now: params.now,
        }),
        shippingLabelOverride: null,
      };
    case "build_to_order":
      return {
        source,
        availability: "IN_STOCK",
        availabilityDate: null,
        shippingLabelOverride: BUILD_TO_ORDER_SHIPPING_LABEL,
      };
    case "unknown":
      return {
        source,
        availability: params.availableForSale ? "IN_STOCK" : "OUT_OF_STOCK",
        availabilityDate: null,
        shippingLabelOverride: null,
      };
  }
}
