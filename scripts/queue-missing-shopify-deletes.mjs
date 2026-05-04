#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

const DEFAULT_ENV_FILE = ".env.local";
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_PRODUCTS = 30;
const DEFAULT_MAX_OFFERS = 100;
const PENDING_DELETE_KIND = "pending-shopify-delete";
const PENDING_DELETE_PREFIX = "pending-delete";

function printHelp() {
  console.log(`
Queue missing Shopify products for Merchant Center delete cleanup.

This script is intentionally conservative:
- Dry-run by default.
- It never calls Google Merchant delete directly.
- It only queues rows after Shopify returns null for the product ID.
- Apply mode requires exact product and offer counts.

Usage:
  node scripts/queue-missing-shopify-deletes.mjs
  node scripts/queue-missing-shopify-deletes.mjs --apply --confirm-products=22 --confirm-offers=41
  node scripts/queue-missing-shopify-deletes.mjs --product-id=14710573203821

Options:
  --apply                     Write pending delete records to Neon.
  --confirm-products=N        Required with --apply. Must match missing product count.
  --confirm-offers=N          Required with --apply. Must match target offer row count.
  --product-id=ID             Limit to one Shopify product ID. Can be repeated.
  --max-products=N            Safety cap for missing products. Default ${DEFAULT_MAX_PRODUCTS}.
  --max-offers=N              Safety cap for offer rows. Default ${DEFAULT_MAX_OFFERS}.
  --env=PATH                  Env file to load. Default ${DEFAULT_ENV_FILE}.
  --batch-size=N              Shopify GraphQL node batch size. Default ${DEFAULT_BATCH_SIZE}.
  --help                      Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    confirmProducts: null,
    confirmOffers: null,
    envFile: DEFAULT_ENV_FILE,
    batchSize: DEFAULT_BATCH_SIZE,
    maxProducts: DEFAULT_MAX_PRODUCTS,
    maxOffers: DEFAULT_MAX_OFFERS,
    productIds: [],
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--apply") {
      args.apply = true;
      continue;
    }

    const [name, rawValue] = arg.split("=", 2);

    if (!rawValue) {
      throw new Error(`Unsupported argument: ${arg}`);
    }

    if (name === "--confirm-products") {
      args.confirmProducts = Number(rawValue);
    } else if (name === "--confirm-offers") {
      args.confirmOffers = Number(rawValue);
    } else if (name === "--product-id") {
      if (!/^\d+$/.test(rawValue)) {
        throw new Error(`Invalid Shopify product ID: ${rawValue}`);
      }
      args.productIds.push(rawValue);
    } else if (name === "--env") {
      args.envFile = rawValue;
    } else if (name === "--batch-size") {
      args.batchSize = Number(rawValue);
    } else if (name === "--max-products") {
      args.maxProducts = Number(rawValue);
    } else if (name === "--max-offers") {
      args.maxOffers = Number(rawValue);
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  for (const [name, value] of [
    ["batch-size", args.batchSize],
    ["max-products", args.maxProducts],
    ["max-offers", args.maxOffers],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${name} must be a positive integer.`);
    }
  }

  return args;
}

function loadEnvFile(envFile) {
  if (!fs.existsSync(envFile)) {
    return;
  }

  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);

  for (const line of lines) {
    if (!line || /^\s*#/.test(line) || !line.includes("=")) {
      continue;
    }

    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

function parseLiveOfferKey(key) {
  const [contentLanguage, feedLabel, ...offerIdParts] = key.split("~");
  const offerId = offerIdParts.join("~");
  const match = /^shopify_ZZ_(\d+)_(\d+)$/.exec(offerId);

  if (!contentLanguage || !feedLabel || !match) {
    return null;
  }

  return {
    key,
    contentLanguage,
    feedLabel,
    offerId,
    productId: match[1],
    variantId: match[2],
  };
}

async function getShopifyAccessToken(shopDomain) {
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim()) {
    return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN.trim();
  }

  const clientId = requireEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requireEnv("SHOPIFY_CLIENT_SECRET");
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Shopify access token: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  const payload = JSON.parse(body);

  if (!payload.access_token) {
    throw new Error("Shopify access-token response did not include access_token.");
  }

  return payload.access_token;
}

