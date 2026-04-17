# Internal Operations Guide

This document contains implementation and operating detail that should live only in the private repository.

If the repository is public, this file is public too.

## Routes and how to use them

### App routes

- `/` redirects to `/login` or `/dashboard`
- `/login` operator login
- `/dashboard` operator dashboard
- `/dashboard/runs/:id` stored run artifact detail
- `/setup` technical setup page

### Technical and API routes

- `/api/health`
  - Returns service health, cadence settings, storage mode, environment readiness, and the next sync decision.
- `/api/shopify/status`
  - Confirms Shopify runtime connectivity and token source.
- `/api/shopify/install`
  - Tests Shopify connection.
  - Default mode is `client_credentials`.
  - OAuth fallback is available with `?mode=oauth`.
- `/api/shopify/callback`
  - OAuth callback handler if browser OAuth is used.
- `/api/cron/sync`
  - Protected cron entrypoint.
  - Runs daily, then decides whether to execute `delta`, `full`, or skip.
- `/api/sync/test`
  - Protected manual sync route.
  - Persists run history and stored artifacts.
- `/api/dashboard/preview`
  - Protected JSON preview route used by the dashboard.
  - Does not persist history.
- `/api/dashboard/preview-stream`
  - Protected server-sent events route used by the dashboard progress bar.
  - Does not persist history.

## Manual sync examples

Use `MANUAL_SYNC_TOKEN` in either the `Authorization` header or `x-manual-sync-token`.

Delta dry run:

```bash
curl -H "Authorization: Bearer YOUR_MANUAL_SYNC_TOKEN" \
  "http://localhost:3000/api/sync/test?mode=delta&dryRun=1&limit=5"
```

Full run request:

```bash
curl -H "Authorization: Bearer YOUR_MANUAL_SYNC_TOKEN" \
  "http://localhost:3000/api/sync/test?mode=full&dryRun=0&limit=10"
```

Notes:

- `mode` must be `delta` or `full`.
- `limit` is capped at 25.
- `dryRun=0` triggers live Merchant API writes.
- Manual runs persist history and save up to 50 included rows plus 50 excluded rows in the run artifact.

## Dashboard one-time test saves

Use the `Test save` panel at the bottom of `/dashboard` when you need a persisted comparison file.

Capabilities:

- Save either a `delta` or `full` export immediately
- Download the saved feed as `CSV` for GMC comparison
- Download the same saved export as `XLSX` with summary and exclusion sheets

## Cron behavior

The main sync cron route is designed for a Vercel cron job scheduled daily at `09:00 UTC`.

How the cron path works:

1. Vercel calls `/api/cron/sync`.
2. The route verifies `CRON_SECRET`.
3. The app loads the saved sync settings.
4. The app decides whether the day is `delta`, `full`, or `idle`.
5. If due, the app runs a live Merchant sync and stores history.

Important:

- Cron always runs on the daily schedule.
- Dashboard settings decide whether that day produces a delta run, full run, or no-op.
- Dashboard test saves are immediate dry-run exports and do not use cron.

## Feed rules implemented so far

Confirmed mapping and exclusion rules in the current code:

- `brand` comes from Shopify `vendor`
- `availability` uses Shopify storefront sale state
- backorders remain `IN_STOCK`
- `additionalImageLinks` includes all non-primary product images
- videos are ignored
- `identifierExists` is `true` only when a valid GTIN or MPN exists
- apparel-only attributes are emitted for apparel product types
- `customLabel2` maps ad-spend values `Above Average` -> `a`, `Average` -> `b`, and `Below Average` -> `c`
- `customLabel4` checks `application` first to infer engine fitment from explicit engine names or make keywords (`Ram`/`Dodge` -> `Cummins`, `Ford` -> `Powerstroke`, `GM`/`GMC`/`Chevy` -> `Duramax`), then falls back to the last 8 words of the title when `application` has no engine signal
- `shippingLabel` prioritizes state restrictions, then `fast_free` for any `Quick Ship` product, then `Standard`
- exclude `Google_Exclude` items, `seo.hidden` items, variants with no image, and variants with no storefront URL

## Storage behavior

Settings, history, and run artifacts are stored in one of three modes:

- `blob`: when `BLOB_READ_WRITE_TOKEN` is configured on Vercel
- `local`: local development, written under `.local-state/`
- `memory`: production fallback when Blob is not configured

Recommendation:

- Use `BLOB_READ_WRITE_TOKEN` in Vercel so settings and history survive cold starts and redeploys.

## Environment variables

Copy `.env.example` to `.env.local` for local development.

Core app settings:

- `NEXT_PUBLIC_APP_URL`: app base URL
- `CRON_SECRET`: required in production for `/api/cron/sync`
- `MANUAL_SYNC_TOKEN`: required in production for `/api/sync/test`
- `DASHBOARD_PASSWORD`: enables operator login
- `DASHBOARD_SESSION_SECRET`: recommended dedicated session-signing secret

Cadence settings:

- `SYNC_ANCHOR_DATE`
- `SYNC_DELTA_INTERVAL_DAYS`
- `SYNC_FULL_INTERVAL_DAYS`

Shopify settings:

- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `SHOPIFY_AUTH_MODE`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_SCOPES`

Google Merchant placeholders:

- `GOOGLE_MERCHANT_ACCOUNT_ID`
- `GOOGLE_MERCHANT_DATA_SOURCE`
- `GOOGLE_CONTENT_LANGUAGE`
- `GOOGLE_FEED_LABEL`
- `GOOGLE_FEED_CURRENCY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## Local development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Useful checks:

```bash
npm run lint
npm run typecheck
```

## Deployment checklist

1. Push the repo to GitHub.
2. Import the repo into Vercel.
3. Add the environment variables from `.env.example`.
4. Set the Shopify credentials.
5. Set `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET`.
6. Set `CRON_SECRET` and `MANUAL_SYNC_TOKEN`.
7. Add `BLOB_READ_WRITE_TOKEN` if you want persistent settings and history in production.
8. Deploy.
9. Open `/api/shopify/install` to verify Shopify connectivity.
10. Open `/api/shopify/status` to confirm runtime access.
11. Open `/api/health` to confirm configuration status and next decision.
12. Sign in at `/login` and use `/dashboard`.

## Current limitations

- No Google Merchant API writes yet
- No full-catalog Shopify Bulk Operations path yet
- Dashboard previews are intentionally non-persistent
- Production persistence requires Vercel Blob if you want settings/history to survive cold starts

## References

- Vercel cron jobs: https://vercel.com/docs/cron-jobs
- Vercel cron auth with `CRON_SECRET`: https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Google Merchant API overview: https://developers.google.com/merchant/api
- Google Merchant products overview: https://developers.google.com/merchant/api/guides/products/overview
- Shopify authentication: https://shopify.dev/docs/api/usage/authentication
