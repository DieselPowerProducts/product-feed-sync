import Link from "next/link";

const pipeline = [
  {
    title: "1. Ingest from Shopify",
    body: "Fetch active, published, and eligible products from Shopify, then filter out excluded tags, zero-dollar bundles, warranties, return labels, and products missing critical feed data.",
  },
  {
    title: "2. Transform for GMC",
    body: "Replace the spreadsheet formulas with a Node-based mapping layer that normalizes titles, descriptions, images, availability, price buckets, labels, and required Merchant Center attributes.",
  },
  {
    title: "3. Push through Merchant API",
    body: "Start with a dry run and a small test batch, then upsert delta changes on a schedule while keeping a recurring full refresh so Google does not expire products.",
  },
];

const starterRoutes = [
  {
    path: "/api/shopify/install",
    description: "Starts the Shopify OAuth install flow and requests an offline Admin API token for this app.",
  },
  {
    path: "/api/shopify/status",
    description: "Uses the configured runtime token to verify that the deployed app can query the connected Shopify store.",
  },
  {
    path: "/api/health",
    description: "Returns app health, cadence settings, and integration readiness for Shopify and Google Merchant.",
  },
  {
    path: "/api/cron/sync",
    description: "Vercel cron entrypoint. It decides whether today is a delta run, a full run, or a no-op day.",
  },
  {
    path: "/api/sync/test?mode=delta&dryRun=1",
    description: "Protected manual test route for small proof-of-life runs before any live product updates.",
  },
];

const nextSteps = [
  "Set the Shopify app URL to your Vercel domain and add /api/shopify/callback as an allowed redirection URL.",
  "Add the Shopify client ID and secret in Vercel, then run /api/shopify/install once to obtain the offline Admin API token.",
  "Save the returned token as SHOPIFY_ADMIN_ACCESS_TOKEN in Vercel and redeploy before relying on cron runs.",
  "Create a Merchant Center API data source first. Google's Merchant API writes to API-backed data sources, not the old spreadsheet fetch flow.",
  "Port the spreadsheet formulas into code and document every exclusion rule so feed behavior is reviewable and changeable.",
];

export default function Home() {
  return (
    <main className="relative overflow-hidden">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 md:px-10">
        <div className="glass-panel relative overflow-hidden rounded-[2rem] px-6 py-8 md:px-10 md:py-12">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_center,rgba(197,92,22,0.18),transparent_65%)] lg:block" />
          <div className="relative grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-8">
              <div className="flex flex-wrap items-center gap-3 text-sm uppercase tracking-[0.3em] text-muted">
                <span className="rounded-full border border-line bg-white/55 px-3 py-1 font-mono text-[11px] tracking-[0.25em] text-accent-strong">
                  Starter App
                </span>
                <span>Vercel + Next.js + Shopify OAuth</span>
              </div>

              <div className="max-w-3xl space-y-5">
                <h1 className="text-5xl font-semibold tracking-[-0.05em] text-foreground md:text-7xl">
                  DPP product feed sync
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-muted md:text-xl">
                  This app replaces a spreadsheet-heavy Google Shopping
                  workflow with a Vercel-hosted sync service that can
                  authenticate to Shopify, normalize the catalog into your feed
                  format, and push the result into Google Merchant Center.
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                <Link
                  href="/api/shopify/install"
                  className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
                >
                  Connect Shopify
                </Link>
                <Link
                  href="/api/shopify/status"
                  className="rounded-full border border-line bg-white/55 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-white/85"
                >
                  Check Shopify status
                </Link>
              </div>
            </div>

            <div className="grid gap-4 self-start">
              <div className="rounded-[1.5rem] border border-line bg-panel-strong p-5">
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
                  Automation target
                </p>
                <p className="mt-4 text-2xl font-semibold tracking-[-0.04em]">
                  Weekly delta syncs with a recurring full refresh guardrail.
                </p>
                <p className="mt-4 text-sm leading-7 text-muted">
                  The starter cron runs once per day in UTC and decides whether
                  the current date is due for a delta run, a full run, or a
                  no-op. That keeps the cadence configurable without changing
                  the deployment every time the schedule changes.
                </p>
              </div>

              <div className="rounded-[1.5rem] border border-line bg-[#1f1711] p-5 text-[#f9f2e7]">
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#f0cfaa]">
                  Current build state
                </p>
                <div className="mt-4 grid gap-3 text-sm leading-7 text-[#e9d5c0]">
                  <p>Homepage and deployable app shell are in place.</p>
                  <p>Shopify install, callback, and runtime status routes are wired.</p>
                  <p>Google Merchant credentials and the feed mapper still need to be implemented.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <section className="mt-10 grid gap-5 lg:grid-cols-3">
          {pipeline.map((step) => (
            <article
              key={step.title}
              className="glass-panel rounded-[1.75rem] p-6 transition-transform hover:-translate-y-1"
            >
              <h2 className="text-2xl font-semibold tracking-[-0.04em]">
                {step.title}
              </h2>
              <p className="mt-4 text-base leading-8 text-muted">
                {step.body}
              </p>
            </article>
          ))}
        </section>

        <section className="mt-10 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
          <article className="glass-panel rounded-[1.75rem] p-6">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Feed rules to capture
            </p>
            <div className="mt-5 grid gap-4 text-sm leading-7 text-muted">
              <p>Exclude products tagged with `Google_Exclude`.</p>
              <p>Filter out Loop products, Extend warranties, return shipping items, and empty-image variants.</p>
              <p>Reject bundles or other listings with a price of `0`.</p>
              <p>Normalize Shopify HTML descriptions, primary URLs, image links, and variant/product IDs into the Google feed shape.</p>
              <p>Keep a clear code-based mapping layer so the business team can adjust rules without spreadsheet archaeology.</p>
            </div>
          </article>

          <article id="roadmap" className="glass-panel rounded-[1.75rem] p-6">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              What to do next
            </p>
            <div className="mt-5 grid gap-4">
              {nextSteps.map((step) => (
                <div
                  key={step}
                  className="rounded-2xl border border-line bg-white/55 px-4 py-4 text-sm leading-7 text-foreground"
                >
                  {step}
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="mt-10 glass-panel rounded-[1.75rem] p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
                Starter routes
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                Safe entry points for install, deployment, and testing
              </h2>
            </div>
            <a
              href="https://developers.google.com/merchant/api"
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-accent-strong"
            >
              Google Merchant API docs
            </a>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {starterRoutes.map((route) => (
              <article
                key={route.path}
                className="rounded-[1.5rem] border border-line bg-white/60 p-5"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-accent-strong">
                  {route.path}
                </p>
                <p className="mt-4 text-sm leading-7 text-muted">
                  {route.description}
                </p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
