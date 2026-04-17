import Link from "next/link";

const pipeline = [
  {
    title: "1. Ingest from Shopify",
    body: "Fetch active, published, and eligible products from Shopify, then filter out Google_Exclude items, seo.hidden items, and variants missing critical feed data.",
  },
  {
    title: "2. Transform for GMC",
    body: "Replace the spreadsheet formulas with a Node-based mapping layer that normalizes titles, descriptions, images, availability, price buckets, labels, and required Merchant Center attributes.",
  },
  {
    title: "3. Push through Merchant API",
    body: "Keep the preview path safe first, then turn on delta upserts and the recurring full refresh once the output has been QA-checked.",
  },
];

const starterRoutes = [
  {
    path: "/dashboard",
    description: "Shared operator dashboard with password gate, cadence settings, preview table, and run history.",
  },
  {
    path: "/api/shopify/status",
    description: "Uses the configured runtime token to verify that the deployed app can query the connected Shopify store.",
  },
  {
    path: "/api/health",
    description: "Returns app health, cadence settings, storage mode, and integration readiness for Shopify and Google Merchant.",
  },
  {
    path: "/api/cron/sync",
    description: "Vercel cron entrypoint. It decides whether today is a delta run, a full run, or a no-op day.",
  },
  {
    path: "/api/sync/test?mode=delta&dryRun=1&limit=5",
    description: "Protected manual test route for live Shopify previews outside the dashboard.",
  },
];

export default function SetupPage() {
  return (
    <main className="relative overflow-hidden">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 md:px-10">
        <div className="glass-panel relative overflow-hidden rounded-[2rem] px-6 py-8 md:px-10 md:py-12">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_center,rgba(197,92,22,0.18),transparent_65%)] lg:block" />
          <div className="relative grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-8">
              <div className="flex flex-wrap items-center gap-3 text-sm uppercase tracking-[0.3em] text-muted">
                <span className="rounded-full border border-line bg-white/55 px-3 py-1 font-mono text-[11px] tracking-[0.25em] text-accent-strong">
                  Technical Setup
                </span>
                <span>Vercel + Next.js + Shopify</span>
              </div>

              <div className="max-w-3xl space-y-5">
                <h1 className="text-5xl font-semibold tracking-[-0.05em] text-foreground md:text-7xl">
                  DPP product feed sync
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-muted md:text-xl">
                  This app is now split into an operator dashboard for daily
                  use and a setup area for technical routes, environment
                  checks, and raw integration status.
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                <Link
                  href="/dashboard"
                  className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
                >
                  Open dashboard
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
                  Weekly deltas with a 15-day full refresh guardrail.
                </p>
                <p className="mt-4 text-sm leading-7 text-muted">
                  Cursor-based previews are live. The eventual full-catalog
                  refresh should move to Shopify Bulk Operations once Google
                  writes are wired.
                </p>
              </div>

              <div className="rounded-[1.5rem] border border-line bg-[#1f1711] p-5 text-[#f9f2e7]">
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#f0cfaa]">
                  Current build state
                </p>
                <div className="mt-4 grid gap-3 text-sm leading-7 text-[#e9d5c0]">
                  <p>Shared-password operator dashboard is live.</p>
                  <p>Shopify client-credentials connect, preview fetches, and run history are wired.</p>
                  <p>One-time delta/full comparison exports run immediately from the dashboard and are stored as test-save files.</p>
                  <p>Live Merchant API writes now run when dry run is disabled, with full-sync reconciliation deleting stale Merchant rows.</p>
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

        <section className="mt-10 glass-panel rounded-[1.75rem] p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
                Technical routes
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                Setup and verification endpoints
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
