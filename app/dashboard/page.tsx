import Link from "next/link";
import { ActiveSyncRunPanel } from "@/app/dashboard/active-sync-run-panel";
import { PreviewPanel } from "@/app/dashboard/preview-panel";
import { FirstFullSyncButton } from "@/app/dashboard/first-full-sync-button";
import { requireOperatorAuthentication } from "@/lib/operator-auth";
import {
  getActiveSyncRun,
  getOperatorStoreStatus,
  getBootstrapState,
  getSyncHistory,
  getSyncSettings,
} from "@/lib/operator-store";
import { getRuntimeShopifyConnection } from "@/lib/shopify";
import {
  DEFAULT_PREVIEW_LIMIT,
  decideSyncMode,
  getUpcomingSyncDates,
} from "@/lib/sync";
import {
  deleteHistoryEntryAction,
  logoutAction,
  saveSettingsAction,
} from "@/app/dashboard/actions";

type DashboardPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type DashboardData = {
  settings: {
    anchorDate: string;
    deltaIntervalDays: number;
    fullIntervalDays: number;
    updatedAt: string;
  };
  history: Awaited<ReturnType<typeof getSyncHistory>>;
  storeStatus: ReturnType<typeof getOperatorStoreStatus>;
  shopifyConnection: Awaited<ReturnType<typeof getRuntimeShopifyConnection>>;
  bootstrap: Awaited<ReturnType<typeof getBootstrapState>>;
  activeRun: Awaited<ReturnType<typeof getActiveSyncRun>>;
  degraded: boolean;
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

function getSavedMessage(saved: string | undefined) {
  switch (saved) {
    case "settings":
      return {
        tone: "success" as const,
        text: "Dashboard settings were saved.",
      };
    case "first-full-success":
      return {
        tone: "success" as const,
        text: "Settings were saved and the first live full sync finished. Review run history below.",
      };
    case "first-full-failed":
      return {
        tone: "error" as const,
        text: "Settings were saved, but the first live full sync failed. Review run history below.",
      };
    case "first-full-already-complete":
      return {
        tone: "success" as const,
        text: "The first live full sync has already been completed, so that one-time bootstrap action is hidden.",
      };
    case "test-export-ready":
      return {
        tone: "success" as const,
        text: "The test save finished and the downloadable file is ready below.",
      };
    case "test-export-started":
      return {
        tone: "success" as const,
        text: "The test save was queued in the background. Refresh run history below in a few minutes for the completed file.",
      };
    case "test-export-running":
      return {
        tone: "error" as const,
        text: "Another sync or test save is already running. Wait for it to finish before starting a new test save.",
      };
    case "test-export-invalid":
      return {
        tone: "error" as const,
        text: "Choose either a delta or full test save.",
      };
    case "test-export-failed":
      return {
        tone: "error" as const,
        text: "The test save run failed. Check run history below for the failure details.",
      };
    case "history-deleted":
      return {
        tone: "success" as const,
        text: "The saved run and any associated export files were deleted.",
      };
    case "history-delete-invalid":
      return {
        tone: "error" as const,
        text: "The selected run could not be deleted.",
      };
    default:
      return null;
  }
}

async function loadDashboardData(now: Date): Promise<DashboardData> {
  const fallbackSettings = {
    anchorDate: now.toISOString().slice(0, 10),
    deltaIntervalDays: 7,
    fullIntervalDays: 15,
    updatedAt: now.toISOString(),
  };
  const fallbackStoreStatus = getOperatorStoreStatus();
  const results = await Promise.allSettled([
    getSyncSettings(),
    getSyncHistory(20),
    Promise.resolve(fallbackStoreStatus),
    getRuntimeShopifyConnection(),
    getBootstrapState(),
    getActiveSyncRun(),
  ]);

  return {
    settings:
      results[0].status === "fulfilled" ? results[0].value : fallbackSettings,
    history: results[1].status === "fulfilled" ? results[1].value : [],
    storeStatus:
      results[2].status === "fulfilled"
        ? results[2].value
        : fallbackStoreStatus,
    shopifyConnection:
      results[3].status === "fulfilled"
        ? results[3].value
        : {
            connected: false,
            error:
              "Dashboard could not load Shopify connection status for this request.",
          },
    bootstrap:
      results[4].status === "fulfilled"
        ? results[4].value
        : { firstFullSyncCompletedAt: null },
    activeRun: results[5].status === "fulfilled" ? results[5].value : null,
    degraded: results.some((result) => result.status === "rejected"),
  };
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function DashboardPage(props: DashboardPageProps) {
  await requireOperatorAuthentication();

  const searchParams = props.searchParams ? await props.searchParams : {};
  const now = new Date();
  const {
    settings,
    history,
    storeStatus,
    shopifyConnection,
    bootstrap,
    activeRun,
    degraded,
  } = await loadDashboardData(now);
  const decision = decideSyncMode(now, settings);
  const upcoming = getUpcomingSyncDates(now, settings);
  const saved = getSearchParam(searchParams, "saved");
  const flashMessage = getSavedMessage(saved);
  const syncHistory = history.filter((entry) => entry.purpose !== "test-save");
  const testSaveRuns = history.filter((entry) => entry.purpose === "test-save");

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
              This dashboard is for validating normalized feed output and
              controlling the sync schedule before Monday live Merchant Center
              pushes start.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/setup"
              className="rounded-full border border-line bg-white/65 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-white/90"
            >
              Technical setup
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

        {flashMessage ? (
          <div
            className={
              flashMessage.tone === "success"
                ? "mt-6 rounded-[1.4rem] border border-[rgba(29,111,85,0.18)] bg-[rgba(29,111,85,0.08)] px-4 py-3 text-sm text-success"
                : "mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-3 text-sm text-[#7d3d10]"
            }
          >
            {flashMessage.text}
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

        {degraded ? (
          <div className="mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
            Part of the dashboard data could not be loaded on this request. The
            page is running in fallback mode so you can still recover the app
            and inspect available history.
          </div>
        ) : null}
      </section>

      {activeRun ? (
        <section className="mt-8">
          <ActiveSyncRunPanel initialRun={activeRun} />
        </section>
      ) : null}

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

            <button
              type="submit"
              className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
            >
              Save settings
            </button>
          </form>

          <div className="mt-5 rounded-[1.25rem] border border-line bg-white/65 p-4">
            <p className="text-sm font-medium text-foreground">
              One-time bootstrap
            </p>
            <p className="mt-2 text-sm leading-7 text-muted">
              Run the first live full sync after saving the cadence above. Once
              the initial catalog load succeeds, this control stays visible but
              locked so the original bootstrap action cannot be rerun by
              accident.
            </p>
            <FirstFullSyncButton
              disabled={
                Boolean(bootstrap.firstFullSyncCompletedAt) || Boolean(activeRun)
              }
              disabledDetail={
                bootstrap.firstFullSyncCompletedAt
                  ? `Completed on ${formatTimestamp(bootstrap.firstFullSyncCompletedAt)}. Ask to re-enable it only if you ever need a deliberate manual bootstrap again.`
                  : activeRun
                    ? "A live sync is already running. Use the active sync panel above to monitor or pause it."
                  : null
              }
            />
          </div>
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
                  Vercel cron still runs daily at <code>09:00 UTC</code>.
                  <br />
                  The UI controls cadence logic, not the cron clock itself.
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
            Dry-run previews stay read-only. Live sync attempts now write
            through the Merchant API when dry run is disabled.
          </p>
        </div>

        {syncHistory.length ? (
          <div className="mt-6 overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Result</th>
                    <th className="px-4 py-3">Counts</th>
                    <th className="px-4 py-3">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {syncHistory.map((entry) => (
                    <tr key={entry.id} className="border-b border-line/70 align-top last:border-b-0">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-foreground">
                          {formatTimestamp(entry.startedAt)}
                        </p>
                        <p className="mt-2 text-muted">{entry.trigger}</p>
                      </td>
                      <td className="px-4 py-4 text-muted">
                        {formatDuration(entry.startedAt, entry.finishedAt)}
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
                            !entry.ok || (entry.stats.validationIssues ?? 0) > 0
                              ? "font-semibold text-accent-strong"
                              : "font-semibold text-success"
                          }
                        >
                          {!entry.ok
                            ? "failed"
                            : (entry.stats.validationIssues ?? 0) > 0
                              ? "needs attention"
                              : "success"}
                        </p>
                        <p className="mt-2 text-muted">{entry.notes[0] ?? "No notes"}</p>
                        {(entry.stats.validationIssues ?? 0) > 0 ? (
                          <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em] text-accent-strong">
                            {entry.stats.validationIssues} validation issue
                            {(entry.stats.validationIssues ?? 0) === 1 ? "" : "s"}
                          </p>
                        ) : null}
                        {entry.artifactId ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Link
                              href={`/dashboard/runs/${entry.artifactId}`}
                              className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                            >
                              View sample
                            </Link>
                            {entry.exportArtifactId ? (
                              <>
                                <a
                                  href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&format=csv`}
                                  className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                                >
                                  Download CSV
                                </a>
                                <a
                                  href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&format=xlsx`}
                                  className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                                >
                                  Download XLSX
                                </a>
                                <a
                                  href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&kind=validation&format=csv`}
                                  className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                                >
                                  Validation CSV
                                </a>
                                <a
                                  href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&kind=excluded&format=csv`}
                                  className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                                >
                                  Excluded CSV
                                </a>
                              </>
                            ) : null}
                            <form action={deleteHistoryEntryAction}>
                              <input type="hidden" name="entryId" value={entry.id} />
                              <button
                                type="submit"
                                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                              >
                                Delete run
                              </button>
                            </form>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        <p>Products: {entry.stats.productsFetched}</p>
                        <p className="mt-2">Records: {entry.stats.recordsPrepared}</p>
                        <p className="mt-2">Excluded: {entry.stats.excluded}</p>
                        <p className="mt-2">
                          Validation: {entry.stats.validationIssues ?? 0}
                        </p>
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

      <section className="mt-8 glass-panel rounded-[1.75rem] p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Test save
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              Save a full or delta comparison file
            </h2>
          </div>
          <p className="max-w-2xl text-sm leading-7 text-muted">
            Use this for a one-time QA export that matches production sync
            scope exactly. CSV is the closest match for comparing against the
            current GMC file, and the XLSX download also includes summary and
            exclusion sheets.
          </p>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <article className="rounded-[1.5rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              One-time export
            </p>
            <form
              action="/api/dashboard/test-save"
              method="post"
              className="mt-4 grid gap-4"
            >
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Test mode
                </span>
                <select
                  name="mode"
                  defaultValue="full"
                  className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
                >
                  <option value="full">Full product test save</option>
                  <option value="delta">Delta product test save</option>
                </select>
              </label>
              <p className="text-sm leading-7 text-muted">
                Test saves always run immediately and stay in dry-run mode, but
                they use the same delta/full scope rules as production. Use
                them to generate a comparison file without touching Merchant
                Center.
              </p>

              <button
                type="submit"
                className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
              >
                Save test file
              </button>
            </form>
          </article>

          <article className="rounded-[1.5rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Test Save Files
            </p>
            {testSaveRuns.length ? (
              <div className="mt-4 grid gap-4">
                {testSaveRuns.map((entry) => (
                  <div
                    key={`${entry.id}-test-save-file`}
                    className="rounded-[1.25rem] border border-line bg-white/80 p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="text-2xl font-semibold tracking-[-0.04em] text-foreground">
                          {entry.mode === "full"
                            ? "Full product test save"
                            : "Delta product test save"}
                        </p>
                        <p className="mt-3 text-sm leading-7 text-muted">
                          {entry.ok
                            ? `Ready ${formatTimestamp(entry.finishedAt)}.`
                            : `Failed ${formatTimestamp(entry.finishedAt)}.`}
                        </p>
                        <p className="text-sm leading-7 text-muted">
                          Records {entry.stats.recordsPrepared}, excluded{" "}
                          {entry.stats.excluded}, validation{" "}
                          {entry.stats.validationIssues ?? 0}.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {entry.exportArtifactId ? (
                          <>
                            <a
                              href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&format=csv`}
                              className="inline-flex rounded-full bg-accent px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-white transition-transform hover:-translate-y-0.5"
                            >
                              Download CSV
                            </a>
                            <a
                              href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&format=xlsx`}
                              className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                            >
                              Download XLSX
                            </a>
                            <a
                              href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&kind=validation&format=csv`}
                              className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                            >
                              Validation CSV
                            </a>
                            <a
                              href={`/api/dashboard/export/preview?id=${encodeURIComponent(entry.exportArtifactId)}&kind=excluded&format=csv`}
                              className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                            >
                              Excluded CSV
                            </a>
                          </>
                        ) : null}
                        {entry.artifactId ? (
                          <Link
                            href={`/dashboard/runs/${entry.artifactId}`}
                            className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                          >
                            View sample
                          </Link>
                        ) : null}
                        <form action={deleteHistoryEntryAction}>
                          <input type="hidden" name="entryId" value={entry.id} />
                          <button
                            type="submit"
                            className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-[1.25rem] border border-dashed border-line bg-white/55 p-4 text-sm leading-7 text-muted">
                No test-save attempts have completed yet.
              </div>
            )}
          </article>
        </div>
      </section>
    </main>
  );
}