async function queryShopifyProducts(params) {
  const ids = params.productIds.map((id) => `gid://shopify/Product/${id}`);
  const response = await fetch(
    `https://${params.shopDomain}/admin/api/${params.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": params.accessToken,
      },
      body: JSON.stringify({
        query: `
          query CleanupMissingProducts($ids: [ID!]!) {
            nodes(ids: $ids) {
              __typename
              ... on Product {
                id
                title
                handle
                status
              }
            }
          }
        `,
        variables: { ids },
      }),
    },
  );
  const payload = await response.json();

  if (!response.ok || payload.errors) {
    throw new Error(
      `Shopify product lookup failed: ${response.status} ${JSON.stringify(
        payload.errors ?? payload,
      ).slice(0, 500)}`,
    );
  }

  return payload.data.nodes;
}

function buildPendingDeleteRecord(row, queuedAt, shopDomain) {
  return {
    offerId: row.offerId,
    contentLanguage: row.contentLanguage,
    feedLabel: row.feedLabel,
    reason: "shopify_missing_cleanup",
    productId: row.productId,
    variantId: row.variantId,
    title: `Deleted Shopify product ${row.productId}`,
    variantTitle: null,
    handle: "",
    sku: null,
    link: null,
    queuedAt,
    source: "shopify_webhook",
    webhookId: "manual-missing-shopify-cleanup",
    shopDomain,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  loadEnvFile(args.envFile);

  const databaseUrl = requireEnv("DATABASE_URL");
  const shopDomain = requireEnv("SHOPIFY_STORE_DOMAIN");
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || "2026-01";
  const sql = neon(databaseUrl);
  const liveRows = await sql`
    SELECT payload
    FROM dpp_operator_objects
    WHERE object_kind = 'live-offer-index'
    LIMIT 1
  `;
  const liveOfferIndex = liveRows[0]?.payload;

  if (!liveOfferIndex?.keys?.length) {
    throw new Error("No live offer index was found in Neon.");
  }

  const productFilter = new Set(args.productIds);
  const liveOfferRows = liveOfferIndex.keys
    .map(parseLiveOfferKey)
    .filter(Boolean)
    .filter((row) => !productFilter.size || productFilter.has(row.productId));
  const offerRowsByProduct = new Map();

  for (const row of liveOfferRows) {
    const existing = offerRowsByProduct.get(row.productId);

    if (existing) {
      existing.push(row);
    } else {
      offerRowsByProduct.set(row.productId, [row]);
    }
  }

  const productIds = Array.from(offerRowsByProduct.keys());

  if (!productIds.length) {
    console.log("No matching live offer rows were found.");
    return;
  }

  const accessToken = await getShopifyAccessToken(shopDomain);
  const missingProductIds = [];
  const existingProducts = [];

  for (let index = 0; index < productIds.length; index += args.batchSize) {
    const batch = productIds.slice(index, index + args.batchSize);
    const nodes = await queryShopifyProducts({
      shopDomain,
      apiVersion,
      accessToken,
      productIds: batch,
    });

    nodes.forEach((node, nodeIndex) => {
      const productId = batch[nodeIndex];

      if (node) {
        existingProducts.push({
          productId,
          title: node.title,
          handle: node.handle,
          status: node.status,
        });
      } else {
        missingProductIds.push(productId);
      }
    });
  }

  const targetOfferRows = missingProductIds.flatMap(
    (productId) => offerRowsByProduct.get(productId) ?? [],
  );
  const existingPendingRows = await sql`
    SELECT object_key
    FROM dpp_operator_objects
    WHERE object_kind = ${PENDING_DELETE_KIND}
  `;
  const existingPendingKeys = new Set(
    existingPendingRows.map((row) => row.object_key),
  );
  const records = targetOfferRows.map((row) =>
    buildPendingDeleteRecord(row, new Date().toISOString(), shopDomain),
  );
  const newRecords = records.filter(
    (record) =>
      !existingPendingKeys.has(
        `${PENDING_DELETE_PREFIX}:${record.contentLanguage}~${record.feedLabel}~${record.offerId}`,
      ),
  );
  const summary = {
    mode: args.apply ? "apply" : "dry-run",
    liveOfferRowsScanned: liveOfferRows.length,
    uniqueProductsChecked: productIds.length,
    existingShopifyProducts: existingProducts.length,
    missingShopifyProducts: missingProductIds.length,
    targetMerchantOfferRows: targetOfferRows.length,
    alreadyQueuedOfferRows: records.length - newRecords.length,
    newQueuedOfferRows: newRecords.length,
    sampleMissingProducts: missingProductIds.slice(0, 25).map((productId) => ({
      productId,
      offerRows: offerRowsByProduct.get(productId)?.length ?? 0,
      offerIds: (offerRowsByProduct.get(productId) ?? [])
        .slice(0, 5)
        .map((row) => row.offerId),
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) {
    console.log(
      `Dry run only. To queue these rows, rerun with --apply --confirm-products=${summary.missingShopifyProducts} --confirm-offers=${summary.targetMerchantOfferRows}.`,
    );
    return;
  }

  if (summary.missingShopifyProducts > args.maxProducts) {
    throw new Error(
      `Refusing to apply: ${summary.missingShopifyProducts} missing products exceeds --max-products=${args.maxProducts}.`,
    );
  }

  if (summary.targetMerchantOfferRows > args.maxOffers) {
    throw new Error(
      `Refusing to apply: ${summary.targetMerchantOfferRows} offer rows exceeds --max-offers=${args.maxOffers}.`,
    );
  }

  if (
    args.confirmProducts !== summary.missingShopifyProducts ||
    args.confirmOffers !== summary.targetMerchantOfferRows
  ) {
    throw new Error(
      `Refusing to apply: confirmation counts do not match. Use --confirm-products=${summary.missingShopifyProducts} --confirm-offers=${summary.targetMerchantOfferRows}.`,
    );
  }

  const stateRows = await sql`
    SELECT payload
    FROM dpp_operator_objects
    WHERE object_key = 'state'
    LIMIT 1
  `;
  const activeSyncRun = stateRows[0]?.payload?.activeSyncRun;

  if (
    activeSyncRun &&
    (activeSyncRun.status === "queued" || activeSyncRun.status === "running")
  ) {
    throw new Error(
      `Refusing to apply while sync run ${activeSyncRun.runId} is ${activeSyncRun.status}.`,
    );
  }

  for (const record of newRecords) {
    const key = `${PENDING_DELETE_PREFIX}:${record.contentLanguage}~${record.feedLabel}~${record.offerId}`;
    const serialized = JSON.stringify(record);

    await sql`
      INSERT INTO dpp_operator_objects (object_key, object_kind, payload, updated_at)
      VALUES (${key}, ${PENDING_DELETE_KIND}, ${serialized}::jsonb, NOW())
      ON CONFLICT (object_key) DO UPDATE
      SET object_kind = EXCLUDED.object_kind,
          payload = EXCLUDED.payload,
          updated_at = NOW()
    `;
  }

  console.log(`Queued ${newRecords.length} new pending Merchant delete rows.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
