import Link from "next/link";
import { notFound } from "next/navigation";
import { FeedPreviewTable } from "@/app/dashboard/feed-preview-table";
import { requireOperatorAuthentication } from "@/lib/operator-auth";
import { readRunArtifact } from "@/lib/operator-store";
import type { SyncRunArtifact } from "@/lib/sync";

type RunSamplePageProps = {
  params: Promise<{
    id: string;
  }>;
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

function describeRunSource(artifact: {
  trigger: "cron" | "manual";
  purpose: "sync" | "test-save" | null;
}) {
  if (artifact.trigger === "cron" && artifact.purpose === "sync") {
    return "scheduled real sync";
  }

  if (artifact.trigger === "cron" && artifact.purpose === "test-save") {
    return "legacy scheduled test save";
  }

  if (artifact.trigger === "manual" && artifact.purpose === "test-save") {
    return "manual test save";
  }

  return artifact.trigger === "cron" ? "scheduled" : "manual";
}

export const dynamic = "force-dynamic";

export default async function RunSamplePage(props: RunSamplePageProps) {
  await requireOperatorAuthentication();

  const { id } = await props.params;
  const artifact = await readRunArtifact<SyncRunArtifact>(id);
  const validationIssues = artifact?.stats.validationIssues ?? 0;
  const validationSample = artifact?.validationSample ?? [];

  if (!artifact) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 md:px-10">
      <section className="glass-panel rounded-[2rem] px-6 py-8 md:px-10 md:py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent-strong">
              Run Sample
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-0.05em] text-foreground md:text-5xl">
              {artifact.mode} {describeRunSource(artifact)} run
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-8 text-muted">
              Stored QA sample for this run. Included rows are exact Merchant API
              payload rows captured from the run artifact.
            </p>
          </div>

          <Link
            href="/dashboard"
            className="rounded-full border border-line bg-white/65 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-white/90"
          >
            Back to dashboard
          </Link>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-6">
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Started
            </p>
            <p className="mt-3 text-lg font-semibold text-foreground">
              {formatTimestamp(artifact.startedAt)}
            </p>
          </div>
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Result
            </p>
            <p
              className={
                !artifact.ok || validationIssues > 0
                  ? "mt-3 text-lg font-semibold text-accent-strong"
                  : "mt-3 text-lg font-semibold text-success"
              }
            >
              {!artifact.ok
                ? "failed"
                : validationIssues > 0
                  ? "needs attention"
                  : "success"}
            </p>
          </div>
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Included sample
            </p>
            <p className="mt-3 text-lg font-semibold text-foreground">
              {artifact.includedSample.length}
            </p>
          </div>
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Validation sample
            </p>
            <p className="mt-3 text-lg font-semibold text-foreground">
              {validationSample.length}
            </p>
          </div>
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Excluded sample
            </p>
            <p className="mt-3 text-lg font-semibold text-foreground">
              {artifact.excludedSample.length}
            </p>
          </div>
          <div className="rounded-[1.4rem] border border-line bg-white/65 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
              Validation issues
            </p>
            <p
              className={
                validationIssues > 0
                  ? "mt-3 text-lg font-semibold text-accent-strong"
                  : "mt-3 text-lg font-semibold text-foreground"
              }
            >
              {validationIssues}
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-[1.4rem] border border-line bg-white/65 p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
            Query
          </p>
          <p className="mt-3 text-sm leading-7 text-muted">{artifact.query}</p>
        </div>

        <div className="mt-6 rounded-[1.4rem] border border-line bg-white/65 p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
            Notes
          </p>
          <div className="mt-4 grid gap-2 text-sm leading-7 text-muted">
            {artifact.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
          {artifact.exportArtifactId ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(artifact.exportArtifactId)}&format=csv`}
                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
              >
                Download Feed CSV
              </a>
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(artifact.exportArtifactId)}&format=xlsx`}
                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
              >
                Download Feed XLSX
              </a>
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(artifact.exportArtifactId)}&kind=validation&format=csv`}
                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
              >
                Download Validation CSV
              </a>
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(artifact.exportArtifactId)}&kind=excluded&format=csv`}
                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
              >
                Download Excluded CSV
              </a>
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(artifact.exportArtifactId)}&kind=excluded&format=xlsx`}
                className="inline-flex rounded-full border border-line bg-white/75 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong transition-colors hover:bg-white"
              >
                Download Excluded XLSX
              </a>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-8 glass-panel rounded-[1.75rem] p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Validation Sample
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              Rows blocked by Google feed validation
            </h2>
          </div>
          <p className="text-sm text-muted">
            Up to 250 validation rows are saved with reasons.
          </p>
        </div>

        {validationSample.length ? (
          <div className="mt-6 overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Variant</th>
                    <th className="px-4 py-3">Offer</th>
                    <th className="px-4 py-3">SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {validationSample.map((row, index) => (
                    <tr
                      key={`${row.reason}-${row.productId}-${row.variantId ?? "product"}-${index}`}
                      className="border-b border-line/70 align-top last:border-b-0"
                    >
                      <td className="px-4 py-4 font-semibold text-accent-strong">
                        <p>{row.reason}</p>
                        {row.details?.length ? (
                          <div className="mt-2 grid gap-1 text-xs font-normal normal-case tracking-normal text-muted">
                            {row.details.map((detail) => (
                              <p key={`${row.reason}-${detail}`}>{detail}</p>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        <p>{row.title}</p>
                        <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em]">
                          {row.productId}
                        </p>
                        {row.link ? (
                          <a
                            href={row.link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong"
                          >
                            Open product
                          </a>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        {row.variantTitle ?? "-"}
                        {row.variantId ? (
                          <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em]">
                            {row.variantId}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">{row.offerId ?? "-"}</td>
                      <td className="px-4 py-4 text-muted">{row.sku ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
            No validation rows were stored for this run.
          </div>
        )}
      </section>

      <section className="mt-8 glass-panel rounded-[1.75rem] p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Included Sample
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              Stored Merchant API payload rows
            </h2>
          </div>
          <p className="text-sm text-muted">
            Up to 50 normalized rows are saved per run.
          </p>
        </div>

        {artifact.includedSample.length ? (
          <div className="mt-6">
            <FeedPreviewTable
              records={artifact.includedSample}
              emptyMessage="No included sample rows were stored for this run."
              defaultColumnWidth={150}
            />
          </div>
        ) : (
          <div className="mt-6 rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
            No included sample rows were stored for this run.
          </div>
        )}
      </section>

      <section className="mt-8 glass-panel rounded-[1.75rem] p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
              Excluded Sample
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              Rows filtered out during the run
            </h2>
          </div>
          <p className="text-sm text-muted">
            Up to 250 excluded rows are saved with reasons.
          </p>
        </div>

        {artifact.excludedSample.length ? (
          <div className="mt-6 overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Variant</th>
                    <th className="px-4 py-3">Offer</th>
                    <th className="px-4 py-3">SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {artifact.excludedSample.map((row, index) => (
                    <tr
                      key={`${row.reason}-${row.productId}-${row.variantId ?? "product"}-${index}`}
                      className="border-b border-line/70 align-top last:border-b-0"
                    >
                      <td className="px-4 py-4 font-semibold text-accent-strong">
                        <p>{row.reason}</p>
                        {row.details?.length ? (
                          <div className="mt-2 grid gap-1 text-xs font-normal normal-case tracking-normal text-muted">
                            {row.details.map((detail) => (
                              <p key={`${row.reason}-${detail}`}>{detail}</p>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        <p>{row.title}</p>
                        <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em]">
                          {row.productId}
                        </p>
                        {row.link ? (
                          <a
                            href={row.link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong"
                          >
                            Open product
                          </a>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">
                        {row.variantTitle ?? "-"}
                        {row.variantId ? (
                          <p className="mt-2 font-mono text-xs uppercase tracking-[0.16em]">
                            {row.variantId}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-muted">{row.offerId ?? "-"}</td>
                      <td className="px-4 py-4 text-muted">{row.sku ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
            No excluded sample rows were stored for this run.
          </div>
        )}
      </section>
    </main>
  );
}
