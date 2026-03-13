import Link from "next/link";
import { PreviewPanel } from "@/app/dashboard/preview-panel";
import { requireOperatorAuthentication } from "@/lib/operator-auth";
import {
  getOperatorStoreStatus,
  getSyncHistory,
  getSyncSettings,
} from "@/lib/operator-store";
import { getRuntimeShopifyConnection } from "@/lib/shopify";
import {
  DEFAULT_PREVIEW_LIMIT,
  decideSyncMode,
  getUpcomingSyncDates,
} from "@/lib/sync";
import { logoutAction, saveSettingsAction } from "@/app/dashboard/actions";

type DashboardPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

function formatDuration(startedAt: string, finishedAt: string) {
  const startedMs = new Date(startedAt).getTime();
  const finishedMs = new Date(finishedAt).getTime();

  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    return "-";
  }

  const totalSeconds = Math.round((finishedMs - startedMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

function prettifyStorageMode(mode: "blob" | "local" | "memory") {
  if (mode === "blob") {
    return "Vercel Blob";
  }

  if (mode === "local") {
    return "Local file";
  }

  return "In-memory";
}

export const dynamic = "force-dynamic";

export default async function DashboardPage(props: DashboardPageProps) {
  await requireOperatorAuthentication();

  const searchParams = props.searchParams ? await props.searchParams : {};
  const now = new Date();
  const [settings, history, storeStatus, shopifyConnection] = await Promise.all([
    getSyncSettings(),
    getSyncHistory(20),
    Promise.resolve(getOperatorStoreStatus()),
    getRuntimeShopifyConnection(),
  ]);
  const decision = decideSyncMode(now, settings);
  const upcoming = getUpcomingSyncDates(now, settings);
  const saved = getSearchParam(searchParams, "saved") === "settings";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 md:px-10">
      <section className="glass-panel rounded-[2rem] px-6 py-8 md:px-10 md:py-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent-strong">
              Operator Dashboard
            </p>
            <h1 className="text-foreground">
              <span className="block text-4xl font-bold tracking-[-0.05em] md:text-[64px] md:tracking-[-4px]">
                Product Feed Preview -
              </span>
              <span className="block text-4xl font-semibold tracking-[0.02em] md:text-[2.5rem] md:tracking-[2px]">
                Scheduling and Run History
              </span>
            </h1>
            <p className="max-w-2xl text-base leading-8 text-muted md:text-lg">
              Shopify is live and authenticated. This dashboard is for
              validating normalized feed output and controlling the sync Schedule
              before Google Merchant writes are turned on.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/setup"
              className="rounded-full border border-line bg-white/65 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-white/90"
            >
              Technical setup
            </Link>
            <Link
              href="/api/shopify/status"
              className="rounded-full border border-line bg-white/65 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-white/90"
            >
              Raw Shopify status
            </Link>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-full bg-[#1f1711] px-5 py-3 text-sm font-semibold text-[#f9f2e7]"
              >
                Log out
              </button>
            </form>
          </div>
        </div>

        {saved ? (
          <div className="mt-6 rounded-[1.4rem] border border-[rgba(29,111,85,0.18)] bg-[rgba(29,111,85,0.08)] px-4 py-3 text-sm text-success">
            Dashboard settings were saved.
          </div>
        ) : null}

        {!storeStatus.persistent ? (
          <div className="mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
            History and settings are currently running on{" "}
            <strong>{prettifyStorageMode(storeStatus.mode)}</strong>. On Vercel,
            that will not persist across cold starts unless you add{" "}
            <code>BLOB_READ_WRITE_TOKEN</code>.
          </div>
        ) : null}
      </section>

      <section className="mt-8 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="glass-panel rounded-[1.75rem] p-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
                Schedule settings
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                Schedule when syncs become due
              </h2>
            </div>
            <p className="text-sm text-muted">Last updated {formatTimestamp(settings.updatedAt)}</p>
          </div>

          <form action={saveSettingsAction} className="mt-6 grid gap-4">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Anchor date</span>
              <input
                name="anchorDate"
                type="date"
                defaultValue={settings.anchorDate}
                className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Delta interval (days)
                </span>
                <input
                  name="deltaIntervalDays"
                  type="number"
                  min={1}
                  defaultValue={settings.deltaIntervalDays}
                  className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Full interval (days)
                </span>
                <input
                  name="fullIntervalDays"
                  type="number"
                  min={1}
                  defaultValue={settings.fullIntervalDays}
                  className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
                />
              </label>
            </div>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">
                Delta lookback (days)
              </span>
              <input
                name="lookbackDays"
                type="number"
                min={1}
                defaultValue={settings.lookbackDays}
                className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
              />
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-line bg-white/65 px-4 py-4 text-sm">
              <input
                name="defaultDryRun"
                type="checkbox"
                defaultChecked={settings.defaultDryRun}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Keep scheduled syncs in dry-run mode by default until Google write
              paths are ready.
            </label>

            <button
              type="submit"
              className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
            >
              Save settings
            </button>
          </form>
        </article>

        <article className="glass-panel rounded-[1.75rem] p-6">
          <div className="grid gap-4">
            <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Shopify
              </p>
              <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
                <p className="text-3xl font-semibold tracking-[-0.04em] text-foreground">
                  {shopifyConnection.connected ? "Connected" : "Issue"}
                </p>
                <p className="text-sm leading-7 text-muted">
                  {shopifyConnection.connected
                    ? shopifyConnection.shop?.name ?? "Connected shop"
                    : shopifyConnection.error}
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <article className="rounded-[1.4rem] border border-line bg-white/65 p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                  Next delta
                </p>
                <p className="mt-4 text-3xl font-semibold tracking-[-0.04em]">
                  {upcoming.deltaDate}
                </p>
                <p className="mt-3 text-sm leading-7 text-muted">
                  Current interval: every {settings.deltaIntervalDays} day(s)
                </p>
              </article>

              <article className="rounded-[1.4rem] border border-line bg-white/65 p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                  Next full
                </p>
                <p className="mt-4 text-3xl font-semibold tracking-[-0.04em]">
                  {upcoming.fullDate}
                </p>
                <p className="mt-3 text-sm leading-7 text-muted">
                  Current interval: every {settings.fullIntervalDays} day(s)
                </p>
              </article>
            </div>

            <article className="rounded-[1.4rem] border border-line bg-white/65 p-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Store mode
              </p>
              <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
                <p className="text-3xl font-semibold tracking-[-0.04em]">
                  {prettifyStorageMode(storeStatus.mode)}
                </p>
                <p className="max-w-xl text-sm leading-7 text-muted">
                  Vercel cron still runs daily at <code>09:00 UTC</code>. The UI
                  controls cadence logic, not the cron clock itself.
                </p>
              </div>
            </article>
          </div>
        </article>
      </section>

      <section className="mt-8">
        <PreviewPanel
          defaultPreviewLimit={DEFAULT_PREVIEW_LIMIT}
          decisionReason={decision.reason}
        />
      </section>

      <section className="mt-8 glass-panel rounded-[1.75rem] p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Run history
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              Previous sync attempts
            </h2>
          </div>
          <p className="text-sm text-muted">
            Google writes are disabled, so this currently reflects preview and
            sync attempts only.
          </p>
        </div>

        {history.length ? (
          <div className="mt-6 overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Result</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Counts</th>
                    <th className="px-4 py-3">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b border-line/70 align-top last:border-b-0">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-foreground">
                          {formatTimestamp(entry.startedAt)}
                        </p>
                        <p className="mt-2 text-muted">{entry.trigger}</p>
                      </td>
                      <td className="px-4 py-4">
                        <p className="font-semibold text-foreground">{entry.mode}</p>
                        <p className="mt-2 text-muted">
                          {entry.dryRun ? "dry run" : "live mode flag"}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <p
                          className={
                            entry.ok
                              ? "font-semibold text-success"
                              : "font-semibold text-accent-strong"
                          }
                        >
                          {entry.ok ? "success" : "failed"}
                        </p>
                        <p className="mt-2 text-muted">{entry.notes[0] ?? "No notes"}</p>
                        {entry.artifactId ? (
                          <Link
                            href={`/dashboard/runs/${entry.artifactId}`}
                            className="mt-3 inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                          >
                            View sample
                          </Link>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        {formatDuration(entry.startedAt, entry.finishedAt)}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        <p>Products: {entry.stats.productsFetched}</p>
                        <p className="mt-2">Records: {entry.stats.recordsPrepared}</p>
                        <p className="mt-2">Excluded: {entry.stats.excluded}</p>
                      </td>
                      <td className="px-4 py-4 text-muted">
                        <p>{entry.scope}</p>
                        <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em]">
                          {entry.query}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
            No sync runs have been recorded yet.
          </div>
        )}
      </section>
    </main>
  );
}
