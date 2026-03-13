"use client";

import { useEffect, useRef, useState } from "react";
import {
  FeedPreviewTable,
  type FeedPreviewRecord,
} from "@/app/dashboard/feed-preview-table";

type PreviewResult = {
  ok: boolean;
  mode: "delta" | "full";
  exhaustive: boolean;
  exportArtifactId?: string | null;
  query: string;
  stats: {
    pageSize: number;
    productsFetched: number;
    pagesScanned: number;
    scanCompleted: boolean;
    totalProducts: number | null;
    variantsConsidered: number;
    recordsPrepared: number;
    excluded: number;
    previewLimit: number;
  };
  exclusions: Record<string, number>;
  notes: string[];
  preview: FeedPreviewRecord[];
};

type PreviewProgress = {
  stage: "counting" | "scanning" | "complete";
  exhaustive: boolean;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  previewRows: number;
  message: string;
};

export function PreviewPanel(props: {
  defaultPreviewLimit: number;
  decisionReason: string;
}) {
  const [mode, setMode] = useState<"delta" | "full">("delta");
  const [runIntent, setRunIntent] = useState<"preview" | "full">("preview");
  const [limit, setLimit] = useState(String(props.defaultPreviewLimit));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [progress, setProgress] = useState<PreviewProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef(0);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  async function runPreview(intent: "preview" | "full") {
    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;
    eventSourceRef.current?.close();
    setRunIntent(intent);
    setIsLoading(true);
    setError(null);
    setProgress({
      stage: "counting",
      exhaustive: intent === "full",
      totalProducts: null,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message:
        mode === "full"
          ? "Counting active Shopify products in the full catalog."
          : intent === "full"
            ? "Counting Shopify products in the current delta window for the full export."
            : "Counting Shopify products in the current delta lookback window.",
    });
    setResult(null);

    const exhaustive = intent === "full";
    const source = new EventSource(
      `/api/dashboard/preview-stream?mode=${mode}&limit=${encodeURIComponent(limit)}&exhaustive=${exhaustive ? "1" : "0"}`,
    );
    eventSourceRef.current = source;
    let settled = false;

    source.addEventListener("progress", (event) => {
      if (settled || activeRunIdRef.current !== runId) {
        return;
      }

      const payload = JSON.parse((event as MessageEvent<string>).data) as PreviewProgress;
      setProgress(payload);
    });

    source.addEventListener("complete", (event) => {
      if (settled || activeRunIdRef.current !== runId) {
        return;
      }

      settled = true;
      const payload = JSON.parse((event as MessageEvent<string>).data) as PreviewResult;
      const progressTotal = payload.exhaustive
        ? payload.stats.totalProducts
        : Math.min(
            payload.stats.totalProducts ?? payload.stats.pageSize,
            payload.stats.pageSize,
          );
      setResult(payload);
      setProgress({
        stage: "complete",
        exhaustive: payload.exhaustive,
        totalProducts: progressTotal,
        productsScanned:
          payload.stats.scanCompleted && typeof progressTotal === "number"
            ? progressTotal
            : payload.exhaustive
              ? payload.stats.productsFetched
              : Math.min(payload.stats.productsFetched, progressTotal ?? payload.stats.pageSize),
        pagesScanned: payload.stats.pagesScanned,
        previewRows: payload.preview.length,
        message: payload.stats.scanCompleted
          ? "Catalog scan completed."
          : "Catalog scan stopped before the end of the catalog.",
      });
      setIsLoading(false);
      eventSourceRef.current = null;
      source.close();
    });

    source.addEventListener("failure", (event) => {
      if (settled || activeRunIdRef.current !== runId) {
        return;
      }

      settled = true;
      const payload =
        "data" in event && typeof event.data === "string" && event.data
          ? (JSON.parse(event.data) as { message?: string })
          : null;
      setError(payload?.message ?? "Preview request failed.");
      setIsLoading(false);
      eventSourceRef.current = null;
      source.close();
    });

    source.onerror = () => {
      if (settled || activeRunIdRef.current !== runId || source.readyState === EventSource.CLOSED) {
        return;
      }

      settled = true;
      setError("Preview stream disconnected.");
      setIsLoading(false);
      eventSourceRef.current = null;
      source.close();
    };
  }

  const progressPercent =
    typeof progress?.totalProducts === "number" && progress.totalProducts > 0
      ? Math.min(100, (progress.productsScanned / progress.totalProducts) * 100)
      : progress?.stage === "complete" && progress.totalProducts === 0
        ? 100
      : null;
  const previewParentProductsIncluded = result
    ? new Set(result.preview.map((record) => record.productAttributes.itemGroupId)).size
    : 0;
  const includedFeedRowsValue = result
    ? result.exhaustive
      ? result.stats.recordsPrepared
      : result.preview.length
    : 0;
  const parentProductsScannedValue = result
    ? result.exhaustive
      ? result.stats.productsFetched
      : previewParentProductsIncluded
    : 0;
  const totalVariantsScannedValue = result
    ? result.exhaustive
      ? result.stats.variantsConsidered
      : result.preview.length
    : 0;

  return (
    <article className="glass-panel rounded-[1.75rem] p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
            Feed preview
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
            Inspect normalized Shopify output
          </h2>
        </div>
        <p className="text-sm text-muted">{props.decisionReason}</p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_auto_auto]">
        <label className="grid gap-2">
          <span className="text-sm font-medium text-foreground">Preview mode</span>
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as "delta" | "full");
            }}
            className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
          >
            <option value="delta">Delta preview</option>
            <option value="full">Full preview</option>
          </select>
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium text-foreground">Preview rows</span>
          <input
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            type="number"
            min={1}
            max={25}
            className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
          />
        </label>

        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void runPreview("preview")}
            disabled={isLoading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-line bg-white/80 px-5 py-3 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading && runIntent === "preview" ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                Inspecting preview
              </>
            ) : (
              "Inspect Preview"
            )}
          </button>
        </div>

        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void runPreview("full")}
            disabled={isLoading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#1f1711] px-5 py-3 text-sm font-semibold text-[#f9f2e7] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading && runIntent === "full" ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#f9f2e7] border-t-transparent" />
                {mode === "full" ? "Preparing full catalog" : "Preparing full delta"}
              </>
            ) : (
              "Inspect Full"
            )}
          </button>
        </div>
      </div>

      <div className="mt-3">
        <div className="h-3 overflow-hidden rounded-full border border-line bg-white/60">
          <div
            className={`h-full bg-[linear-gradient(90deg,var(--accent),#efc58d)] transition-[width] duration-500 ${isLoading && progressPercent === null ? "animate-pulse" : ""}`}
            style={{ width: `${progressPercent ?? (isLoading ? 18 : 0)}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs font-mono uppercase tracking-[0.16em] text-muted">
          <span>
            {progress?.message ??
              (isLoading ? "Starting preview scan." : "Progress will appear here during the scan.")}
          </span>
          <span>
            {progress?.productsScanned
              ? `${progress.productsScanned.toLocaleString()} scanned`
              : "0 scanned"}
            {progress?.totalProducts
              ? ` / ${progress.totalProducts.toLocaleString()} total`
              : ""}
            {progressPercent !== null ? ` (${progressPercent.toFixed(1)}%)` : ""}
          </span>
        </div>
      </div>

      {error ? (
        <div className="mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-6 grid gap-5">
          {result.exportArtifactId ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white/65 p-4 md:flex-row md:items-center md:justify-between">
              <div className="text-sm leading-7 text-muted">
                This preview prepared the full <strong>{result.mode}</strong>{" "}
                export from the same scan. The table below only shows the
                requested sample rows.
              </div>
              <a
                href={`/api/dashboard/export/preview?id=${encodeURIComponent(result.exportArtifactId)}`}
                className="inline-flex items-center justify-center rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
              >
                Download {result.mode === "full" ? "Full" : "Delta"} XLSX
              </a>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Included Feed Rows
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {includedFeedRowsValue.toLocaleString()}
              </p>
              <p className="mt-2 text-sm text-muted">
                {result.exhaustive
                  ? "Rows that made it into the generated feed after exclusions."
                  : "Rows currently included in the preview sample."}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Pages scanned
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.pagesScanned}
              </p>
              <p className="mt-2 text-sm text-muted">
                {result.stats.scanCompleted ? "Complete" : "Stopped early"}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Parent Products Scanned
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {parentProductsScannedValue.toLocaleString()}
              </p>
              <p className="mt-2 text-sm text-muted">
                {result.exhaustive
                  ? "Parent Shopify products scanned across the paginated run."
                  : "Unique parent products represented in the preview sample."}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Total Variants Scanned
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {totalVariantsScannedValue.toLocaleString()}
              </p>
              <p className="mt-2 text-sm text-muted">
                {result.exhaustive
                  ? "Variant or SKU rows evaluated during the scan."
                  : "Variant rows represented in the current preview sample."}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Excluded
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.excluded}
              </p>
              <p className="mt-2 text-sm text-muted">
                Combined parent-product and variant-level exclusions.
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Query
              </p>
              <p className="mt-3 break-words text-sm leading-7 text-muted">
                {result.query}
              </p>
            </div>
          </div>

          {Object.keys(result.exclusions).length ? (
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Exclusion reasons
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {Object.entries(result.exclusions).map(([reason, count]) => (
                  <span
                    key={reason}
                    className="rounded-full border border-line bg-panel-strong px-3 py-2 text-xs font-mono uppercase tracking-[0.18em] text-accent-strong"
                  >
                    {reason}: {count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <FeedPreviewTable
            records={result.preview}
            emptyMessage={
              "No Merchant API payload rows matched this preview. That usually means the delta lookback window returned no changed products, or the current exclusion rules filtered everything out. Try a full preview next."
            }
          />

          {result.notes.length ? (
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Notes
              </p>
              <div className="mt-4 grid gap-2 text-sm leading-7 text-muted">
                {result.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
          Run a delta or full preview to see the exact Google Merchant API
          payload columns this app is preparing. The preview fetches live
          Shopify data but does not write anything to Google.
        </div>
      )}
    </article>
  );
}
