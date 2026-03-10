# DPP Product Feed Sync

Starter Next.js app for a Vercel-hosted Shopify to Google Merchant Center feed sync.

## What is in this repo

- A deployable homepage at `/` that explains the intended sync flow.
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
- `SYNC_ANCHOR_DATE`: UTC anchor date for cadence math.
- `SYNC_DELTA_INTERVAL_DAYS`: starter default is `7`.
- `SYNC_FULL_INTERVAL_DAYS`: starter default is `14`.
- `SYNC_DEFAULT_DRY_RUN`: starter default is `true`.

Integration placeholders:

- Shopify store domain and app credentials or access token.
- Google Merchant account ID and API data source.
- Google OAuth or service-account credentials.

## Vercel setup

1. Import this GitHub repo into Vercel.
2. Add the environment variables from `.env.example`.
3. Deploy once.
4. Visit `/api/health` on the deployed URL.
5. Test a manual dry run against `/api/sync/test?mode=delta&dryRun=1`.
6. Confirm the cron job exists in the Vercel project settings after deploy.

## Suggested implementation path

1. Decide whether Shopify access will be a custom app token or an OAuth-installed app with an offline token.
2. Build a Shopify product fetcher that only returns active products and preserves update timestamps.
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
