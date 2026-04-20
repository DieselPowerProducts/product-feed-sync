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

export async function resolveActiveLiveSyncRun() {
  const activeRun = await getActiveSyncRun();

  if (!activeRun) {
    return null;
  }

  try {
    const run = await getRun(activeRun.runId);
    const status = await run.status;

    if (status === "running") {
      return activeRun;
    }
  } catch {
    // Treat lookup failures as stale state and clear the local lock.
  }

  await clearActiveSyncRun(activeRun.runId);
  return null;
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

  await setActiveSyncRun({
    runId: run.runId,
    startedAt,
    finishedAt: null,
    trigger: input.trigger,
    purpose: input.purpose ?? "sync",
    mode: input.mode,
    status: "queued",
    chunkTargetProducts: LIVE_SYNC_CHUNK_PRODUCT_TARGET,
    chunksCompleted: 0,
    message:
      input.mode === "full"
        ? "Queued chunked full sync."
        : "Queued chunked delta sync.",
    totalProducts: null,
    productsScanned: 0,
    pagesScanned: 0,
    merchantPhase: null,
    merchantCompleted: 0,
    merchantTotal: null,
    lastChunkDurationMs: null,
    averageChunkDurationMs: null,
  });

  return {
    ok: true as const,
    runId: run.runId,
    startedAt,
  };
}
