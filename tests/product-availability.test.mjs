import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleAvailabilityDate,
  mapProductAvailability,
  normalizeProductAvailability,
} from "../lib/product-availability.ts";

test("normalizes every supported Shopify stock label", () => {
  assert.equal(normalizeProductAvailability("In Stock"), "in_stock");
  assert.equal(normalizeProductAvailability("out_of_stock"), "out_of_stock");
  assert.equal(normalizeProductAvailability("Back Order"), "backorder");
  assert.equal(normalizeProductAvailability("Built to Order"), "build_to_order");
  assert.equal(normalizeProductAvailability("build-to-order"), "build_to_order");
});

test("maps in-stock and out-of-stock metafields directly", () => {
  assert.deepEqual(
    mapProductAvailability({
      metafieldAvailability: "In Stock",
      metafieldAvailabilityDate: "2026-10-10",
      availableForSale: false,
    }),
    {
      source: "in_stock",
      availability: "IN_STOCK",
      availabilityDate: null,
      shippingLabelOverride: null,
    },
  );
  assert.equal(
    mapProductAvailability({
      metafieldAvailability: "Out of Stock",
      metafieldAvailabilityDate: null,
      availableForSale: true,
    }).availability,
    "OUT_OF_STOCK",
  );
});

test("maps backorders with their specific date in Pacific time", () => {
  assert.deepEqual(
    mapProductAvailability({
      metafieldAvailability: "Backorder",
      metafieldAvailabilityDate: "2026-09-15",
      availableForSale: true,
      now: new Date("2026-07-15T19:00:00Z"),
    }),
    {
      source: "backorder",
      availability: "BACKORDER",
      availabilityDate: "2026-09-15T13:00:00-07:00",
      shippingLabelOverride: null,
    },
  );
});

test("uses the same generic 60-day estimate as the PDP when a backorder date is blank", () => {
  assert.equal(
    buildGoogleAvailabilityDate({
      metafieldDate: null,
      now: new Date("2026-07-15T19:00:00Z"),
    }),
    "2026-09-13T13:00:00-07:00",
  );
});

test("replaces stale or more-than-one-year dates with the generic estimate", () => {
  const now = new Date("2026-07-15T19:00:00Z");

  assert.equal(
    buildGoogleAvailabilityDate({ metafieldDate: "2026-07-01", now }),
    "2026-09-13T13:00:00-07:00",
  );
  assert.equal(
    buildGoogleAvailabilityDate({ metafieldDate: "2028-01-01", now }),
    "2026-09-13T13:00:00-07:00",
  );
});

test("maps build to order to in stock without an availability date", () => {
  assert.deepEqual(
    mapProductAvailability({
      metafieldAvailability: "Built to Order",
      metafieldAvailabilityDate: "2026-12-01",
      availableForSale: false,
    }),
    {
      source: "build_to_order",
      availability: "IN_STOCK",
      availabilityDate: null,
      shippingLabelOverride: "1-12 Weeks",
    },
  );
});

test("preserves the Shopify sale-state fallback for blank or unknown metafields", () => {
  assert.equal(
    mapProductAvailability({
      metafieldAvailability: null,
      metafieldAvailabilityDate: null,
      availableForSale: true,
    }).availability,
    "IN_STOCK",
  );
  assert.equal(
    mapProductAvailability({
      metafieldAvailability: "Unexpected value",
      metafieldAvailabilityDate: null,
      availableForSale: false,
    }).availability,
    "OUT_OF_STOCK",
  );
});

test("uses the correct standard-time offset for winter dates", () => {
  assert.equal(
    buildGoogleAvailabilityDate({
      metafieldDate: "2026-12-15",
      now: new Date("2026-07-15T19:00:00Z"),
    }),
    "2026-12-15T13:00:00-08:00",
  );
});
