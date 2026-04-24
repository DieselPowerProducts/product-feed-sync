import { getRun, start } from "workflow/api";
import {
  clearActiveSyncRun,
  getActiveSyncRun,
  getLiveSyncRestartCheckpoint,
  readLiveSyncRestartCheckpointPayload,
  setActiveSyncRun,
  updateCronInvocationByRunId,
  type SyncHistoryPurpose,
  type SyncSettings,
} from "@/lib/operator-store";
import { LIVE_SYNC_CHUNK_PRODUCT_TARGET } from "@/lib/sync";
import type { LiveSyncRestartCheckpointPayload } from "@/workflows/live-merchant-sync";
import { liveMerchantSyncWorkflow } from "@/workflows/live-merchant-sync";
import { testSaveExportWorkflow } from "@/workflows/test-save-export";

export async function resolveActiveLiveSyncRun() {
  const activeRun = await getActiveSyncRun();

  if (!activeRun) {
    return null;
  }

  try {
    const run = await getRun(activeRun.runId);
    const status = await run.status;

    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      return activeRun;
    }

    if (activeRun.trigger === "cron") {
      await updateCronInvocationByRunId(activeRun.runId, {
        outcome:
          status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
        message:
          status === "completed"
            ? `Scheduled ${activeRun.mode} live sync finished.`
            : status === "cancelled"
              ? `Scheduled ${activeRun.mode} live sync was cancelled before completion.`
              : `Scheduled ${activeRun.mode} live sync failed before completion.`,
      });
    }
  } catch {
    // Treat lookup failures as stale state and clear the local lock.
  }

  await clearActiveSyncRun(activeRun.runId);
  return null;
}

async function setQueuedActiveRun(params: {
  runId: string;
  startedAt: string;
  trigger: "cron" | "manual";
  purpose: SyncHistoryPurpose;
  mode: "delta" | "full";
  message: string;
}) {
  await setActiveSyncRun({
    runId: params.runId,
    startedAt: params.startedAt,
    finishedAt: null,
    trigger: params.trigger,
    purpose: params.purpose,
    mode: params.mode,
    status: "queued",
    controlState: "running",
    chunkTargetProducts: LIVE_SYNC_CHUNK_PRODUCT_TARGET,
    chunksCompleted: 0,
    message: params.message,
    totalProducts: null,
    productsScanned: 0,
    pagesScanned: 0,
    merchantPhase: null,
    merchantCompleted: 0,
    merchantTotal: null,
    merchantPagesScanned: 0,
    merchantRowsScanned: 0,
    merchantMatchedRows: 0,
    merchantDeleteTargets: 0,
    lastChunkDurationMs: null,
    averageChunkDurationMs: null,
    budget: null,
  });
}

export async function startLiveSyncJob(input: {
  mode: "delta" | "full";
  trigger: "cron" | "manual";
  purpose?: SyncHistoryPurpose;
  settings: SyncSettings;
  allowDeltaFallback?: boolean;
}) {
  const activeRun = await resolveActiveLiveSyncRun();

  if (activeRun) {
    return {
      ok: false as const,
      activeRun,
    };
  }

  const startedAt = new Date().toISOString();
  const run = await start(liveMerchantSyncWorkflow, [
    {
      ...input,
      purpose: input.purpose ?? "sync",
      settings: input.settings,
      chunkTargetProducts: LIVE_SYNC_CHUNK_PRODUCT_TARGET,
      startedAt,
    },
  ]);

  await setQueuedActiveRun({
    runId: run.runId,
    startedAt,
    trigger: input.trigger,
    purpose: input.purpose ?? "sync",
    mode: input.mode,
    message:
      input.mode === "full"
        ? "Queued chunked full sync."
        : "Queued chunked delta sync.",
  });

  return {
    ok: true as const,
    runId: run.runId,
    startedAt,
  };
}

export async function restartLiveSyncFromCheckpointJob() {
  const activeRun = await resolveActiveLiveSyncRun();

  if (activeRun) {
    return {
      ok: false as const,
      activeRun,
    };
  }

  const checkpoint = await getLiveSyncRestartCheckpoint();

  if (!checkpoint) {
    return {
      ok: false as const,
      message: "No saved checkpoint is available to restart.",
    };
  }

  const payload =
    await readLiveSyncRestartCheckpointPayload<LiveSyncRestartCheckpointPayload>();

  if (!payload) {
    return {
      ok: false as const,
      message:
        "The saved checkpoint payload could not be loaded. Refresh the dashboard and try again.",
    };
  }

  const startedAt = new Date().toISOString();
  const run = await start(liveMerchantSyncWorkflow, [
    {
      mode: checkpoint.mode,
      trigger: checkpoint.trigger,
      purpose: checkpoint.purpose,
      settings: payload.input.settings,
      chunkTargetProducts: payload.input.chunkTargetProducts,
      startedAt,
      windowFrozenAt: payload.input.windowFrozenAt,
      allowDeltaFallback: payload.input.allowDeltaFallback,
      restartCheckpointId: checkpoint.id,
    },
  ]);

  await setQueuedActiveRun({
    runId: run.runId,
    startedAt,
    trigger: checkpoint.trigger,
    purpose: checkpoint.purpose,
    mode: checkpoint.mode,
    message:
      checkpoint.mode === "full"
        ? "Restarting full sync from saved checkpoint."
        : "Restarting delta sync from saved checkpoint.",
  });

  return {
    ok: true as const,
    runId: run.runId,
    startedAt,
  };
}

export async function startTestSaveExportJob(input: {
  mode: "delta" | "full";
  settings: SyncSettings;
}) {
  const activeRun = await resolveActiveLiveSyncRun();

  if (activeRun) {
    return {
      ok: false as const,
      activeRun,
    };
  }

  const startedAt = new Date().toISOString();
  const run = await start(testSaveExportWorkflow, [
    {
      mode: input.mode,
      trigger: "manual",
      purpose: "test-save",
      settings: input.settings,
      chunkTargetProducts: LIVE_SYNC_CHUNK_PRODUCT_TARGET,
      startedAt,
    },
  ]);

  await setQueuedActiveRun({
    runId: run.runId,
    startedAt,
    trigger: "manual",
    purpose: "test-save",
    mode: input.mode,
    message:
      input.mode === "full"
        ? "Queued chunked full test-save export."
        : "Queued chunked delta test-save export.",
  });

  return {
    ok: true as const,
    runId: run.runId,
    startedAt,
  };
}
