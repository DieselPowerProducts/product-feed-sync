# DPP Product Feed Sync

Starter Next.js app for a Vercel-hosted Shopify to Google Merchant Center feed sync.

## What is in this repo

- A deployable homepage at `/` that explains the intended sync flow.
- Shopify connection routes that use client credentials by default and keep OAuth as a fallback.
- A Shopify status endpoint at `/api/shopify/status`.
- A health endpoint at `/api/health`.
- A Vercel cron route at `/api/cron/sync`.
- A protected manual test route at `/api/sync/test`.
- Config helpers for a daily scheduler that can trigger delta syncs every 7 days and full refreshes every 14 days.

Nothing here pushes live product data yet. The current code is intentionally a safe scaffold for Vercel setup and early testing.

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
- `NEXT_PUBLIC_APP_URL`: the deployed base URL, for example `https://dpp-product-feed-sync.vercel.app`.
- `SYNC_ANCHOR_DATE`: UTC anchor date for cadence math.
- `SYNC_DELTA_INTERVAL_DAYS`: starter default is `7`.
- `SYNC_FULL_INTERVAL_DAYS`: starter default is `14`.
- `SYNC_DEFAULT_DRY_RUN`: starter default is `true`.

Integration placeholders:

- Shopify store domain, app credentials, and optional direct access token.
- Google Merchant account ID and API data source.
- Google OAuth or service-account credentials.

Shopify values for this app:

- `SHOPIFY_STORE_DOMAIN`: your `*.myshopify.com` domain.
- `SHOPIFY_CLIENT_ID`: from the Shopify app dashboard.
- `SHOPIFY_CLIENT_SECRET`: from the Shopify app dashboard.
- `SHOPIFY_AUTH_MODE`: starter default is `client_credentials`.
- `SHOPIFY_API_VERSION`: starter default is `2026-01`.
- `SHOPIFY_SCOPES`: starter default is `read_inventory,read_metaobjects,read_products`.
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: optional override. Leave blank if you want the app to mint a temporary token from the client ID and secret on demand.

## Vercel setup

1. Import this GitHub repo into Vercel.
2. Add the environment variables from `.env.example`.
3. Deploy once.
4. Set `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` in Vercel.
5. Visit `/api/shopify/install` on the deployed URL to test the client-credentials handshake.
6. Visit `/api/shopify/status` on the deployed URL to confirm the runtime token works.
7. Visit `/api/health`.
8. Confirm the cron job exists in the Vercel project settings after deploy.

If you specifically need browser OAuth instead of client credentials:

1. Set the Shopify app URL to `https://your-vercel-domain`.
2. Add `https://your-vercel-domain/api/shopify/callback` as an allowed redirection URL.
3. Set `SHOPIFY_AUTH_MODE=oauth`.
4. Visit `/api/shopify/install?mode=oauth`.

## Suggested implementation path

1. Use Shopify client credentials for server-to-server access so the Vercel cron can mint a fresh Admin API token without a logged-in user.
2. Build a Shopify product fetcher that only returns active and published products while preserving update timestamps.
3. Port the spreadsheet logic into a code-based mapper with explicit exclusion rules.
4. Create a Google Merchant API data source and wire product upserts there.
5. Add persistence for sync history, run summaries, and the last successful full refresh.
6. Add alerts for failures or disapproved products.

## References

- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs
- Vercel managing cron jobs and `CRON_SECRET`: https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Google Merchant API overview: https://developers.google.com/merchant/api
- Google Merchant products guide: https://developers.google.com/merchant/api/guides/products/overview
- Shopify authentication: https://shopify.dev/docs/api/usage/authentication
- Shopify authorization code grant: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Shopify offline access tokens: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
