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

## Internal Operations

Detailed route, API, sync, storage, environment, and deployment instructions have been moved to the internal operations guide:

- [docs/INTERNAL_OPERATIONS.md](./docs/INTERNAL_OPERATIONS.md)

Important:

- This link is only access-controlled if the GitHub repository itself is private.
- If the repo is public, the linked document is public too.
