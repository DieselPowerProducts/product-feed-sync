import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShippingLabel,
  FAST_FREE_PRICE_THRESHOLD,
} from "../lib/shipping-label.ts";

function shippingLabel(overrides = {}) {
  return buildShippingLabel({
    stateRestrictions: null,
    quickShip: true,
    priceAmount: 35.95,
    override: null,
    ...overrides,
  });
}

test("does not mark Quick Ship products at or below $199 as fast_free", () => {
  assert.equal(FAST_FREE_PRICE_THRESHOLD, 199);
  assert.equal(shippingLabel({ priceAmount: 35.95 }), "Standard");
  assert.equal(shippingLabel({ priceAmount: 199 }), "Standard");
});

test("marks Quick Ship products over $199 as fast_free", () => {
  assert.equal(shippingLabel({ priceAmount: 199.01 }), "fast_free");
});

test("requires Quick Ship eligibility", () => {
  assert.equal(
    shippingLabel({ quickShip: false, priceAmount: 500 }),
    "Standard",
  );
});

test("preserves shipping label precedence", () => {
  assert.equal(
    shippingLabel({ stateRestrictions: "No CA", priceAmount: 500 }),
    "No CA",
  );
  assert.equal(
    shippingLabel({
      stateRestrictions: "No CA",
      priceAmount: 500,
      override: "1-12 Weeks",
    }),
    "1-12 Weeks",
  );
});
