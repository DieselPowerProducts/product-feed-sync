"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActiveSyncRunState } from "@/lib/operator-store";

const STREAM_RECONNECT_DELAY_MS = 1500;

type LiveSyncProgress = {
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
  merchantPagesScanned?: number;
  merchantRowsScanned?: number;
  merchantMatchedRows?: number;
  merchantDeleteTargets?: number;
  controlState?: ActiveSyncRunState["controlState"];
  chunksCompleted: number;
  chunkTargetProducts: number;
  elapsedMs: number;
  lastChunkDurationMs: number | null;
  averageChunkDurationMs: number | null;
  mode: "delta" | "full";
};

type LiveSyncResult = {
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

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

function approximateProgress(progress: LiveSyncProgress | null) {
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
    const pagePercent =
      (progress.merchantPagesScanned ?? 0) > 0
        ? Math.min(0.18, (progress.merchantPagesScanned ?? 0) * 0.015)
        : 0;

    return 70 + pagePercent * 100;
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

function stageTone(
  progress: LiveSyncProgress | null,
  stage: "counting" | "scanning" | "uploading" | "complete",
) {
  if (!progress) {
    return "border-line bg-white/65 text-muted";
  }

  const rank: Record<LiveSyncProgress["stage"], number> = {
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

function progressSummary(progress: LiveSyncProgress | null) {
  if (!progress) {
    return "Waiting for live sync progress.";
  }

  if (progress.controlState === "pause_requested") {
    return "Pause requested. The workflow will stop at the next safe checkpoint.";
  }

  if (progress.controlState === "paused") {
    return "Sync is paused. Resume it to continue from the next checkpoint.";
  }

  if (progress.stage === "uploading" && progress.merchantPhase === "reconciling") {
    const pages = progress.merchantPagesScanned ?? 0;
    const rows = progress.merchantRowsScanned ?? 0;
    const matched = progress.merchantMatchedRows ?? 0;
    const deletes = progress.merchantDeleteTargets ?? 0;

    return `Merchant pages ${pages.toLocaleString()}, rows ${rows.toLocaleString()}, matched ${matched.toLocaleString()}, delete targets ${deletes.toLocaleString()}`;
  }

  if (progress.stage === "uploading") {
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

  if (typeof progress.totalProducts === "number") {
    return `${progress.productsScanned.toLocaleString()} / ${progress.totalProducts.toLocaleString()} Shopify products scanned`;
  }

  return `${progress.productsScanned.toLocaleString()} Shopify products scanned`;
}

function toInitialProgress(run: ActiveSyncRunState): LiveSyncProgress {
  return {
    stage: run.merchantPhase
      ? "uploading"
      : run.chunksCompleted > 0 || run.productsScanned > 0 || run.pagesScanned > 0
        ? "scanning"
        : "counting",
    exhaustive: true,
    totalProducts: run.totalProducts,
    productsScanned: run.productsScanned,
    pagesScanned: run.pagesScanned,
    previewRows: 0,
    message: run.message,
    merchantPhase: run.merchantPhase ?? undefined,
    merchantCompleted: run.merchantCompleted,
    merchantTotal: run.merchantTotal,
    merchantErrors: 0,
    merchantPagesScanned: run.merchantPagesScanned,
    merchantRowsScanned: run.merchantRowsScanned,
    merchantMatchedRows: run.merchantMatchedRows,
    merchantDeleteTargets: run.merchantDeleteTargets,
    controlState: run.controlState,
    chunksCompleted: run.chunksCompleted,
    chunkTargetProducts: run.chunkTargetProducts,
    elapsedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
    lastChunkDurationMs: run.lastChunkDurationMs,
    averageChunkDurationMs: run.averageChunkDurationMs,
    mode: run.mode,
  };
}

export function ActiveSyncRunPanel(props: { initialRun: ActiveSyncRunState }) {
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastEventIndexRef = useRef<number>(-1);
  const [runId, setRunId] = useState(props.initialRun.runId);
  const [progress, setProgress] = useState<LiveSyncProgress>(
    toInitialProgress(props.initialRun),
  );
  const [error, setError] = useState<string | null>(null);
  const [isControlPending, setIsControlPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    setRunId(props.initialRun.runId);
    setProgress(toInitialProgress(props.initialRun));
  }, [props.initialRun]);

  useEffect(() => {
    connectToRun(props.initialRun.runId);

    return () => {
      eventSourceRef.current?.close();

      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [props.initialRun.runId]);

  function scheduleReconnect(nextRunId: string) {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectTimeoutRef.current = window.setTimeout(() => {
      connectToRun(nextRunId, true);
    }, STREAM_RECONNECT_DELAY_MS);
  }

  function connectToRun(nextRunId: string, reconnecting = false) {
    eventSourceRef.current?.close();

    const searchParams = new URLSearchParams({
      ts: String(Date.now()),
    });

    if (reconnecting && lastEventIndexRef.current >= 0) {
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
      }

      const payload = JSON.parse(messageEvent.data) as LiveSyncProgress;
      setProgress(payload);
      setError(null);
    });

    source.addEventListener("result", (event) => {
      const messageEvent = event as MessageEvent<string>;
      const payload = JSON.parse(messageEvent.data) as LiveSyncResult;

      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setResultMessage(payload.message);
      setError(payload.ok ? null : payload.message);
      router.refresh();
    });

    source.onerror = () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setError("The live sync status stream disconnected. Reconnecting now.");
      scheduleReconnect(nextRunId);
    };
  }

  async function sendControl(action: "pause" | "resume") {
    setIsControlPending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/dashboard/sync-runs/${encodeURIComponent(runId)}/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        },
      );
      const payload = (await response.json()) as {
        ok: boolean;
        activeRun?: ActiveSyncRunState;
        message?: string;
      };

      if (!response.ok || !payload.ok || !payload.activeRun) {
        throw new Error(payload.message ?? "Failed to update live sync control.");
      }

      const nextActiveRun = payload.activeRun;

      setProgress((current) => ({
        ...(current ?? toInitialProgress(nextActiveRun)),
        message: nextActiveRun.message,
        controlState: nextActiveRun.controlState,
      }));
      router.refresh();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to update live sync control.",
      );
    } finally {
      setIsControlPending(false);
    }
  }

  const progressPercent = approximateProgress(progress);
  const controlState = progress.controlState ?? props.initialRun.controlState;
  const phaseLabel = useMemo(() => {
    if (progress.merchantPhase === "reconciling") {
      return "Reconciling";
    }

    if (progress.merchantPhase === "deletes") {
      return "Deleting";
    }

    if (progress.merchantPhase === "upserts") {
      return "Uploading";
    }

    return progress.stage === "scanning" ? "Scanning" : "Counting";
  }, [progress.merchantPhase, progress.stage]);
  const runKind =
    props.initialRun.purpose === "test-save" ? "test save" : "sync";
  const allowControl = props.initialRun.purpose === "sync";

  return (
    <article className="glass-panel rounded-[1.75rem] p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent-strong">
            Active {runKind}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground">
            {progress.mode === "full" ? "Full" : "Delta"} {props.initialRun.trigger}{" "}
            {runKind}
          </h2>
          <p className="mt-3 text-sm leading-7 text-muted">
            Started {formatTimestamp(props.initialRun.startedAt)}. Stage: {phaseLabel}.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="inline-flex rounded-full border border-line bg-white/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
            {controlState === "pause_requested"
              ? "Pause requested"
              : controlState === "paused"
                ? "Paused"
                : "Running"}
          </span>
          {!allowControl ? (
            <span className="inline-flex rounded-full border border-line bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Pause unavailable
            </span>
          ) : controlState === "running" ? (
            <button
              type="button"
              onClick={() => sendControl("pause")}
              disabled={isControlPending}
              className="inline-flex rounded-full bg-[#1f1711] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#f9f2e7] disabled:cursor-not-allowed disabled:opacity-70"
            >
              Pause run
            </button>
          ) : (
            <button
              type="button"
              onClick={() => sendControl("resume")}
              disabled={isControlPending}
              className="inline-flex rounded-full bg-accent px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              Resume run
            </button>
          )}
        </div>
      </div>

      <div className="mt-5 space-y-3 rounded-[1.25rem] border border-line bg-white/55 p-4">
        <div className="flex flex-wrap gap-2 text-[11px] font-mono uppercase tracking-[0.18em]">
          <span className={`rounded-full border px-3 py-2 ${stageTone(progress, "counting")}`}>
            Counting
          </span>
          <span className={`rounded-full border px-3 py-2 ${stageTone(progress, "scanning")}`}>
            Scan Shopify
          </span>
          <span className={`rounded-full border px-3 py-2 ${stageTone(progress, "uploading")}`}>
            Write to GMC
          </span>
          <span className={`rounded-full border px-3 py-2 ${stageTone(progress, "complete")}`}>
            Complete
          </span>
        </div>

        <div className="h-3 overflow-hidden rounded-full border border-line bg-white/70">
          <div
            className="h-full bg-[linear-gradient(90deg,var(--accent),#efc58d)] transition-[width] duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono uppercase tracking-[0.16em] text-muted">
          <span>{progress.message}</span>
          <span>{progressSummary(progress)}</span>
        </div>

        <div className="grid gap-2 rounded-[1rem] border border-line/70 bg-white/70 px-4 py-3 text-xs text-muted md:grid-cols-4">
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Elapsed</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress.elapsedMs)}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Chunks done</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {progress.chunksCompleted.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Last chunk</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress.lastChunkDurationMs)}
            </p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.18em]">Avg chunk</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDuration(progress.averageChunkDurationMs)}
            </p>
          </div>
        </div>

        {progress.merchantPhase === "reconciling" ? (
          <div className="grid gap-2 rounded-[1rem] border border-line/70 bg-white/70 px-4 py-3 text-xs text-muted md:grid-cols-4">
            <div>
              <p className="font-mono uppercase tracking-[0.18em]">Merchant pages</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {(progress.merchantPagesScanned ?? 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="font-mono uppercase tracking-[0.18em]">Rows scanned</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {(progress.merchantRowsScanned ?? 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="font-mono uppercase tracking-[0.18em]">Source rows</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {(progress.merchantMatchedRows ?? 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="font-mono uppercase tracking-[0.18em]">Delete targets</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {(progress.merchantDeleteTargets ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <p className="mt-4 text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
        Active run: {runId}
      </p>

      {resultMessage ? (
        <div className="mt-4 rounded-[1.25rem] border border-[rgba(29,111,85,0.18)] bg-[rgba(29,111,85,0.08)] px-4 py-4 text-sm leading-7 text-success">
          {resultMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-[1.25rem] border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-4 text-sm leading-7 text-[#7d3d10]">
          {error}
        </div>
      ) : null}
    </article>
  );
}
