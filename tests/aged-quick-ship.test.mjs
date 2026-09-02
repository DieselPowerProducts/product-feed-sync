import assert from "node:assert/strict";
import test from "node:test";
import {
  AGED_QUICK_SHIP_LABEL,
  isAgedQuickShip,
  resolveAgedQuickShipCustomLabel0,
} from "../lib/aged-quick-ship.ts";

const now = new Date("2026-04-01T00:00:00.000Z");

test("qualifies variants with quick ship inventory and an order older than 90 days", () => {
  assert.equal(AGED_QUICK_SHIP_LABEL, "aged quick ship");
  assert.equal(
    isAgedQuickShip({
      quickShipValue: "1",
      lastOrderedAt: "2025-12-31T00:00:00.000Z",
      now,
    }),
    true,
  );
  assert.equal(
    isAgedQuickShip({
      quickShipValue: "4",
      lastOrderedAt: "2025-12-31T00:00:00.000Z",
      now,
    }),
    true,
  );
});

test("requires a numeric quick ship value of at least one", () => {
  for (const quickShipValue of [null, "", "0", "-1", "true", "not a number"]) {
    assert.equal(
      isAgedQuickShip({
        quickShipValue,
        lastOrderedAt: "2025-12-31T00:00:00.000Z",
        now,
      }),
      false,
    );
  }
});

test("uses a strict more-than-90-day boundary", () => {
  assert.equal(
    isAgedQuickShip({
      quickShipValue: "1",
      lastOrderedAt: "2026-01-01T00:00:00.000Z",
      now,
    }),
    false,
  );
  assert.equal(
    isAgedQuickShip({
      quickShipValue: "1",
      lastOrderedAt: "2026-01-01T00:00:00.001Z",
      now,
    }),
    false,
  );
  assert.equal(
    isAgedQuickShip({
      quickShipValue: "1",
      lastOrderedAt: "2025-12-31T23:59:59.999Z",
      now,
    }),
    true,
  );
});

test("does not qualify missing, invalid, or future last-order dates", () => {
  for (const lastOrderedAt of [null, "", "not a date", "2026-04-02T00:00:00.000Z"]) {
    assert.equal(
      isAgedQuickShip({
        quickShipValue: "1",
        lastOrderedAt,
        now,
      }),
      false,
    );
  }
});

test("sets custom label 0 only when both conditions qualify", () => {
  assert.equal(
    resolveAgedQuickShipCustomLabel0({
      quickShipValue: "1",
      lastOrderedAt: "2025-12-31T00:00:00.000Z",
      now,
    }),
    "aged quick ship",
  );
  assert.equal(
    resolveAgedQuickShipCustomLabel0({
      quickShipValue: "0",
      lastOrderedAt: "2025-12-31T00:00:00.000Z",
      now,
    }),
    null,
  );
});
