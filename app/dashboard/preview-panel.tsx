"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type GooglePriceValue = {
  amountMicros: string;
  currencyCode: string;
};

type GoogleWeightValue = {
  value: number;
  unit: string;
};

type FeedPreviewRecord = {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  productAttributes: {
    title: string;
    description: string;
    link: string;
    imageLink: string;
    additionalImageLinks: string[];
    availability: "IN_STOCK" | "OUT_OF_STOCK";
    price: GooglePriceValue;
    salePrice: GooglePriceValue | null;
    condition: "NEW";
    googleProductCategory: string | null;
    productTypes: string[];
    brand: string | null;
    gtins: string[];
    mpn: string | null;
    identifierExists: boolean;
    itemGroupId: string;
    customLabel0: string | null;
    customLabel1: string | null;
    customLabel2: string | null;
    customLabel3: string | null;
    customLabel4: string | null;
    shippingWeight: GoogleWeightValue | null;
    shippingLabel: string;
    costOfGoodsSold: GooglePriceValue | null;
  };
};

type PreviewResult = {
  ok: boolean;
  exhaustive: boolean;
  query: string;
  stats: {
    pageSize: number;
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

type CellValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | GooglePriceValue
  | GoogleWeightValue
  | string[];

type ColumnDefinition = {
  id: string;
  label: string;
  defaultWidth: number;
  kind?: "imageLink" | "url";
  getValue: (record: FeedPreviewRecord) => CellValue;
};

const columns: ColumnDefinition[] = [
  { id: "offerId", label: "offerId", defaultWidth: 200, getValue: (record) => record.offerId },
  {
    id: "contentLanguage",
    label: "contentLanguage",
    defaultWidth: 150,
    getValue: (record) => record.contentLanguage,
  },
  { id: "feedLabel", label: "feedLabel", defaultWidth: 140, getValue: (record) => record.feedLabel },
  {
    id: "productAttributes.title",
    label: "productAttributes.title",
    defaultWidth: 240,
    getValue: (record) => record.productAttributes.title,
  },
  {
    id: "productAttributes.description",
    label: "productAttributes.description",
    defaultWidth: 360,
    getValue: (record) => record.productAttributes.description,
  },
  {
    id: "productAttributes.link",
    label: "productAttributes.link",
    defaultWidth: 300,
    kind: "url",
    getValue: (record) => record.productAttributes.link,
  },
  {
    id: "productAttributes.imageLink",
    label: "productAttributes.imageLink",
    defaultWidth: 220,
    kind: "imageLink",
    getValue: (record) => record.productAttributes.imageLink,
  },
  {
    id: "productAttributes.additionalImageLinks",
    label: "productAttributes.additionalImageLinks",
    defaultWidth: 280,
    getValue: (record) => record.productAttributes.additionalImageLinks,
  },
  {
    id: "productAttributes.availability",
    label: "productAttributes.availability",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.availability,
  },
  {
    id: "productAttributes.price",
    label: "productAttributes.price",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.price,
  },
  {
    id: "productAttributes.salePrice",
    label: "productAttributes.salePrice",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.salePrice,
  },
  {
    id: "productAttributes.condition",
    label: "productAttributes.condition",
    defaultWidth: 150,
    getValue: (record) => record.productAttributes.condition,
  },
  {
    id: "productAttributes.googleProductCategory",
    label: "productAttributes.googleProductCategory",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.googleProductCategory,
  },
  {
    id: "productAttributes.productTypes",
    label: "productAttributes.productTypes",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.productTypes,
  },
  {
    id: "productAttributes.brand",
    label: "productAttributes.brand",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.brand,
  },
  {
    id: "productAttributes.gtins",
    label: "productAttributes.gtins",
    defaultWidth: 200,
    getValue: (record) => record.productAttributes.gtins,
  },
  {
    id: "productAttributes.mpn",
    label: "productAttributes.mpn",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.mpn,
  },
  {
    id: "productAttributes.identifierExists",
    label: "productAttributes.identifierExists",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.identifierExists,
  },
  {
    id: "productAttributes.itemGroupId",
    label: "productAttributes.itemGroupId",
    defaultWidth: 180,
    getValue: (record) => record.productAttributes.itemGroupId,
  },
  {
    id: "productAttributes.customLabel0",
    label: "productAttributes.customLabel0",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel0,
  },
  {
    id: "productAttributes.customLabel1",
    label: "productAttributes.customLabel1",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel1,
  },
  {
    id: "productAttributes.customLabel2",
    label: "productAttributes.customLabel2",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel2,
  },
  {
    id: "productAttributes.customLabel3",
    label: "productAttributes.customLabel3",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel3,
  },
  {
    id: "productAttributes.customLabel4",
    label: "productAttributes.customLabel4",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel4,
  },
  {
    id: "productAttributes.shippingWeight",
    label: "productAttributes.shippingWeight",
    defaultWidth: 210,
    getValue: (record) => record.productAttributes.shippingWeight,
  },
  {
    id: "productAttributes.shippingLabel",
    label: "productAttributes.shippingLabel",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.shippingLabel,
  },
  {
    id: "productAttributes.costOfGoodsSold",
    label: "productAttributes.costOfGoodsSold",
    defaultWidth: 240,
    getValue: (record) => record.productAttributes.costOfGoodsSold,
  },
];

const MIN_COLUMN_WIDTH = 100;

const DEFAULT_COLUMN_WIDTHS = Object.fromEntries(
  columns.map((column) => [column.id, column.defaultWidth]),
) as Record<string, number>;

function stringifyCellValue(
  value: CellValue,
) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
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
    key: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [tableViewportHeight, setTableViewportHeight] = useState(400);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
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
    key: string,
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
        productsScanned: payload.exhaustive
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
  const tableWidth = columns.reduce(
    (sum, column) => sum + columnWidths[column.id],
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
                        key={column.id}
                        style={{
                          minWidth: `${MIN_COLUMN_WIDTH}px`,
                          width: `${columnWidths[column.id]}px`,
                        }}
                      />
                    ))}
                  </colgroup>
                  <thead className="border-b border-line bg-white/85 text-xs uppercase tracking-[0.18em] text-muted">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column.id}
                          className="relative border-r border-line/50 px-4 py-3 pr-6 whitespace-nowrap last:border-r-0"
                          style={{
                            minWidth: `${MIN_COLUMN_WIDTH}px`,
                            width: `${columnWidths[column.id]}px`,
                          }}
                        >
                          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                            {column.label}
                          </span>
                          <button
                            type="button"
                            aria-label={`Resize ${column.label} column`}
                            onPointerDown={(event) => startColumnResize(column.id, event)}
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
                        key={record.offerId}
                        className="border-b border-line/70 align-top last:border-b-0"
                      >
                        {columns.map((column) => {
                          const rawValue = column.getValue(record);
                          const value = stringifyCellValue(rawValue);

                          if (column.kind === "imageLink") {
                            return (
                              <td
                                key={column.id}
                                className="px-4 py-4"
                                style={{
                                  minWidth: `${MIN_COLUMN_WIDTH}px`,
                                  width: `${columnWidths[column.id]}px`,
                                }}
                              >
                                <div className="grid gap-3">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={value}
                                    alt={record.productAttributes.title}
                                    className="h-20 w-20 rounded-2xl border border-line object-cover"
                                  />
                                  <a
                                    href={value}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={value}
                                    className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-6 text-accent-strong"
                                  >
                                    {value}
                                  </a>
                                </div>
                              </td>
                            );
                          }

                          if (column.kind === "url") {
                            return (
                              <td
                                key={column.id}
                                className="px-4 py-4"
                                style={{
                                  minWidth: `${MIN_COLUMN_WIDTH}px`,
                                  width: `${columnWidths[column.id]}px`,
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
                              key={column.id}
                              className="px-4 py-4"
                              style={{
                                minWidth: `${MIN_COLUMN_WIDTH}px`,
                                width: `${columnWidths[column.id]}px`,
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
              No Merchant API payload rows matched this preview. That usually
              means the delta lookback window returned no changed products, or
              the current exclusion rules filtered everything out. Try a full
              preview next.
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
          Run a delta or full preview to see the exact Google Merchant API
          payload columns this app is preparing. The preview fetches live
          Shopify data but does not write anything to Google.
        </div>
      )}
    </article>
  );
}
