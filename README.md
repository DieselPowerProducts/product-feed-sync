# DPP Product Feed Sync

Next.js operator console for validating a Shopify-to-Google Merchant Center product feed on Vercel.

Current state:

- Shopify connection, feed normalization, preview scanning, cadence controls, and run-history storage are implemented.
- Google Merchant writes are not implemented yet.
- This build is read-only against Shopify and safe for feed QA.

## What this app controls

This app gives operators a password-protected control room for feed validation and scheduling logic.

Primary controls:

- `/login`: shared-password operator login.
- `/dashboard`: cadence settings, feed preview, and run history.
- `/setup`: technical routes and integration checks.
- `/api/cron/sync`: daily cron entrypoint that decides whether today is a delta run, full run, or skip.
- `/api/sync/test`: token-protected manual sync endpoint for testing outside the dashboard.

Important limitation:

- Changing settings in the dashboard changes sync decision logic only.
- The actual cron clock is fixed at `0 9 * * *` (`09:00 UTC`) in Vercel.

## Day-to-day operator guide

### 1. Sign in

Open `/login` and enter the shared password from `DASHBOARD_PASSWORD`.

If `DASHBOARD_SESSION_SECRET` is not set, the app falls back to `SHOPIFY_CLIENT_SECRET` for session signing.

### 2. Use the dashboard

Open `/dashboard`.

The dashboard lets you change:

- `Anchor date`: the reference date used for cadence math.
- `Delta interval (days)`: how often delta syncs become due.
- `Full interval (days)`: how often full syncs become due.
- `Delta lookback (days)`: how far back delta mode searches Shopify `updated_at`.
- `Default preview rows`: default row count for preview tables.
- `Default dry run`: default flag used by cron and manual sync runs.

What each section means:

- `Shopify`: confirms whether runtime credentials can talk to the connected store.
- `Next delta` and `Next full`: calculated next due dates based on the saved settings.
- `Store mode`: shows whether settings/history are stored in Vercel Blob, local files, or memory.

### 3. Preview the feed

The preview panel does not push anything to Google Merchant. It only scans Shopify and shows normalized output.

Preview modes:

- `Delta preview`: scans products updated inside the current lookback window and stops once enough preview rows are collected.
- `Full preview`: scans the full matching catalog and still shows only the requested preview-row count.

Preview controls:

- `Preview mode`: `delta` or `full`
- `Rows`: 1 to 25
- `Run preview`: starts the live preview scan

Preview behavior:

- Delta preview is best for day-to-day spot checks.
- Full preview is best when delta returns nothing or when mapping changes need a wider QA pass.
- Dashboard previews do not write run history.

### 4. Review run history

The run-history table records persisted sync attempts, not dashboard preview scans.

History rows can come from:

- Vercel cron runs
- Manual API test runs

Each stored run can include:

- Result status
- Trigger type
- Product / record / exclusion counts
- Query scope
- A saved sample of included rows
- A saved sample of excluded rows with reasons

Use the `View sample` link in the dashboard to open `/dashboard/runs/:id`.

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
- `dryRun=0` changes the run flag, but this build still does not perform Google writes.
- Manual runs persist history and save up to 50 included rows plus 50 excluded rows in the run artifact.

## Cron behavior

The cron route is designed for a Vercel cron job scheduled daily at `09:00 UTC`.

How the cron path works:

1. Vercel calls `/api/cron/sync`.
2. The route verifies `CRON_SECRET`.
3. The app loads the saved sync settings.
4. The app decides whether the day is `delta`, `full`, or `idle`.
5. If due, the app runs a read-only Shopify sync preview and stores history.

Important:

- Cron always runs on the daily schedule.
- Dashboard settings decide whether that day produces a delta run, full run, or no-op.
- The app currently stores preview artifacts, not live Merchant Center writes.

## Feed rules implemented so far

Confirmed mapping and exclusion rules in the current code:

- `brand` comes from Shopify `vendor`
- `availability` uses Shopify storefront sale state
- backorders remain `IN_STOCK`
- `additionalImageLinks` includes all non-primary product images
- videos are ignored
- `identifierExists` is `true` only when a valid GTIN or MPN exists
- apparel-only attributes are emitted for apparel product types
- `customLabel2` normalizes ad-spend codes to `a`, `b`, or `c`
- `shippingLabel` prioritizes state restrictions, then `fast_free`, then `Standard`
- exclude bundles, warranties, Loop products, return-shipping products, `Google_Exclude` items, zero-price variants, and variants with no image

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
- `SYNC_DEFAULT_DRY_RUN`
- `SYNC_LOOKBACK_DAYS`

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
