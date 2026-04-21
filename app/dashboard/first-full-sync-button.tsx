"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const ACTIVE_RUN_STORAGE_KEY = "dpp:first-full-sync-run-id";
const ACTIVE_RUN_EVENT_INDEX_STORAGE_KEY = "dpp:first-full-sync-event-index";
const STREAM_RECONNECT_DELAY_MS = 1500;

type FullSyncProgress = {
  stage: "counting" | "scanning" | "uploading" | "complete";
  exhaustive: true;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  previewRows: number;
  message: string;
  merchantPhase?: "reconciling" | "upserts" | "deletes";
  merchantCompleted?: number;
  merchantTotal?: number | null;
  merchantErrors?: number;
  chunksCompleted: number;
  chunkTargetProducts: number;
  elapsedMs: number;
  lastChunkDurationMs: number | null;
  averageChunkDurationMs: number | null;
  mode: "delta" | "full";
};

type FullSyncResult = {
  ok: boolean;
  finishedAt: string;
  message: string;
};

function formatDuration(ms: number | null | undefined) {
  if (!ms || !Number.isFinite(ms) || ms < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getApproximateProgressPercent(progress: FullSyncProgress | null) {
  if (!progress) {
    return 0;
  }

  if (progress.stage === "complete") {
    return 100;
  }

  if (progress.stage === "counting") {
    return 6;
  }

  if (progress.stage === "scanning") {
    const scanPercent =
      typeof progress.totalProducts === "number" && progress.totalProducts > 0
        ? Math.min(1, progress.productsScanned / progress.totalProducts)
        : Math.min(0.72, progress.chunksCompleted * 0.08);

    return 6 + scanPercent * 59;
  }

  if (progress.merchantPhase === "reconciling") {
    return 70;
  }

  const merchantPercent =
    typeof progress.merchantTotal === "number" && progress.merchantTotal > 0
      ? Math.min(1, (progress.merchantCompleted ?? 0) / progress.merchantTotal)
      : progress.merchantTotal === 0
        ? 1
        : 0.12;

  if (progress.merchantPhase === "deletes") {
    return 90 + merchantPercent * 10;
  }

  return 68 + merchantPercent * 22;
}

function getProgressSummary(progress: FullSyncProgress | null) {
  if (!progress) {
    return "Progress will appear here after the live sync starts.";
  }

  if (progress.stage === "uploading") {
    if (progress.merchantPhase === "reconciling") {
      return "Reconciling existing Merchant Center rows before the final delete pass.";
    }

    const completed = progress.merchantCompleted ?? 0;
    const total = progress.merchantTotal ?? 0;
    const scope =
      progress.merchantPhase === "deletes" ? "delete calls" : "upserts";
    const errorSummary =
      (progress.merchantErrors ?? 0) > 0
        ? `, ${progress.merchantErrors?.toLocaleString()} errors`
        : "";

    return `${completed.toLocaleString()} / ${total.toLocaleString()} ${scope}${errorSummary}`;
  }

  const scanned = progress.productsScanned.toLocaleString();

  if (typeof progress.totalProducts === "number") {
    return `${scanned} / ${progress.totalProducts.toLocaleString()} Shopify products scanned`;
  }

  return `${scanned} Shopify products scanned`;
}

function getStageTone(
  progress: FullSyncProgress | null,
  stage: "counting" | "scanning" | "uploading" | "complete",
) {
  if (!progress) {
    return "border-line bg-white/65 text-muted";
  }

  const rank: Record<FullSyncProgress["stage"], number> = {
    counting: 0,
    scanning: 1,
    uploading: 2,
    complete: 3,
  };

  if (rank[progress.stage] > rank[stage]) {
    return "border-[rgba(29,111,85,0.18)] bg-[rgba(29,111,85,0.08)] text-success";
  }

  if (progress.stage === stage) {
    return "border-[rgba(197,92,22,0.18)] bg-[rgba(197,92,22,0.08)] text-accent-strong";
  }

  return "border-line bg-white/65 text-muted";
}

export function FirstFullSyncButton(props?: {
  disabled?: boolean;
  disabledDetail?: string | null;
}) {
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const settledRunIdRef = useRef<string | null>(null);
  const lastEventIndexRef = useRef<number>(-1);
  const [runId, setRunId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FullSyncProgress | null>(null);
  const permanentlyDisabled = props?.disabled ?? false;

  useEffect(() => {
    if (permanentlyDisabled) {
      rememberRun(null);
      rememberLastEventIndex(null);
      lastEventIndexRef.current = -1;
      return;
    }

    const existingRunId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
        : null;
    const existingEventIndex =
      typeof window !== "undefined"
        ? window.localStorage.getItem(ACTIVE_RUN_EVENT_INDEX_STORAGE_KEY)
        : null;
    const parsedEventIndex = existingEventIndex
      ? Number.parseInt(existingEventIndex, 10)
      : Number.NaN;

    if (Number.isFinite(parsedEventIndex) && parsedEventIndex >= 0) {
      lastEventIndexRef.current = parsedEventIndex;
    }

    if (existingRunId) {
      setRunId(existingRunId);
      setIsLoading(true);
      connectToRun(existingRunId, { reconnecting: true });
    }

    return () => {
      eventSourceRef.current?.close();

      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [permanentlyDisabled]);

  function rememberRun(nextRunId: string | null) {
    if (typeof window === "undefined") {
      return;
    }

    if (nextRunId) {
      window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, nextRunId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  }

  function rememberLastEventIndex(nextEventIndex: number | null) {
    if (typeof window === "undefined") {
      return;
    }

    if (typeof nextEventIndex === "number" && nextEventIndex >= 0) {
      window.localStorage.setItem(
        ACTIVE_RUN_EVENT_INDEX_STORAGE_KEY,
        String(nextEventIndex),
      );
      return;
    }

    window.localStorage.removeItem(ACTIVE_RUN_EVENT_INDEX_STORAGE_KEY);
  }

  function scheduleReconnect(nextRunId: string) {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectTimeoutRef.current = window.setTimeout(() => {
      connectToRun(nextRunId, { reconnecting: true });
    }, STREAM_RECONNECT_DELAY_MS);
  }

  function connectToRun(
    nextRunId: string,
    options?: {
      reconnecting?: boolean;
    },
  ) {
    eventSourceRef.current?.close();
    setRunId(nextRunId);
    setIsLoading(true);

    if (!options?.reconnecting) {
      setError(null);
    }

    const searchParams = new URLSearchParams({
      ts: String(Date.now()),
    });

    if (options?.reconnecting && lastEventIndexRef.current >= 0) {
      searchParams.set("startIndex", String(lastEventIndexRef.current + 1));
    }

    const source = new EventSource(
      `/api/dashboard/sync-runs/${encodeURIComponent(nextRunId)}/stream?${searchParams.toString()}`,
    );
    eventSourceRef.current = source;

    source.addEventListener("progress", (event) => {
      const messageEvent = event as MessageEvent<string>;
      const eventIndex = Number.parseInt(messageEvent.lastEventId, 10);

      if (Number.isFinite(eventIndex) && eventIndex >= 0) {
        lastEventIndexRef.current = eventIndex;
        rememberLastEventIndex(eventIndex);
      }

      const payload = JSON.parse(messageEvent.data) as FullSyncProgress;
      settledRunIdRef.current = null;
      setProgress(payload);
      setError(null);
      setIsLoading(payload.stage !== "complete");
    });

    source.addEventListener("result", (event) => {
      const messageEvent = event as MessageEvent<string>;
      const eventIndex = Number.parseInt(messageEvent.lastEventId, 10);

      if (Number.isFinite(eventIndex) && eventIndex >= 0) {
        lastEventIndexRef.current = eventIndex;
      }

      const payload = JSON.parse(messageEvent.data) as FullSyncResult;

      settledRunIdRef.current = nextRunId;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      rememberRun(null);
      rememberLastEventIndex(null);
      lastEventIndexRef.current = -1;
      setRunId(null);
      setIsLoading(false);
      setError(payload.ok ? null : payload.message);
      router.replace(
        payload.ok
          ? "/dashboard?saved=first-full-success"
          : "/dashboard?saved=first-full-failed",
      );
    });

    source.onerror = () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;

      if (settledRunIdRef.current === nextRunId) {
        return;
      }

      setError(
        "The status stream disconnected. Reconnecting to the chunked sync run now.",
      );
      scheduleReconnect(nextRunId);
    };
  }

  async function startFirstFullSync() {
    if (permanentlyDisabled) {
      return;
    }

    setError(null);
    lastEventIndexRef.current = -1;
    rememberLastEventIndex(null);
    setProgress({
      stage: "counting",
      exhaustive: true,
      totalProducts: null,
      productsScanned: 0,
      pagesScanned: 0,
      previewRows: 0,
      message: "Queueing the first live full sync workflow.",
      chunksCompleted: 0,
      chunkTargetProducts: 1500,
      elapsedMs: 0,
      lastChunkDurationMs: null,
      averageChunkDurationMs: null,
      mode: "full",
    });
    setIsLoading(true);

    try {
      const response = await fetch("/api/dashboard/first-full-sync", {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok: boolean;
        runId?: string;
        message?: string;
      };

      if (!response.ok || !payload.ok || !payload.runId) {
        throw new Error(
          payload.message ?? "Failed to queue the first live full sync.",
        );
      }

      rememberRun(payload.runId);
      connectToRun(payload.runId);
    } catch (caughtError) {
      setIsLoading(false);
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to queue the first live full sync.",
      );
    }
  }

  const progressPercent = getApproximateProgressPercent(progress);

  if (permanentlyDisabled) {
    return (
      <div className="mt-4 space-y-4">
        <button
          type="button"
          disabled
          className="inline-flex items-center justify-center gap-2 rounded-full border border-line bg-white/80 px-5 py-3 text-sm font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-100"
        >
          Initial full sync completed
        </button>

        <div className="rounded-[1.25rem] border border-[rgba(29,111,85,0.18)] bg-[rgba(29,111,85,0.08)] px-4 py-4 text-sm leading-7 text-success">
          The one-time bootstrap full sync is locked to prevent accidental reruns.
          {props?.disabledDetail ? ` ${props.disabledDetail}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <button
        type="button"
        onClick={startFirstFullSync}
        disabled={isLoading}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1f1711] px-5 py-3 text-sm font-semibold text-[#f9f2e7] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
      >
        {isLoading ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#f9f2e7] border-t-transparent" />
            Running first full sync...
          </>
        ) : (
          "Run first full sync now"
        )}
      </button>

      <p className="text-xs leading-6 text-muted">
        The sync now runs as a resumable chunked workflow. If the status stream
        drops, this panel reconnects to the same run automatically.
      </p>

      <div className="space-y-3 rounded-[1.25rem] border border-line bg-white/55 p-4">
        <div className="flex flex-wrap gap-2 text-[11px] font-mono uppercase tracking-[0.18em]">
          <span className={`rounded-full border px-3 py-2 ${getStageTone(progress, "counting")}`}>
            Counting
          </span>
          <span className={`rounded-full border px-3 py-2 ${getStageTone(progress, "scanning")}`}>
            Scan Shopify
          </span>
          <span className={`rounded-full border px-3 py-2 ${getStageTone(progress, "uploading")}`}>
            Write to GMC
          </span>
          <span className={`rounded-full border px-3 py-2 ${getStageTone(progress, "complete")}`}>
            Complete
          </span>
        </div>

        <div className="h-3 overflow-hidden rounded-full border border-line bg-white/70">
          <div
            className={`h-full bg-[linear-gradient(90deg,var(--accent),#efc58d)] transition-[width] duration-500 ${isLoading && progressPercent === 0 ? "animate-pulse" : ""}`}
            style={{ width: `${isLoading || progress ? progressPercent : 0}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono uppercase tracking-[0.16em] text-muted">
          <span>
            {progress?.message ??
              "Progress will appear here after the live sync starts."}
          </span>
          <span>{getProgressSummary(progress)}</span>
        </div>

        <div className="grid gap-2 rounded-[1rem] border border-line/70 bg-white/70 px-4 py-3 text-xs text-muted md:grid-cols-4">
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Elapsed</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress?.elapsedMs)}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Chunks done</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {progress?.chunksCompleted?.toLocaleString() ?? "0"}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Last chunk</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress?.lastChunkDurationMs)}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Avg chunk</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress?.averageChunkDurationMs)}
            </p>
          </div>
        </div>
      </div>

      {runId ? (
        <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
          Active run: {runId}
        </p>
      ) : null}

      {error ? (
        <div className="rounded-[1.25rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
