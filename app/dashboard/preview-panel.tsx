"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type FeedPreviewRecord = {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string | null;
  availability: "in_stock" | "out_of_stock";
  price: string;
  sale_price: string | null;
  google_product_category: number | string | null;
  product_type: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  identifier_exists: "yes" | "no";
  item_group_id: string;
  custom_label_0: string | null;
  custom_label_1: string | null;
  custom_label_2: string | null;
  custom_label_3: string | null;
  custom_label_4: string | null;
  shipping_weight: string | null;
  shipping_label: string;
  variant_id: string;
  product_id: string;
  cost_of_goods_sold: string | null;
};

type PreviewResult = {
  ok: boolean;
  exhaustive: boolean;
  query: string;
  stats: {
    productsFetched: number;
    pagesScanned: number;
    scanCompleted: boolean;
    totalProducts: number | null;
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

type ColumnKey = keyof FeedPreviewRecord;

const columns: Array<{
  key: ColumnKey;
  label: string;
}> = [
  { key: "id", label: "id" },
  { key: "title", label: "title" },
  { key: "description", label: "description" },
  { key: "link", label: "link" },
  { key: "image_link", label: "image_link" },
  { key: "additional_image_link", label: "additional_image_link" },
  { key: "availability", label: "availability" },
  { key: "price", label: "price" },
  { key: "sale_price", label: "sale_price" },
  { key: "google_product_category", label: "google_product_category" },
  { key: "product_type", label: "product_type" },
  { key: "brand", label: "brand" },
  { key: "gtin", label: "gtin" },
  { key: "mpn", label: "mpn" },
  { key: "identifier_exists", label: "identifier_exists" },
  { key: "item_group_id", label: "item_group_id" },
  { key: "custom_label_0", label: "custom_label_0" },
  { key: "custom_label_1", label: "custom_label_1" },
  { key: "custom_label_2", label: "custom_label_2" },
  { key: "custom_label_3", label: "custom_label_3" },
  { key: "custom_label_4", label: "custom_label_4" },
  { key: "shipping_weight", label: "shipping_weight" },
  { key: "shipping_label", label: "shipping_label" },
  { key: "variant_id", label: "variant_id" },
  { key: "product_id", label: "product_id" },
  { key: "cost_of_goods_sold", label: "cost_of_goods_sold" },
];

const MIN_COLUMN_WIDTH = 100;

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  id: 160,
  title: 240,
  description: 360,
  link: 300,
  image_link: 200,
  additional_image_link: 260,
  availability: 140,
  price: 120,
  sale_price: 120,
  google_product_category: 190,
  product_type: 180,
  brand: 160,
  gtin: 160,
  mpn: 160,
  identifier_exists: 150,
  item_group_id: 170,
  custom_label_0: 150,
  custom_label_1: 150,
  custom_label_2: 150,
  custom_label_3: 150,
  custom_label_4: 150,
  shipping_weight: 160,
  shipping_label: 160,
  variant_id: 170,
  product_id: 170,
  cost_of_goods_sold: 170,
};

function stringifyCellValue(
  record: FeedPreviewRecord,
  key: ColumnKey,
) {
  const value = record[key];
  return value === null ? "" : String(value);
}

function getCellClassName() {
  return "block w-full overflow-hidden text-ellipsis whitespace-nowrap leading-6 text-muted";
}

export function PreviewPanel(props: {
  defaultPreviewLimit: number;
  decisionReason: string;
}) {
  const [mode, setMode] = useState<"delta" | "full">("delta");
  const [limit, setLimit] = useState(String(props.defaultPreviewLimit));
  const [exhaustive, setExhaustive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [progress, setProgress] = useState<PreviewProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef(0);
  const tableViewportRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    key: ColumnKey;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [tableViewportHeight, setTableViewportHeight] = useState(400);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(
    () => ({ ...DEFAULT_COLUMN_WIDTHS }),
  );

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, [isResizing]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    function updateTableViewportHeight() {
      const viewport = tableViewportRef.current;

      if (!viewport) {
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const bottomPadding = window.innerWidth >= 1024 ? 32 : 20;
      const nextHeight = Math.max(
        400,
        Math.floor(window.innerHeight - rect.top - bottomPadding),
      );

      setTableViewportHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    }

    function requestUpdate() {
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateTableViewportHeight);
    }

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [result]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;

      if (!resizeState) {
        return;
      }

      const nextWidth = Math.max(
        MIN_COLUMN_WIDTH,
        resizeState.startWidth + (event.clientX - resizeState.startX),
      );

      setColumnWidths((current) => {
        if (current[resizeState.key] === nextWidth) {
          return current;
        }

        return {
          ...current,
          [resizeState.key]: nextWidth,
        };
      });
    }

    function handlePointerUp() {
      if (!resizeStateRef.current) {
        return;
      }

      resizeStateRef.current = null;
      setIsResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  function startColumnResize(
    key: ColumnKey,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();

    resizeStateRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
    };
    setIsResizing(true);
  }

  async function runPreview() {
    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;
    eventSourceRef.current?.close();
    setIsLoading(true);
    setError(null);
    setProgress(null);
    setResult(null);

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
      setResult(payload);
      setProgress({
        stage: "complete",
        exhaustive: payload.exhaustive,
        totalProducts: payload.stats.totalProducts,
        productsScanned: payload.stats.productsFetched,
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
  const tableWidth = columns.reduce(
    (sum, column) => sum + columnWidths[column.key],
    0,
  );

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

      <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
        <label className="grid gap-2">
          <span className="text-sm font-medium text-foreground">Preview mode</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "delta" | "full")}
            className="rounded-2xl border border-line bg-white/80 px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
          >
            <option value="delta">Delta preview</option>
            <option value="full">Full preview</option>
          </select>
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium text-foreground">Rows</span>
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
            onClick={() => void runPreview()}
            disabled={isLoading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#1f1711] px-5 py-3 text-sm font-semibold text-[#f9f2e7] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#f9f2e7] border-t-transparent" />
                {exhaustive ? "Scanning catalog" : "Loading preview"}
              </>
            ) : (
              "Run preview"
            )}
          </button>
        </div>
      </div>

      <label className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-white/65 px-4 py-4 text-sm">
        <input
          type="checkbox"
          checked={exhaustive}
          onChange={(event) => setExhaustive(event.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Exhaustive scan
        <span className="text-muted">
          Walk all matching catalog pages instead of stopping once enough
          preview rows have been found.
        </span>
      </label>

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

      <div className="mt-4 text-sm leading-7 text-muted">
        Delta preview only shows products updated inside the current lookback
        window. If it returns no rows, try <strong>Full preview</strong> or
        increase the lookback days in the settings panel.
      </div>

      {error ? (
        <div className="mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-6 grid gap-5">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Products fetched
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.productsFetched}
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
                Total matches
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.totalProducts?.toLocaleString() ?? "Unknown"}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Records prepared
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.recordsPrepared}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Excluded
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                {result.stats.excluded}
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

          {result.preview.length ? (
          <div className="overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
            <div
              ref={tableViewportRef}
              className="overflow-auto"
              style={{ height: `${tableViewportHeight}px` }}
            >
              <table
                className="table-fixed text-left text-sm"
                style={{ minWidth: `${tableWidth}px`, width: `${tableWidth}px` }}
              >
                  <colgroup>
                    {columns.map((column) => (
                      <col
                        key={column.key}
                        style={{
                          minWidth: `${MIN_COLUMN_WIDTH}px`,
                          width: `${columnWidths[column.key]}px`,
                        }}
                      />
                    ))}
                  </colgroup>
                  <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column.key}
                          className="relative border-r border-line/50 px-4 py-3 pr-6 whitespace-nowrap last:border-r-0"
                          style={{
                            minWidth: `${MIN_COLUMN_WIDTH}px`,
                            width: `${columnWidths[column.key]}px`,
                          }}
                        >
                          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                            {column.label}
                          </span>
                          <button
                            type="button"
                            aria-label={`Resize ${column.label} column`}
                            onPointerDown={(event) => startColumnResize(column.key, event)}
                            className="absolute top-0 right-0 h-full w-3 translate-x-1/2 cursor-col-resize touch-none"
                          >
                            <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-line" />
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.preview.map((record) => (
                      <tr
                        key={record.id}
                        className="border-b border-line/70 align-top last:border-b-0"
                      >
                        {columns.map((column) => {
                          const value = stringifyCellValue(record, column.key);

                          if (column.key === "image_link") {
                            return (
                              <td
                                key={column.key}
                                className="px-4 py-4"
                                style={{
                                  minWidth: `${MIN_COLUMN_WIDTH}px`,
                                  width: `${columnWidths[column.key]}px`,
                                }}
                              >
                                <div className="grid gap-3">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={record.image_link}
                                    alt={record.title}
                                    className="h-20 w-20 rounded-2xl border border-line object-cover"
                                  />
                                  <a
                                    href={record.image_link}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={record.image_link}
                                    className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-6 text-accent-strong"
                                  >
                                    {record.image_link}
                                  </a>
                                </div>
                              </td>
                            );
                          }

                          if (
                            column.key === "link" ||
                            column.key === "additional_image_link"
                          ) {
                            return (
                              <td
                                key={column.key}
                                className="px-4 py-4"
                                style={{
                                  minWidth: `${MIN_COLUMN_WIDTH}px`,
                                  width: `${columnWidths[column.key]}px`,
                                }}
                              >
                                {value ? (
                                  <a
                                    href={value}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={value}
                                    className="block w-full overflow-hidden text-ellipsis whitespace-nowrap leading-6 text-accent-strong"
                                  >
                                    {value}
                                  </a>
                                ) : (
                                  <span className="text-muted">-</span>
                                )}
                              </td>
                            );
                          }

                          return (
                            <td
                              key={column.key}
                              className="px-4 py-4"
                              style={{
                                minWidth: `${MIN_COLUMN_WIDTH}px`,
                                width: `${columnWidths[column.key]}px`,
                              }}
                            >
                              <div
                                className={getCellClassName()}
                                title={value}
                              >
                                {value || "-"}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
              No normalized rows matched this preview. That usually means the
              delta lookback window returned no changed products, or the current
              exclusion rules filtered everything out. Try a full preview next.
            </div>
          )}

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
          Run a delta or full preview to see the complete normalized Google feed
          columns. The preview fetches live Shopify data but does not write
          anything to Google.
        </div>
      )}
    </article>
  );
}
