# DPP Product Feed Sync

Starter Next.js app for a Vercel-hosted Shopify to Google Merchant Center feed sync.

## What is in this repo

- A shared-password operator login at `/login`.
- An operator dashboard at `/dashboard` for cadence settings, sync history, and preview QA.
- A technical setup page at `/setup`.
- Shopify connection routes that use client credentials by default and keep OAuth as a fallback.
- A Shopify status endpoint at `/api/shopify/status`.
- A health endpoint at `/api/health`.
- A Vercel cron route at `/api/cron/sync`.
- A protected manual test route at `/api/sync/test`.
- A dry-run Shopify feed preview that fetches products in GraphQL pages of up to 250 records and returns normalized sample rows.
- Config helpers for a daily scheduler that can trigger delta syncs every 7 days and full refreshes every 15 days.

Nothing here pushes live product data to Google yet. The current code is intentionally read-only while the feed mapping is being validated.

## Local development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Environment variables

Copy `.env.example` to `.env.local` for local work, then add the same values in Vercel.

Core values:

- `CRON_SECRET`: recommended by Vercel to authenticate cron requests.
- `MANUAL_SYNC_TOKEN`: protects the manual test route.
- `DASHBOARD_PASSWORD`: shared password for the operator dashboard.
- `DASHBOARD_SESSION_SECRET`: signs the operator session cookie. If omitted, the app falls back to the Shopify client secret.
- `NEXT_PUBLIC_APP_URL`: the deployed base URL, for example `https://dpp-product-feed-sync.vercel.app`.
- `SYNC_ANCHOR_DATE`: UTC anchor date for cadence math.
- `SYNC_DELTA_INTERVAL_DAYS`: starter default is `7`.
- `SYNC_FULL_INTERVAL_DAYS`: starter default is `15`.
- `SYNC_DEFAULT_DRY_RUN`: starter default is `true`.

Integration placeholders:

- Shopify store domain, app credentials, and optional direct access token.
- Google Merchant account ID and API data source.
- Google feed language, feed label, and currency defaults for `productInputs` payload previews.
- Google OAuth or service-account credentials.
- Optional Vercel Blob storage for persistent settings and run history.

Shopify values for this app:

- `SHOPIFY_STORE_DOMAIN`: your `*.myshopify.com` domain.
- `SHOPIFY_CLIENT_ID`: from the Shopify app dashboard.
- `SHOPIFY_CLIENT_SECRET`: from the Shopify app dashboard.
- `SHOPIFY_AUTH_MODE`: starter default is `client_credentials`.
- `SHOPIFY_API_VERSION`: starter default is `2026-01`.
- `SHOPIFY_SCOPES`: starter default is `read_inventory,read_metaobjects,read_products`.
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: optional override. Leave blank if you want the app to mint a temporary token from the client ID and secret on demand.
- `GOOGLE_CONTENT_LANGUAGE`: starter default is `en`.
- `GOOGLE_FEED_LABEL`: starter default is `US`.
- `GOOGLE_FEED_CURRENCY`: starter default is `USD`.

## Vercel setup

1. Import this GitHub repo into Vercel.
2. Add the environment variables from `.env.example`.
3. Deploy once.
4. Set `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` in Vercel.
5. Set `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET` in Vercel.
6. Optional but recommended: attach Vercel Blob or set `BLOB_READ_WRITE_TOKEN` so settings and run history persist in production.
7. Visit `/api/shopify/install` on the deployed URL to test the client-credentials handshake.
8. Visit `/api/shopify/status` on the deployed URL to confirm the runtime token works.
9. Visit `/login`, then open `/dashboard`.
10. Set `MANUAL_SYNC_TOKEN` in Vercel for the protected preview route.
11. Visit `/api/sync/test?mode=delta&dryRun=1&limit=5` with `Authorization: Bearer your-token` to preview normalized records.
12. Visit `/api/health`.
13. Confirm the cron job exists in the Vercel project settings after deploy.

If you specifically need browser OAuth instead of client credentials:

1. Set the Shopify app URL to `https://your-vercel-domain`.
2. Add `https://your-vercel-domain/api/shopify/callback` as an allowed redirection URL.
3. Set `SHOPIFY_AUTH_MODE=oauth`.
4. Visit `/api/shopify/install?mode=oauth`.

## Suggested implementation path

1. Use Shopify client credentials for server-to-server access so the Vercel cron can mint a fresh Admin API token without a logged-in user.
2. Keep weekly delta syncs on normal GraphQL cursor pagination. The preview path already follows that model.
3. Expand the full-refresh path into Shopify Bulk Operations once the mapper is validated. Shopify GraphQL normal pagination tops out at 250 nodes per page, so Bulk is the right final shape for the all-products heartbeat.
4. Port the remaining spreadsheet logic into a code-based mapper with explicit exclusion rules and taxonomy mapping coverage.
5. Create a Google Merchant API data source and wire product upserts there.
6. Add alerts for failures or disapproved products.

## References

- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs
- Vercel managing cron jobs and `CRON_SECRET`: https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Google Merchant API overview: https://developers.google.com/merchant/api
- Google Merchant products guide: https://developers.google.com/merchant/api/guides/products/overview
- Shopify authentication: https://shopify.dev/docs/api/usage/authentication
- Shopify authorization code grant: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Shopify offline access tokens: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
