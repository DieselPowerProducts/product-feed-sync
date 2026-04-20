import { getRun, start } from "workflow/api";
import {
  clearActiveSyncRun,
  getActiveSyncRun,
  setActiveSyncRun,
  type SyncHistoryPurpose,
  type SyncSettings,
} from "@/lib/operator-store";
import { LIVE_SYNC_CHUNK_PRODUCT_TARGET } from "@/lib/sync";
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
    chunkTargetProducts: LIVE_SYNC_CHUNK_PRODUCT_TARGET,
    chunksCompleted: 0,
    message: params.message,
    totalProducts: null,
    productsScanned: 0,
    pagesScanned: 0,
    merchantPhase: null,
    merchantCompleted: 0,
    merchantTotal: null,
    lastChunkDurationMs: null,
    averageChunkDurationMs: null,
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
