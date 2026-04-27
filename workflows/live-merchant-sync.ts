import { getWorkflowMetadata, getWritable, sleep } from "workflow";
import type {
  MerchantCatalogSyncSummary,
  MerchantDeleteTarget,
  MerchantSyncError,
} from "@/lib/google-merchant";
import type {
  ActiveSyncRunState,
  LiveSyncRestartCheckpointState,
  PendingShopifyDeleteRecord,
  SyncHistoryPurpose,
  SyncSettings,
} from "@/lib/operator-store";
import type {
  DeletePreviewSample,
  ExcludedPreviewSample,
  FeedPreviewRecord,
  SyncExportResult,
  SyncExecutionContext,
  SyncRunArtifact,
  SyncRunResult,
} from "@/lib/sync";
import { buildFeedRecordFingerprint } from "@/lib/feed-fingerprint";
import { getConfigurationStatus } from "@/lib/env";
import {
  buildSyncBudgetProfile,
  evaluateSyncBudget,
  type SyncBudgetHistorySample,
  type SyncBudgetSnapshot,
  type SyncBudgetUsage,
} from "@/lib/sync-budget";

const DEFAULT_PREVIEW_LIMIT = 5;
const LIVE_SYNC_CHUNK_PRODUCT_TARGET = 1500;
const INCLUDED_SAMPLE_LIMIT = 50;
const EXCLUDED_SAMPLE_LIMIT = 250;
const MERCHANT_ERROR_SAMPLE_LIMIT = 50;
const LARGE_DELTA_PRODUCT_LIMIT_WITHOUT_FINGERPRINTS = 2500;
const MERCHANT_RESULT_BUFFER_BYTES = 2048;

export interface LiveMerchantSyncWorkflowInput {
  mode: "delta" | "full";
  trigger: "cron" | "manual";
  purpose?: SyncHistoryPurpose;
  settings: SyncSettings;
  chunkTargetProducts?: number;
  startedAt?: string;
  windowFrozenAt?: string;
  allowDeltaFallback?: boolean;
  restartCheckpointId?: string | null;
}

export interface LiveMerchantSyncWorkflowProgress {
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
  budget: SyncBudgetSnapshot | null;
}

export type LiveMerchantSyncWorkflowEvent =
  | {
      type: "progress";
      progress: LiveMerchantSyncWorkflowProgress;
    }
  | {
      type: "result";
      result: {
        ok: boolean;
        finishedAt: string;
        message: string;
      };
    };

type MerchantIdentity = {
  accountName: string;
  dataSourceName: string;
  authMode: NonNullable<MerchantCatalogSyncSummary["authMode"]>;
};

type RestartCheckpointStage =
  | "scanning"
  | "reconciling"
  | "deletes"
  | "pending_deletes";

export interface LiveSyncRestartCheckpointPayload {
  version: 1;
  input: {
    mode: "delta" | "full";
    trigger: "cron" | "manual";
    purpose: SyncHistoryPurpose;
    settings: SyncSettings;
    chunkTargetProducts: number;
    windowFrozenAt: string;
    allowDeltaFallback?: boolean;
  };
  exportArtifactId: string;
  cursor: string | null;
  scanCompleted: boolean;
  pagesScanned: number;
  productsFetched: number;
  variantsConsidered: number;
  recordsPrepared: number;
  exclusions: Record<string, number>;
  includedSample: FeedPreviewRecord[];
  validationSample: ExcludedPreviewSample[];
  excludedSample: ExcludedPreviewSample[];
  deleteSample: DeletePreviewSample[];
  seenKeys: string[];
  seenFingerprints: Record<string, string>;
  unchangedRecordsSkipped: number;
  chunksCompleted: number;
  lastChunkDurationMs: number | null;
  averageChunkDurationMs: number | null;
  merchant: MerchantCatalogSyncSummary;
  budgetUsage: SyncBudgetUsage;
  reconciliation: {
    stage: RestartCheckpointStage;
    pageToken: string | null;
    merchantPagesScanned: number;
    merchantRowsScanned: number;
    merchantMatchedRows: number;
    merchantDeleteTargets: number;
    deleteTargets: MerchantDeleteTarget[];
    deleteIndex: number;
  };
}

function estimateJsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function createBudgetUsage(input: LiveMerchantSyncWorkflowInput): SyncBudgetUsage {
  return {
    mode: input.mode,
    elapsedMs: 0,
    totalProducts: null,
    productsScanned: 0,
    chunksCompleted: 0,
    chunkTargetProducts: Math.max(1, input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET),
    estimatedTransferBytes: 0,
    neonOpsUsed: 0,
    vercelFunctionsUsed: 0,
  };
}

function buildDeleteTargetKey(
  target: Pick<MerchantDeleteTarget, "contentLanguage" | "feedLabel" | "offerId">,
) {
  return `${target.contentLanguage}~${target.feedLabel}~${target.offerId}`;
}

function toPendingDeleteTarget(record: PendingShopifyDeleteRecord): MerchantDeleteTarget {
  return {
    offerId: record.offerId,
    contentLanguage: record.contentLanguage,
    feedLabel: record.feedLabel,
    reason: record.reason,
    productId: record.productId,
    variantId: record.variantId,
    title: record.title,
    variantTitle: record.variantTitle,
  };
}

function toPendingDeletePreviewSample(
  record: PendingShopifyDeleteRecord,
): DeletePreviewSample {
  return {
    reason: record.reason,
    productId: record.productId,
    variantId: record.variantId,
    offerId: record.offerId,
    handle: record.handle,
    title: record.title,
    variantTitle: record.variantTitle,
    sku: record.sku,
    link: record.link ?? null,
    source: "shopify_webhook",
  };
}

function toDeletePreviewSample(
  target: MerchantDeleteTarget,
  source: DeletePreviewSample["source"],
): DeletePreviewSample {
  return {
    reason: target.reason ?? "merchant_delete",
    productId: target.productId ?? "",
    variantId: target.variantId ?? null,
    offerId: target.offerId,
    handle: "",
    title: target.title ?? target.offerId,
    variantTitle: target.variantTitle ?? null,
    sku: null,
    link: null,
    source,
  };
}

function mergeExclusions(
  target: Record<string, number>,
  source: Record<string, number>,
) {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function pushLimitedMany<T>(items: T[], values: T[], limit: number) {
  for (const value of values) {
    if (items.length >= limit) {
      return;
    }

    items.push(value);
  }
}

function pushLimitedUniqueDeletePreviewSamples(
  items: DeletePreviewSample[],
  seenKeys: Record<string, true>,
  values: DeletePreviewSample[],
) {
  for (const value of values) {
    if (items.length >= EXCLUDED_SAMPLE_LIMIT) {
      return;
    }

    if (!value.offerId) {
      continue;
    }

    const key = buildDeleteTargetKey({
      contentLanguage: "en",
      feedLabel: "US",
      offerId: value.offerId,
    });

    if (seenKeys[key]) {
      continue;
    }

    seenKeys[key] = true;
    items.push(value);
  }
}

function buildDeletePreviewLookup(params: {
  targets: MerchantDeleteTarget[];
  samples: DeletePreviewSample[];
}) {
  const lookup = new Map<string, DeletePreviewSample>();

  params.targets.forEach((target, index) => {
    const sample = params.samples[index];

    if (!sample) {
      return;
    }

    lookup.set(buildDeleteTargetKey(target), sample);
  });

  return lookup;
}

function buildDeletePreviewKeyRegistry(samples: DeletePreviewSample[]) {
  return samples.reduce<Record<string, true>>((result, sample) => {
    if (!sample.offerId) {
      return result;
    }

    result[buildDeleteTargetKey({
      contentLanguage: "en",
      feedLabel: "US",
      offerId: sample.offerId,
    })] = true;
    return result;
  }, {});
}

function filterLiveDeleteTargets(params: {
  targets: MerchantDeleteTarget[];
  samples: DeletePreviewSample[];
  liveOfferKeys: Set<string>;
}) {
  const sampleLookup = buildDeletePreviewLookup(params);
  const targets: MerchantDeleteTarget[] = [];
  const samples: DeletePreviewSample[] = [];

  for (const target of params.targets) {
    const key = buildDeleteTargetKey(target);

    if (!params.liveOfferKeys.has(key)) {
      continue;
    }

    targets.push(target);
    samples.push(
      sampleLookup.get(key) ?? toDeletePreviewSample(target, "shopify_scan"),
    );
  }

  return {
    targets,
    samples,
  };
}

function createMerchantSummary(identity: MerchantIdentity): MerchantCatalogSyncSummary {
  return {
    accountName: identity.accountName,
    dataSourceName: identity.dataSourceName,
    authMode: identity.authMode,
    upsertsAttempted: 0,
    upsertsSucceeded: 0,
    deletesAttempted: 0,
    deletesSucceeded: 0,
    reconciliationDeletes: 0,
    existingProductsScanned: 0,
    errorCount: 0,
    errors: [],
    deleteTargetsSample: [],
    deleteTargetKeysSucceeded: [],
  };
}

function mergeMerchantErrors(
  target: MerchantCatalogSyncSummary,
  errors: MerchantSyncError[],
  errorCount: number,
) {
  target.errorCount += errorCount;

  for (const error of errors) {
    if (target.errors.length >= MERCHANT_ERROR_SAMPLE_LIMIT) {
      return;
    }

    target.errors.push(error);
  }
}

function updateChunkDurationStats(params: {
  chunksCompleted: number;
  previousAverageMs: number | null;
  currentChunkMs: number;
}) {
  const totalBefore =
    (params.previousAverageMs ?? 0) * Math.max(params.chunksCompleted - 1, 0);
  const averageChunkDurationMs =
    params.chunksCompleted > 0
      ? (totalBefore + params.currentChunkMs) / params.chunksCompleted
      : params.currentChunkMs;

  return {
    lastChunkDurationMs: params.currentChunkMs,
    averageChunkDurationMs,
  };
}

function createProgressSnapshot(params: {
  input: LiveMerchantSyncWorkflowInput;
  startedAt: string;
  chunkTargetProducts: number;
  chunksCompleted: number;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  stage: LiveMerchantSyncWorkflowProgress["stage"];
  message: string;
  merchantPhase?: LiveMerchantSyncWorkflowProgress["merchantPhase"];
  merchantCompleted?: number;
  merchantTotal?: number | null;
  merchantErrors?: number;
  merchantPagesScanned?: number;
  merchantRowsScanned?: number;
  merchantMatchedRows?: number;
  merchantDeleteTargets?: number;
  controlState?: ActiveSyncRunState["controlState"];
  lastChunkDurationMs: number | null;
  averageChunkDurationMs: number | null;
  budget: SyncBudgetSnapshot | null;
}) {
  return {
    stage: params.stage,
    exhaustive: true,
    totalProducts: params.totalProducts,
    productsScanned: params.productsScanned,
    pagesScanned: params.pagesScanned,
    previewRows: 0,
    message: params.message,
    merchantPhase: params.merchantPhase,
    merchantCompleted: params.merchantCompleted,
    merchantTotal: params.merchantTotal,
    merchantErrors: params.merchantErrors,
    merchantPagesScanned: params.merchantPagesScanned,
    merchantRowsScanned: params.merchantRowsScanned,
    merchantMatchedRows: params.merchantMatchedRows,
    merchantDeleteTargets: params.merchantDeleteTargets,
    controlState: params.controlState ?? "running",
    chunksCompleted: params.chunksCompleted,
    chunkTargetProducts: params.chunkTargetProducts,
    elapsedMs: 0,
    lastChunkDurationMs: params.lastChunkDurationMs,
    averageChunkDurationMs: params.averageChunkDurationMs,
    mode: params.input.mode,
    budget: params.budget,
  } satisfies LiveMerchantSyncWorkflowProgress;
}

function toHistoryEntry(result: SyncRunResult, artifactId: string | null) {
  return {
    id: `${result.mode}-${result.startedAt}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger: result.trigger,
    purpose: result.purpose,
    mode: result.mode,
    dryRun: result.dryRun,
    ok: result.ok,
    scope: `${result.scope}${result.exhaustive ? " [exhaustive]" : ""}`,
    query: result.query,
    lookbackStart: result.lookbackStart,
    lookbackEnd: result.lookbackEnd ?? null,
    artifactId,
    exportArtifactId: result.exportArtifactId ?? null,
    notes: result.notes.slice(0, 8),
    stats: result.stats,
  };
}

async function publishWorkflowEvent(
  runId: string,
  event: LiveMerchantSyncWorkflowEvent,
  progress?: LiveMerchantSyncWorkflowProgress,
  status?: "running" | "completed" | "failed",
  startedAt?: string,
) {
  "use step";

  const normalizedProgress =
    progress && startedAt
      ? {
          ...progress,
          elapsedMs: Date.now() - Date.parse(startedAt),
        }
      : progress;

  try {
    if (normalizedProgress) {
      const { getActiveSyncRun, updateActiveSyncRun } = await import(
        "@/lib/operator-store"
      );
      const activeRun = await getActiveSyncRun();
      const controlState =
        activeRun?.runId === runId
          ? activeRun.controlState
          : normalizedProgress.controlState ?? "running";
      await updateActiveSyncRun(runId, {
        status: status ?? "running",
        finishedAt:
          status === "completed" || status === "failed"
            ? new Date().toISOString()
            : null,
        chunksCompleted: normalizedProgress.chunksCompleted,
        message: normalizedProgress.message,
        totalProducts: normalizedProgress.totalProducts,
        productsScanned: normalizedProgress.productsScanned,
        pagesScanned: normalizedProgress.pagesScanned,
        merchantPhase: normalizedProgress.merchantPhase ?? null,
        merchantCompleted: normalizedProgress.merchantCompleted ?? 0,
        merchantTotal: normalizedProgress.merchantTotal ?? null,
        merchantPagesScanned: normalizedProgress.merchantPagesScanned ?? 0,
        merchantRowsScanned: normalizedProgress.merchantRowsScanned ?? 0,
        merchantMatchedRows: normalizedProgress.merchantMatchedRows ?? 0,
        merchantDeleteTargets: normalizedProgress.merchantDeleteTargets ?? 0,
        controlState,
        lastChunkDurationMs: normalizedProgress.lastChunkDurationMs,
        averageChunkDurationMs: normalizedProgress.averageChunkDurationMs,
        budget: normalizedProgress.budget ?? null,
      });
      normalizedProgress.controlState = controlState;
    } else if (status) {
      const { updateActiveSyncRun } = await import("@/lib/operator-store");
      await updateActiveSyncRun(runId, {
        status,
        finishedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("[liveMerchantSyncWorkflow] active-run update failed", error);
  }

  try {
    const writer = getWritable<LiveMerchantSyncWorkflowEvent>().getWriter();

    try {
      await writer.write(
        normalizedProgress
          ? {
              type: "progress",
              progress: normalizedProgress,
            }
          : event,
      );
    } finally {
      writer.releaseLock();
    }
  } catch (error) {
    console.error("[liveMerchantSyncWorkflow] event write failed", error);
  }
}

async function getRunControlStateStep(runId: string) {
  "use step";
  const { getActiveSyncRun } = await import("@/lib/operator-store");
  const activeRun = await getActiveSyncRun();
  return activeRun?.runId === runId ? activeRun.controlState : "running";
}

async function markRunPausedStep(runId: string, message: string) {
  "use step";
  const { updateActiveSyncRun } = await import("@/lib/operator-store");
  await updateActiveSyncRun(runId, {
    controlState: "paused",
    message,
  });
}

async function waitForResumeIfPaused(params: {
  runId: string;
  startedAt: string;
  progress: LiveMerchantSyncWorkflowProgress;
}) {
  while (true) {
    const controlState = await getRunControlStateStep(params.runId);

    if (controlState === "running" || controlState === "stop_requested") {
      return controlState;
    }

    const pausedProgress = {
      ...params.progress,
      controlState: "paused" as const,
      message:
        "Sync is paused. Resume it from the dashboard to continue from the next checkpoint.",
    } satisfies LiveMerchantSyncWorkflowProgress;
    await markRunPausedStep(params.runId, pausedProgress.message);
    await publishWorkflowEvent(
      params.runId,
      {
        type: "progress",
        progress: pausedProgress,
      },
      pausedProgress,
      "running",
      params.startedAt,
    );
    await sleep("15s");
  }
}

async function loadExecutionContextStep(
  input: LiveMerchantSyncWorkflowInput,
) {
  "use step";
  console.log(
    `[liveMerchantSyncWorkflow] loading execution context mode=${input.mode}`,
  );
  const { prepareSyncExecutionContext } = await import("@/lib/sync");
  return prepareSyncExecutionContext({
    mode: input.mode,
    settings: input.settings,
    dryRun: false,
    effectiveNow: input.windowFrozenAt
      ? new Date(input.windowFrozenAt)
      : input.startedAt
        ? new Date(input.startedAt)
        : undefined,
    allowDeltaFallback: input.allowDeltaFallback,
  });
}

async function loadMerchantIdentityStep() {
  "use step";
  const { getGoogleMerchantConnectionStatus } = await import(
    "@/lib/google-merchant"
  );
  const status = await getGoogleMerchantConnectionStatus();

  if (!status.authMode || !status.accountName || !status.dataSourceName) {
    throw new Error(
      status.error ??
        "Google Merchant configuration is incomplete for live sync execution.",
    );
  }

  return {
    authMode: status.authMode,
    accountName: status.accountName,
    dataSourceName: status.dataSourceName,
  } satisfies MerchantIdentity;
}

async function loadPendingDeleteTargetsStep() {
  "use step";
  const { getPendingShopifyDeletes } = await import("@/lib/operator-store");
  const pendingDeleteRecords = await getPendingShopifyDeletes();
  return {
    records: pendingDeleteRecords,
    targets: pendingDeleteRecords.map(toPendingDeleteTarget),
    previewSamples: pendingDeleteRecords.map(toPendingDeletePreviewSample),
  };
}

async function loadBudgetProfileStep(input: LiveMerchantSyncWorkflowInput) {
  "use step";
  const { getSyncHistory } = await import("@/lib/operator-store");
  const history = (await getSyncHistory(20)) as SyncBudgetHistorySample[];
  return buildSyncBudgetProfile({
    mode: input.mode,
    history,
  });
}

async function requestBudgetStopStep(runId: string, message: string) {
  "use step";
  const { updateActiveSyncRun } = await import("@/lib/operator-store");
  await updateActiveSyncRun(runId, {
    controlState: "stop_requested",
    message,
  });
}

async function loadRestartCheckpointStep(checkpointId: string) {
  "use step";
  const {
    getLiveSyncRestartCheckpoint,
    readLiveSyncRestartCheckpointPayload,
  } = await import("@/lib/operator-store");
  const checkpoint = await getLiveSyncRestartCheckpoint();

  if (!checkpoint || checkpoint.id !== checkpointId) {
    throw new Error(
      "The requested live sync checkpoint is no longer available. Refresh the dashboard before restarting.",
    );
  }

  const payload =
    await readLiveSyncRestartCheckpointPayload<LiveSyncRestartCheckpointPayload>();

  if (!payload) {
    throw new Error(
      "The live sync checkpoint payload could not be loaded. Refresh the dashboard before restarting.",
    );
  }

  return {
    checkpoint,
    payload,
  };
}

async function saveRestartCheckpointStep(params: {
  runId: string;
  checkpoint: LiveSyncRestartCheckpointState;
  payload: LiveSyncRestartCheckpointPayload;
}) {
  "use step";
  const {
    saveLiveSyncRestartCheckpoint,
    updateCronInvocationByRunId,
  } = await import("@/lib/operator-store");
  await saveLiveSyncRestartCheckpoint(params);

  if (params.checkpoint.trigger === "cron") {
    await updateCronInvocationByRunId(params.runId, {
      outcome: "cancelled",
      message:
        "Scheduled live sync stopped at a safe checkpoint and is ready to restart from the dashboard.",
    });
  }
}

async function clearRestartCheckpointStep(checkpointId: string) {
  "use step";
  const { clearLiveSyncRestartCheckpoint } = await import("@/lib/operator-store");
  await clearLiveSyncRestartCheckpoint(checkpointId);
}

async function loadOrSeedLiveOfferIndexStep(dataSourceName: string) {
  "use step";
  const { getLiveOfferIndex, saveLiveOfferIndex } = await import(
    "@/lib/operator-store"
  );
  const existing = await getLiveOfferIndex(dataSourceName);

  if (existing) {
    return existing;
  }

  console.log(
    `[liveMerchantSyncWorkflow] seeding live offer index from Merchant data source=${dataSourceName}`,
  );
  const { listConfiguredDataSourceProducts } = await import(
    "@/lib/google-merchant"
  );
  const currentProducts = await listConfiguredDataSourceProducts();

  return saveLiveOfferIndex({
    dataSourceName,
    keys: currentProducts.map((target) => buildDeleteTargetKey(target)),
    source: "merchant_scan",
  });
}

async function initializeExportArtifactStep(params: {
  exportArtifactId: string;
  input: LiveMerchantSyncWorkflowInput;
  startedAt: string;
  context: SyncExecutionContext;
}) {
  "use step";
  const { writePreviewExportArtifact } = await import("@/lib/operator-store");

  await writePreviewExportArtifact(params.exportArtifactId, {
    ok: true,
    mode: params.input.mode,
    dryRun: false,
    exhaustive: true,
    startedAt: params.startedAt,
    finishedAt: params.startedAt,
    notes: ["Live sync export artifact is running in chunked mode."],
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
    lookbackEnd: params.context.lookbackEnd ?? null,
    stats: {
      pageSize: 250,
      pagesScanned: 0,
      scanCompleted: false,
      totalProducts: params.context.totalProducts,
      productsFetched: 0,
      variantsConsidered: 0,
      recordsPrepared: 0,
      excluded: 0,
      validationIssues: 0,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
    },
    exclusions: {},
    rows: [],
    excludedRows: [],
    validationRows: [],
  } satisfies SyncExportResult);
}

async function scanChunkStep(params: {
  context: SyncExecutionContext;
  cursor: string | null;
  chunkTargetProducts: number;
}) {
  "use step";
  console.log(
    `[liveMerchantSyncWorkflow] scanning chunk mode=${params.context.mode} cursor=${params.cursor ?? "start"}`,
  );
  const startedAt = Date.now();
  const { scanSyncExecutionChunk } = await import("@/lib/sync");
  const chunk = await scanSyncExecutionChunk({
    context: params.context,
    cursor: params.cursor,
    maxProducts: params.chunkTargetProducts,
    artifactSampleLimit: INCLUDED_SAMPLE_LIMIT,
    collectAllRecords: true,
    captureDeleteCandidates: true,
  });

  return {
    ...chunk,
    durationMs: Date.now() - startedAt,
    transferBytes: chunk.estimatedTransferBytes,
  };
}

async function appendExportChunkStep(params: {
  exportArtifactId: string;
  rows: FeedPreviewRecord[];
  excludedRows: ExcludedPreviewSample[];
  validationRows: ExcludedPreviewSample[];
}) {
  "use step";
  const { appendPreviewExportArtifactChunk } = await import(
    "@/lib/operator-store"
  );

  await appendPreviewExportArtifactChunk(params.exportArtifactId, {
    rows: params.rows,
    excludedRows: params.excludedRows,
    validationRows: params.validationRows,
  });
}

async function upsertChunkStep(params: {
  runId: string;
  startedAt: string;
  progressBase: Omit<
    LiveMerchantSyncWorkflowProgress,
    | "message"
    | "merchantPhase"
    | "merchantCompleted"
    | "merchantTotal"
    | "merchantErrors"
  >;
  records: FeedPreviewRecord[];
}) {
  "use step";
  console.log(
    `[liveMerchantSyncWorkflow] upserting chunk records=${params.records.length}`,
  );
  const startedAt = Date.now();
  const { upsertMerchantProductBatch } = await import("@/lib/google-merchant");
  const summary = await upsertMerchantProductBatch({
    records: params.records,
    onProgress: async (update) => {
      const progress = {
        ...params.progressBase,
        message: update.message,
        merchantPhase: update.phase,
        merchantCompleted: update.completed,
        merchantTotal: update.total,
        merchantErrors: update.errors,
      } satisfies LiveMerchantSyncWorkflowProgress;

      await publishWorkflowEvent(
        params.runId,
        {
          type: "progress",
          progress,
        },
        progress,
        undefined,
        params.startedAt,
      );
    },
  });

  return {
    summary,
    durationMs: Date.now() - startedAt,
    transferBytes:
      estimateJsonBytes(params.records) +
      estimateJsonBytes(summary.errors) +
      MERCHANT_RESULT_BUFFER_BYTES,
  };
}

async function deleteChunkStep(params: {
  runId: string;
  startedAt: string;
  progressBase: Omit<
    LiveMerchantSyncWorkflowProgress,
    | "message"
    | "merchantPhase"
    | "merchantCompleted"
    | "merchantTotal"
    | "merchantErrors"
  >;
  targets: MerchantDeleteTarget[];
}) {
  "use step";
  console.log(
    `[liveMerchantSyncWorkflow] deleting chunk targets=${params.targets.length}`,
  );
  const startedAt = Date.now();
  const { deleteMerchantProductBatch } = await import("@/lib/google-merchant");
  const summary = await deleteMerchantProductBatch({
    targets: params.targets,
    onProgress: async (update) => {
      const progress = {
        ...params.progressBase,
        message: update.message,
        merchantPhase: update.phase,
        merchantCompleted: update.completed,
        merchantTotal: update.total,
        merchantErrors: update.errors,
      } satisfies LiveMerchantSyncWorkflowProgress;

      await publishWorkflowEvent(
        params.runId,
        {
          type: "progress",
          progress,
        },
        progress,
        undefined,
        params.startedAt,
      );
    },
  });

  return {
    summary,
    durationMs: Date.now() - startedAt,
    transferBytes:
      estimateJsonBytes(params.targets) +
      estimateJsonBytes(summary.errors) +
      MERCHANT_RESULT_BUFFER_BYTES,
  };
}

async function scanReconciliationPageStep(pageToken: string | null) {
  "use step";
  console.log(
    `[liveMerchantSyncWorkflow] reconciling Merchant page pageToken=${pageToken ?? "start"}`,
  );
  const { listConfiguredDataSourceProductPage } = await import(
    "@/lib/google-merchant"
  );
  const page = await listConfiguredDataSourceProductPage(pageToken);
  return {
    ...page,
    transferBytes: estimateJsonBytes(page),
  };
}

async function removeSucceededPendingDeletesStep(
  targets: Array<
    Pick<MerchantDeleteTarget, "contentLanguage" | "feedLabel" | "offerId">
  >,
) {
  "use step";
  const { removePendingShopifyDeletes } = await import("@/lib/operator-store");
  await removePendingShopifyDeletes(targets);
}

async function removeSucceededPendingUpsertsStep(
  productIds: string[],
  queuedAtLte: string,
) {
  "use step";
  const { removePendingShopifyUpserts } = await import("@/lib/operator-store");
  await removePendingShopifyUpserts(productIds, {
    queuedAtLte,
  });
}

async function persistSuccessfulRunStep(params: {
  runId: string;
  input: LiveMerchantSyncWorkflowInput;
  context: SyncExecutionContext;
  startedAt: string;
  exportArtifactId: string;
  includedSample: FeedPreviewRecord[];
  validationSample: ExcludedPreviewSample[];
  excludedSample: ExcludedPreviewSample[];
  deleteSample: DeletePreviewSample[];
  productsFetched: number;
  pagesScanned: number;
  variantsConsidered: number;
  recordsPrepared: number;
  exclusions: Record<string, number>;
  merchant: MerchantCatalogSyncSummary;
  pendingDeleteCount: number;
  liveOfferKeys: string[];
  liveOfferFingerprints: Record<string, string>;
  unchangedRecordsSkipped: number;
  liveOfferIndexDataSourceName: string;
}) {
  "use step";
  const {
    buildSyncNotes,
    buildSyncScope,
    countValidationIssues,
  } = await import("@/lib/sync");
  const {
    appendSyncHistory,
    readPreviewExportArtifact,
    saveLiveOfferIndex,
    updateCronInvocationByRunId,
    writePreviewExportArtifact,
    writeRunArtifact,
  } = await import("@/lib/operator-store");

  const validationIssues = countValidationIssues(params.exclusions);
  const notes = buildSyncNotes({
    dryRun: false,
    exhaustive: true,
    previewLimit: DEFAULT_PREVIEW_LIMIT,
    scanCompleted: true,
    validationIssues,
    searchNotes: params.context.searchNotes,
    merchant: params.merchant,
  });
  notes.push(
    `Live sync ran in chunked mode with a target of ${params.input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET} Shopify products per chunk.`,
  );
  notes.push(
    "Feed, validation, and excluded downloads were saved with this live run so the same output can be inspected later from run history.",
  );
  if (params.input.restartCheckpointId) {
    notes.unshift(
      "This live sync restarted from a saved checkpoint after an earlier run was stopped at a safe checkpoint.",
    );
  }
  if (params.pendingDeleteCount > 0) {
    notes.unshift(
      `${params.pendingDeleteCount} hard-deleted Shopify variant(s) were queued from webhook events and included in this run's Merchant delete scope.`,
    );
  }
  if (params.unchangedRecordsSkipped > 0) {
    notes.unshift(
      `Delta fingerprint filtering skipped ${params.unchangedRecordsSkipped.toLocaleString()} unchanged Merchant row(s) before calling the Merchant API.`,
    );
  }

  const exportArtifact =
    (await readPreviewExportArtifact<SyncExportResult>(params.exportArtifactId)) ?? {
      rows: [],
      excludedRows: [],
      validationRows: [],
    };
  const finishedAt = new Date().toISOString();
  const finalizedExport = {
    ok: params.merchant.errorCount === 0,
    mode: params.input.mode,
    dryRun: false,
    exhaustive: true,
    startedAt: params.startedAt,
    finishedAt,
    notes,
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
    lookbackEnd: params.context.lookbackEnd ?? null,
    stats: {
      pageSize: 250,
      pagesScanned: params.pagesScanned,
      scanCompleted: true,
      totalProducts: params.context.totalProducts,
      productsFetched: params.productsFetched,
      variantsConsidered: params.variantsConsidered,
      recordsPrepared: params.recordsPrepared,
      excluded: Object.values(params.exclusions).reduce((sum, count) => sum + count, 0),
      validationIssues,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
      merchantUpsertsAttempted: params.merchant.upsertsAttempted,
      merchantUpsertsSucceeded: params.merchant.upsertsSucceeded,
      merchantDeletesAttempted: params.merchant.deletesAttempted,
      merchantDeletesSucceeded: params.merchant.deletesSucceeded,
      merchantReconciliationDeletes: params.merchant.reconciliationDeletes,
      merchantWriteErrors: params.merchant.errorCount,
    },
    exclusions: params.exclusions,
    rows: exportArtifact.rows ?? [],
    excludedRows: exportArtifact.excludedRows ?? [],
    validationRows: exportArtifact.validationRows ?? [],
  } satisfies SyncExportResult;

  const result = {
    ok: params.merchant.errorCount === 0,
    trigger: params.input.trigger,
    purpose: params.input.purpose ?? "sync",
    mode: params.input.mode,
    dryRun: false,
    exhaustive: true,
    scope: buildSyncScope(
      params.input.mode,
      params.context.searchPlan,
      params.input.settings,
      true,
    ),
    startedAt: params.startedAt,
    finishedAt,
    configuration: getConfigurationStatus(),
    notes,
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
    lookbackEnd: params.context.lookbackEnd ?? null,
    storefrontBaseUrl: params.context.storefrontBaseUrl,
    stats: {
      pageSize: 250,
      pagesScanned: params.pagesScanned,
      scanCompleted: true,
      totalProducts: params.context.totalProducts,
      productsFetched: params.productsFetched,
      variantsConsidered: params.variantsConsidered,
      recordsPrepared: params.recordsPrepared,
      excluded: Object.values(params.exclusions).reduce((sum, count) => sum + count, 0),
      validationIssues,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
      merchantUpsertsAttempted: params.merchant.upsertsAttempted,
      merchantUpsertsSucceeded: params.merchant.upsertsSucceeded,
      merchantDeletesAttempted: params.merchant.deletesAttempted,
      merchantDeletesSucceeded: params.merchant.deletesSucceeded,
      merchantReconciliationDeletes: params.merchant.reconciliationDeletes,
      merchantWriteErrors: params.merchant.errorCount,
    },
    exclusions: params.exclusions,
    preview: params.includedSample.slice(0, DEFAULT_PREVIEW_LIMIT),
    exportArtifactId: params.exportArtifactId,
    deleteSample: params.deleteSample,
    merchant: params.merchant,
  } satisfies SyncRunResult;

  if (params.merchant.errorCount === 0) {
    await saveLiveOfferIndex({
      dataSourceName: params.liveOfferIndexDataSourceName,
      keys: params.liveOfferKeys,
      fingerprints: params.liveOfferFingerprints,
      source: params.input.mode === "full" ? "full_success" : "delta_success",
    });
  } else {
    notes.push(
      "The live offer index was not advanced because this run had Merchant API write errors.",
    );
  }
  await writePreviewExportArtifact(params.exportArtifactId, finalizedExport);

  const artifactId = result.startedAt.replaceAll(":", "-");
  const artifact: SyncRunArtifact = {
    id: artifactId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger: result.trigger,
    purpose: result.purpose,
    mode: result.mode,
    dryRun: result.dryRun,
    exhaustive: result.exhaustive,
    ok: result.ok,
    scope: result.scope,
    query: result.query,
    lookbackStart: result.lookbackStart,
    lookbackEnd: result.lookbackEnd ?? null,
    exportArtifactId: params.exportArtifactId,
    notes: result.notes,
    stats: result.stats,
    includedSample: params.includedSample,
    validationSample: params.validationSample,
    excludedSample: params.excludedSample,
    deleteSample: params.deleteSample,
    deleteSampleMode: "actual",
    merchant: result.merchant ?? null,
  };

  await writeRunArtifact(artifactId, artifact);
  await appendSyncHistory(toHistoryEntry(result, artifactId));

  if (params.input.trigger === "cron") {
    await updateCronInvocationByRunId(params.runId, {
      outcome: result.ok ? "completed" : "failed",
      message: result.ok
        ? `Scheduled ${params.input.mode} live sync completed successfully.`
        : `Scheduled ${params.input.mode} live sync completed with Merchant API errors. Review run history before trusting this sync.`,
    });
  }

  return result;
}

async function persistFailedRunStep(params: {
  runId: string;
  input: LiveMerchantSyncWorkflowInput;
  context: SyncExecutionContext | null;
  startedAt: string;
  exportArtifactId: string | null;
  message: string;
}) {
  "use step";
  const { buildSyncScope } = await import("@/lib/sync");
  const {
    appendSyncHistory,
    deletePreviewExportArtifact,
    updateCronInvocationByRunId,
    writeRunArtifact,
  } = await import("@/lib/operator-store");

  if (params.exportArtifactId) {
    await deletePreviewExportArtifact(params.exportArtifactId);
  }

  const scope =
    params.context?.searchPlan
      ? buildSyncScope(
          params.input.mode,
          params.context.searchPlan,
          params.input.settings,
          true,
        )
      : params.input.mode === "full"
        ? "All Shopify products are scanned across active, draft, and archived statuses so current feed rows can be inserted and inactive rows can be deleted from Merchant Center."
        : "Shopify products changed after the last successful live sync are scanned exhaustively so Merchant Center can be updated incrementally.";

  const result = {
    ok: false,
    trigger: params.input.trigger,
    purpose: params.input.purpose ?? "sync",
    mode: params.input.mode,
    dryRun: false,
    exhaustive: true,
    scope,
    startedAt: params.startedAt,
    finishedAt: new Date().toISOString(),
    configuration: getConfigurationStatus(),
    notes: [
      ...(params.input.restartCheckpointId
        ? [
            "This live sync had been restarted from a saved checkpoint before it failed again.",
          ]
        : []),
      ...(params.context?.searchNotes ?? []),
      `Chunked live sync failed: ${params.message}`,
      "Merchant Center writes may be partial if the failure happened after some requests were sent.",
    ],
    query: params.context?.query ?? "",
    lookbackStart: params.context?.lookbackStart ?? null,
    lookbackEnd: params.context?.lookbackEnd ?? null,
    storefrontBaseUrl: params.context?.storefrontBaseUrl ?? null,
    stats: {
      pageSize: 250,
      pagesScanned: 0,
      scanCompleted: false,
      totalProducts: params.context?.totalProducts ?? null,
      productsFetched: 0,
      variantsConsidered: 0,
      recordsPrepared: 0,
      excluded: 0,
      validationIssues: 0,
      previewLimit: DEFAULT_PREVIEW_LIMIT,
    },
    exclusions: {},
    preview: [],
    exportArtifactId: null,
    merchant: null,
  } satisfies SyncRunResult;

  const artifactId = result.startedAt.replaceAll(":", "-");
  const artifact: SyncRunArtifact = {
    id: artifactId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger: result.trigger,
    purpose: result.purpose,
    mode: result.mode,
    dryRun: result.dryRun,
    exhaustive: result.exhaustive,
    ok: result.ok,
    scope: result.scope,
    query: result.query,
    lookbackStart: result.lookbackStart,
    lookbackEnd: result.lookbackEnd ?? null,
    exportArtifactId: null,
    notes: result.notes,
    stats: result.stats,
    includedSample: [],
    validationSample: [],
    excludedSample: [],
    deleteSample: [],
    deleteSampleMode: "actual",
    merchant: null,
  };

  await writeRunArtifact(artifactId, artifact);
  await appendSyncHistory(toHistoryEntry(result, artifactId));

  if (params.input.trigger === "cron") {
    await updateCronInvocationByRunId(params.runId, {
      outcome: "failed",
      message: `Scheduled ${params.input.mode} live sync failed: ${params.message}`,
    });
  }

  return result;
}

async function cleanupActiveRunStep(runId: string) {
  "use step";
  const { clearActiveSyncRun } = await import("@/lib/operator-store");
  await clearActiveSyncRun(runId);
}

export async function liveMerchantSyncWorkflow(
  input: LiveMerchantSyncWorkflowInput,
): Promise<SyncRunResult> {
  "use workflow";

  const metadata = getWorkflowMetadata();
  const runId = metadata.workflowRunId;
  const startedAt = input.startedAt ?? metadata.workflowStartedAt.toISOString();
  const windowFrozenAt = input.windowFrozenAt ?? startedAt;
  const chunkTargetProducts = Math.max(
    1,
    input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET,
  );
  let exportArtifactId = `live-sync-${input.mode}-${startedAt.replaceAll(":", "-")}`;
  let context: SyncExecutionContext | null = null;
  let restartCheckpointPayload: LiveSyncRestartCheckpointPayload | null = null;
  const budgetUsage = createBudgetUsage({
    ...input,
    startedAt,
    chunkTargetProducts,
  });
  let elapsedBaseMs = 0;

  console.log(
    `[liveMerchantSyncWorkflow] start runId=${runId} mode=${input.mode} trigger=${input.trigger}`,
  );

  try {
    context = await loadExecutionContextStep({
      ...input,
      startedAt,
      chunkTargetProducts,
    });
    const budgetProfile = await loadBudgetProfileStep({
      ...input,
      startedAt,
      chunkTargetProducts,
    });
    const merchantIdentity = await loadMerchantIdentityStep();
    const pendingDeleteScope = await loadPendingDeleteTargetsStep();
    const liveOfferIndex =
      input.mode === "delta"
        ? await loadOrSeedLiveOfferIndexStep(merchantIdentity.dataSourceName)
        : null;
    const liveOfferKeys =
      input.mode === "delta" ? new Set(liveOfferIndex?.keys ?? []) : null;
    const liveOfferFingerprints =
      input.mode === "delta"
        ? { ...(liveOfferIndex?.fingerprints ?? {}) }
        : null;
    const fingerprintBaselineCount = liveOfferFingerprints
      ? Object.keys(liveOfferFingerprints).length
      : 0;

    if (
      input.mode === "delta" &&
      fingerprintBaselineCount === 0 &&
      typeof context.totalProducts === "number" &&
      context.totalProducts > LARGE_DELTA_PRODUCT_LIMIT_WITHOUT_FINGERPRINTS
    ) {
      throw new Error(
        `Delta window contains ${context.totalProducts.toLocaleString()} Shopify products, but no feed fingerprint baseline exists yet. This run was stopped before Merchant writes to avoid an accidental broad daily upload.`,
      );
    }
    const merchant = createMerchantSummary(merchantIdentity);
    const exclusions: Record<string, number> = {};
    const includedSample: FeedPreviewRecord[] = [];
    const validationSample: ExcludedPreviewSample[] = [];
    const excludedSample: ExcludedPreviewSample[] = [];
    const deleteSample: DeletePreviewSample[] = [];
    const deletePreviewKeys: Record<string, true> = {};
    const seenKeys: string[] = [];
    const seenFingerprints: Record<string, string> = {};
    let cursor: string | null = null;
    let scanCompleted = false;
    let pagesScanned = 0;
    let productsFetched = 0;
    let variantsConsidered = 0;
    let recordsPrepared = 0;
    let unchangedRecordsSkipped = 0;
    let chunksCompleted = 0;
    let lastChunkDurationMs: number | null = null;
    let averageChunkDurationMs: number | null = null;

    if (input.restartCheckpointId) {
      const loadedCheckpoint = await loadRestartCheckpointStep(
        input.restartCheckpointId,
      );
      restartCheckpointPayload = loadedCheckpoint.payload;
      await clearRestartCheckpointStep(input.restartCheckpointId);
      exportArtifactId = restartCheckpointPayload.exportArtifactId;
      cursor = restartCheckpointPayload.cursor;
      scanCompleted = restartCheckpointPayload.scanCompleted;
      pagesScanned = restartCheckpointPayload.pagesScanned;
      productsFetched = restartCheckpointPayload.productsFetched;
      variantsConsidered = restartCheckpointPayload.variantsConsidered;
      recordsPrepared = restartCheckpointPayload.recordsPrepared;
      unchangedRecordsSkipped = restartCheckpointPayload.unchangedRecordsSkipped;
      chunksCompleted = restartCheckpointPayload.chunksCompleted;
      lastChunkDurationMs = restartCheckpointPayload.lastChunkDurationMs;
      averageChunkDurationMs = restartCheckpointPayload.averageChunkDurationMs;
      elapsedBaseMs = Math.max(
        0,
        restartCheckpointPayload.budgetUsage.elapsedMs,
      );
      Object.assign(exclusions, restartCheckpointPayload.exclusions);
      includedSample.push(...restartCheckpointPayload.includedSample);
      validationSample.push(...restartCheckpointPayload.validationSample);
      excludedSample.push(...restartCheckpointPayload.excludedSample);
      deleteSample.push(...restartCheckpointPayload.deleteSample);
      Object.assign(
        deletePreviewKeys,
        buildDeletePreviewKeyRegistry(restartCheckpointPayload.deleteSample),
      );
      seenKeys.push(...restartCheckpointPayload.seenKeys);
      Object.assign(seenFingerprints, restartCheckpointPayload.seenFingerprints);
      Object.assign(merchant, restartCheckpointPayload.merchant);
      Object.assign(budgetUsage, restartCheckpointPayload.budgetUsage, {
        mode: input.mode,
        chunkTargetProducts,
      });
      budgetUsage.productsScanned = productsFetched;
      budgetUsage.chunksCompleted = chunksCompleted;
    } else {
      await initializeExportArtifactStep({
        exportArtifactId,
        input: {
          ...input,
          windowFrozenAt,
        },
        startedAt,
        context,
      });
    }

    budgetUsage.totalProducts = context.totalProducts;
    budgetUsage.vercelFunctionsUsed += input.mode === "delta" ? 5 : 4;
    budgetUsage.neonOpsUsed += input.mode === "delta" ? 5 : 4;

    const buildBudgetSnapshot = () => {
      budgetUsage.elapsedMs =
        elapsedBaseMs + Math.max(0, Date.now() - Date.parse(startedAt));
      budgetUsage.totalProducts = context?.totalProducts ?? budgetUsage.totalProducts;
      return evaluateSyncBudget({
        profile: budgetProfile,
        usage: budgetUsage,
      });
    };

    const makeProgressSnapshot = (
      params: Omit<
        Parameters<typeof createProgressSnapshot>[0],
        "budget"
      >,
    ) =>
      createProgressSnapshot({
        ...params,
        budget: buildBudgetSnapshot(),
      });

    const noteProgressPublish = () => {
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 2;
    };

    const notePreviewExportChunkWrite = () => {
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 2;
    };

    const buildStoppedResult = (message: string): SyncRunResult => {
      const finishedAt = new Date().toISOString();

      return {
        ok: false,
        trigger: input.trigger,
        purpose: input.purpose ?? "sync",
        mode: input.mode,
        dryRun: false,
        exhaustive: true,
        scope:
          input.mode === "full"
            ? "All Shopify products are scanned across active, draft, and archived statuses so current feed rows can be inserted and inactive rows can be deleted from Merchant Center."
            : "Shopify products changed after the last successful live sync are scanned exhaustively so Merchant Center can be updated incrementally.",
        startedAt,
        finishedAt,
        configuration: getConfigurationStatus(),
        notes: [message],
        query: context!.query,
        lookbackStart: context!.lookbackStart,
        lookbackEnd: context!.lookbackEnd ?? null,
        storefrontBaseUrl: context!.storefrontBaseUrl,
        stats: {
          pageSize: 250,
          pagesScanned,
          scanCompleted,
          totalProducts: context!.totalProducts,
          productsFetched,
          variantsConsidered,
          recordsPrepared,
          excluded: Object.values(exclusions).reduce((sum, count) => sum + count, 0),
          validationIssues: 0,
          previewLimit: DEFAULT_PREVIEW_LIMIT,
          merchantUpsertsAttempted: merchant.upsertsAttempted,
          merchantUpsertsSucceeded: merchant.upsertsSucceeded,
          merchantDeletesAttempted: merchant.deletesAttempted,
          merchantDeletesSucceeded: merchant.deletesSucceeded,
          merchantReconciliationDeletes: merchant.reconciliationDeletes,
          merchantWriteErrors: merchant.errorCount,
        },
        exclusions,
        preview: includedSample.slice(0, DEFAULT_PREVIEW_LIMIT),
        exportArtifactId,
        deleteSample,
        merchant,
      };
    };

    const buildRestartCheckpointPayload = (params: {
      stage: RestartCheckpointStage;
      reconciliationPageToken?: string | null;
      merchantPagesScanned?: number;
      merchantRowsScanned?: number;
      merchantMatchedRows?: number;
      merchantDeleteTargets?: number;
      reconciliationTargets?: MerchantDeleteTarget[];
      reconciliationDeleteIndex?: number;
    }) =>
      ({
        version: 1,
        input: {
          mode: input.mode,
          trigger: input.trigger,
          purpose: input.purpose ?? "sync",
          settings: input.settings,
          chunkTargetProducts,
          windowFrozenAt,
          allowDeltaFallback: input.allowDeltaFallback,
        },
        exportArtifactId,
        cursor,
        scanCompleted,
        pagesScanned,
        productsFetched,
        variantsConsidered,
        recordsPrepared,
        exclusions: { ...exclusions },
        includedSample: [...includedSample],
        validationSample: [...validationSample],
        excludedSample: [...excludedSample],
        deleteSample: [...deleteSample],
        seenKeys: [...seenKeys],
        seenFingerprints: { ...seenFingerprints },
        unchangedRecordsSkipped,
        chunksCompleted,
        lastChunkDurationMs,
        averageChunkDurationMs,
        merchant: {
          ...merchant,
          errors: [...merchant.errors],
          deleteTargetsSample: [...merchant.deleteTargetsSample],
          deleteTargetKeysSucceeded: [...merchant.deleteTargetKeysSucceeded],
        },
        budgetUsage: {
          ...budgetUsage,
          elapsedMs:
            elapsedBaseMs + Math.max(0, Date.now() - Date.parse(startedAt)),
        },
        reconciliation: {
          stage: params.stage,
          pageToken: params.reconciliationPageToken ?? null,
          merchantPagesScanned: params.merchantPagesScanned ?? 0,
          merchantRowsScanned: params.merchantRowsScanned ?? 0,
          merchantMatchedRows: params.merchantMatchedRows ?? 0,
          merchantDeleteTargets: params.merchantDeleteTargets ?? 0,
          deleteTargets: [...(params.reconciliationTargets ?? [])],
          deleteIndex: params.reconciliationDeleteIndex ?? 0,
        },
      }) satisfies LiveSyncRestartCheckpointPayload;

    const maybeStopForCheckpoint = async (params: {
      progress: LiveMerchantSyncWorkflowProgress;
      stage: RestartCheckpointStage;
      reconciliationPageToken?: string | null;
      merchantPagesScanned?: number;
      merchantRowsScanned?: number;
      merchantMatchedRows?: number;
      merchantDeleteTargets?: number;
      reconciliationTargets?: MerchantDeleteTarget[];
      reconciliationDeleteIndex?: number;
    }) => {
      const controlState = await getRunControlStateStep(runId);

      if (controlState !== "stop_requested") {
        return null;
      }

      const checkpointId = `${input.mode}-${new Date().toISOString().replaceAll(":", "-")}`;
      const checkpointMessage =
        "Sync stopped at a safe checkpoint. Refresh the dashboard and restart from checkpoint after you deploy the fix.";
      const checkpoint = {
        id: checkpointId,
        artifactId: `checkpoint-${checkpointId}`,
        createdAt: new Date().toISOString(),
        sourceRunId: runId,
        mode: input.mode,
        trigger: input.trigger,
        purpose: input.purpose ?? "sync",
        message: checkpointMessage,
        stage: params.stage,
        windowFrozenAt,
        totalProducts: context!.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        chunksCompleted,
        merchantPhase: params.progress.merchantPhase ?? null,
        merchantPagesScanned: params.merchantPagesScanned ?? 0,
        merchantRowsScanned: params.merchantRowsScanned ?? 0,
        merchantMatchedRows: params.merchantMatchedRows ?? 0,
        merchantDeleteTargets: params.merchantDeleteTargets ?? 0,
      } satisfies LiveSyncRestartCheckpointState;

      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 2;
      await saveRestartCheckpointStep({
        runId,
        checkpoint,
        payload: buildRestartCheckpointPayload(params),
      });

      const stopProgress = {
        ...params.progress,
        controlState: "stop_requested" as const,
        message: checkpointMessage,
      } satisfies LiveMerchantSyncWorkflowProgress;

      noteProgressPublish();
      await publishWorkflowEvent(
        runId,
        {
          type: "progress",
          progress: stopProgress,
        },
        stopProgress,
        "failed",
        startedAt,
      );
      await publishWorkflowEvent(
        runId,
        {
          type: "result",
          result: {
            ok: false,
            finishedAt: new Date().toISOString(),
            message: checkpointMessage,
          },
        },
        undefined,
        "failed",
      );
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 1;
      await cleanupActiveRunStep(runId);
      return buildStoppedResult(checkpointMessage);
    };

    const maybePauseForBudget = async (
      progress: LiveMerchantSyncWorkflowProgress,
    ) => {
      if (progress.budget?.status !== "pause_requested") {
        return;
      }

      const pauseMessage = progress.budget.pauseReason ?? progress.budget.summary;
      const stopMessage = `${pauseMessage} Stopping at the next safe checkpoint so the workflow exits instead of waiting open.`;
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 1;
      await requestBudgetStopStep(runId, stopMessage);

      const pauseProgress = {
        ...progress,
        controlState: "stop_requested" as const,
        message: stopMessage,
      } satisfies LiveMerchantSyncWorkflowProgress;

      noteProgressPublish();
      await publishWorkflowEvent(
        runId,
        {
          type: "progress",
          progress: pauseProgress,
        },
        pauseProgress,
        undefined,
        startedAt,
      );
    };

    const initialProgress = makeProgressSnapshot({
      input,
      startedAt,
      chunkTargetProducts,
      chunksCompleted,
      totalProducts: context.totalProducts,
      productsScanned: 0,
      pagesScanned: 0,
      stage: "counting",
      message:
        input.mode === "full"
          ? "Counting Shopify products and preparing chunked full sync."
          : context.searchPlan.source === "webhook_queue"
            ? (context.totalProducts ?? 0) > 0
              ? `Counting ${context.totalProducts?.toLocaleString() ?? "0"} Shopify products queued by create/update webhooks. Feed fingerprints will skip unchanged Merchant rows before writing.`
              : "No Shopify create/update webhooks are queued right now. This delta run will only process pending webhook-driven deletes."
          : fingerprintBaselineCount > 0
            ? "Counting Shopify products touched in the delta window. Feed fingerprints will skip unchanged Merchant rows before writing."
            : "Counting Shopify products changed in the delta window.",
      lastChunkDurationMs,
      averageChunkDurationMs,
    });
    noteProgressPublish();
    await publishWorkflowEvent(
      runId,
      {
        type: "progress",
        progress: initialProgress,
      },
      initialProgress,
      undefined,
      startedAt,
    );

    while (!scanCompleted) {
      const scanningProgress = makeProgressSnapshot({
        input,
        startedAt,
        chunkTargetProducts,
        chunksCompleted,
        totalProducts: context.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        stage: "scanning",
        message:
          input.mode === "delta" && context.searchPlan.source === "webhook_queue"
            ? (context.totalProducts ?? 0) > 0
              ? chunksCompleted === 0
                ? `Scanning the first chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify products from the webhook queue; unchanged GMC payloads will be skipped.`
                : `Scanning the next chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify products from the webhook queue; unchanged GMC payloads will be skipped.`
              : "No queued Shopify product upserts were found. Confirming whether any webhook-driven deletes still need Merchant cleanup."
          : input.mode === "delta" && fingerprintBaselineCount > 0
            ? chunksCompleted === 0
              ? `Scanning the first chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify candidate products; unchanged GMC payloads will be skipped.`
              : `Scanning the next chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify candidate products; unchanged GMC payloads will be skipped.`
            : chunksCompleted === 0
              ? `Scanning the first chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify products.`
              : `Scanning the next chunk of up to ${chunkTargetProducts.toLocaleString()} Shopify products.`,
        lastChunkDurationMs,
        averageChunkDurationMs,
      });
      await maybePauseForBudget(scanningProgress);
      const scanControlState = await waitForResumeIfPaused({
        runId,
        startedAt,
        progress: scanningProgress,
      });
      if (scanControlState === "stop_requested") {
        const stopped = await maybeStopForCheckpoint({
          progress: scanningProgress,
          stage: "scanning",
        });

        if (stopped) {
          return stopped;
        }
      }
      noteProgressPublish();
      await publishWorkflowEvent(
        runId,
        {
          type: "progress",
          progress: scanningProgress,
        },
        scanningProgress,
        undefined,
        startedAt,
      );

      budgetUsage.vercelFunctionsUsed += 1;
      const chunk = await scanChunkStep({
        context,
        cursor,
        chunkTargetProducts,
      });
      budgetUsage.estimatedTransferBytes += chunk.transferBytes;
      cursor = chunk.nextCursor;
      scanCompleted = chunk.scanCompleted;
      pagesScanned += chunk.pagesScanned;
      productsFetched += chunk.productsFetched;
      budgetUsage.productsScanned = productsFetched;
      variantsConsidered += chunk.variantsConsidered;
      recordsPrepared += chunk.recordsPrepared;
      mergeExclusions(exclusions, chunk.exclusions);
      pushLimitedMany(includedSample, chunk.includedSamples, INCLUDED_SAMPLE_LIMIT);
      pushLimitedMany(validationSample, chunk.validationSamples, EXCLUDED_SAMPLE_LIMIT);
      pushLimitedMany(excludedSample, chunk.excludedSamples, EXCLUDED_SAMPLE_LIMIT);
      notePreviewExportChunkWrite();
      await appendExportChunkStep({
        exportArtifactId,
        rows: chunk.rows,
        excludedRows: chunk.excludedRows,
        validationRows: chunk.validationRows,
      });
      const chunkFingerprints = new Map<string, string>();
      for (const row of chunk.rows) {
        const key = buildDeleteTargetKey(row);
        const fingerprint = buildFeedRecordFingerprint(row);
        chunkFingerprints.set(key, fingerprint);
        seenFingerprints[key] = fingerprint;
      }

      seenKeys.push(...chunkFingerprints.keys());
      const rowsToUpsert =
        input.mode === "delta" && liveOfferFingerprints
          ? chunk.rows.filter((row) => {
              const key = buildDeleteTargetKey(row);
              const fingerprint =
                chunkFingerprints.get(key) ?? buildFeedRecordFingerprint(row);

              if (liveOfferFingerprints[key] === fingerprint) {
                unchangedRecordsSkipped += 1;
                return false;
              }

              return true;
            })
          : chunk.rows;
      const skippedThisChunk = chunk.rows.length - rowsToUpsert.length;
      const filteredChunkDeletes =
        input.mode === "delta" && liveOfferKeys
          ? filterLiveDeleteTargets({
              targets: chunk.deleteCandidates,
              samples: chunk.deleteSamples,
              liveOfferKeys,
            })
          : {
              targets: [] as MerchantDeleteTarget[],
              samples: [] as DeletePreviewSample[],
            };

      const progressBase = makeProgressSnapshot({
        input,
        startedAt,
        chunkTargetProducts,
        chunksCompleted,
        totalProducts: context.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        stage: "uploading",
        message: skippedThisChunk
          ? `Prepared ${chunk.rows.length.toLocaleString()} Merchant row(s); ${skippedThisChunk.toLocaleString()} unchanged row(s) will be skipped before writing this chunk.`
          : "Starting Merchant Center writes for the current chunk.",
        lastChunkDurationMs,
        averageChunkDurationMs,
      });
      await maybePauseForBudget(progressBase);
      if ((await getRunControlStateStep(runId)) === "stop_requested") {
        const stopped = await maybeStopForCheckpoint({
          progress: progressBase,
          stage: "scanning",
        });

        if (stopped) {
          return stopped;
        }
      }

      budgetUsage.vercelFunctionsUsed += 1;
      const upsertBatch = await upsertChunkStep({
        runId,
        startedAt,
        progressBase,
        records: rowsToUpsert,
      });
      budgetUsage.estimatedTransferBytes += upsertBatch.transferBytes;
      merchant.upsertsAttempted += upsertBatch.summary.attempted;
      merchant.upsertsSucceeded += upsertBatch.summary.succeeded;
      mergeMerchantErrors(
        merchant,
        upsertBatch.summary.errors,
        upsertBatch.summary.errorCount,
      );
      if (liveOfferKeys) {
        chunk.rows.forEach((row) => {
          liveOfferKeys.add(buildDeleteTargetKey(row));
        });
      }
      if (liveOfferFingerprints) {
        chunk.rows.forEach((row) => {
          const key = buildDeleteTargetKey(row);
          liveOfferFingerprints[key] =
            chunkFingerprints.get(key) ?? buildFeedRecordFingerprint(row);
        });
      }

      if (filteredChunkDeletes.targets.length) {
        budgetUsage.vercelFunctionsUsed += 1;
        const deleteBatch = await deleteChunkStep({
          runId,
          startedAt,
          progressBase,
          targets: filteredChunkDeletes.targets,
        });
        budgetUsage.estimatedTransferBytes += deleteBatch.transferBytes;
        merchant.deletesAttempted += deleteBatch.summary.attempted;
        merchant.deletesSucceeded += deleteBatch.summary.succeeded;
        merchant.deleteTargetKeysSucceeded.push(
          ...deleteBatch.summary.deleteTargetKeysSucceeded,
        );
        mergeMerchantErrors(
          merchant,
          deleteBatch.summary.errors,
          deleteBatch.summary.errorCount,
        );
        pushLimitedMany(
          merchant.deleteTargetsSample,
          deleteBatch.summary.deleteTargetsSample,
          EXCLUDED_SAMPLE_LIMIT,
        );
        pushLimitedUniqueDeletePreviewSamples(
          deleteSample,
          deletePreviewKeys,
          filteredChunkDeletes.samples,
        );
        if (liveOfferKeys) {
          deleteBatch.summary.deleteTargetKeysSucceeded.forEach((key) => {
            liveOfferKeys.delete(key);
          });
        }
        if (liveOfferFingerprints) {
          deleteBatch.summary.deleteTargetKeysSucceeded.forEach((key) => {
            delete liveOfferFingerprints[key];
          });
        }
      }

      chunksCompleted += 1;
      const chunkDurationStats = updateChunkDurationStats({
        chunksCompleted,
        previousAverageMs: averageChunkDurationMs,
        currentChunkMs: chunk.durationMs + upsertBatch.durationMs,
      });
      budgetUsage.chunksCompleted = chunksCompleted;
      lastChunkDurationMs = chunkDurationStats.lastChunkDurationMs;
      averageChunkDurationMs = chunkDurationStats.averageChunkDurationMs;

      const chunkCompletedProgress = makeProgressSnapshot({
        input,
        startedAt,
        chunkTargetProducts,
        chunksCompleted,
        totalProducts: context.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        stage: scanCompleted ? "uploading" : "scanning",
        message: scanCompleted
          ? "Shopify scan is complete. Finishing remaining Merchant Center cleanup."
          : `Chunk ${chunksCompleted.toLocaleString()} finished. Preparing the next Shopify chunk.`,
        lastChunkDurationMs,
        averageChunkDurationMs,
      });
      noteProgressPublish();
      await publishWorkflowEvent(
        runId,
        {
          type: "progress",
          progress: chunkCompletedProgress,
        },
        chunkCompletedProgress,
        undefined,
        startedAt,
      );
    }

    if (input.mode === "full") {
      const seenKeySet = new Set(seenKeys);
      const checkpointReconciliation = restartCheckpointPayload?.reconciliation ?? null;
      const reconciliationTargets: MerchantDeleteTarget[] =
        checkpointReconciliation &&
        checkpointReconciliation.stage !== "scanning"
          ? [...checkpointReconciliation.deleteTargets]
          : [];
      let reconciliationPageToken: string | null =
        checkpointReconciliation?.stage === "reconciling"
          ? checkpointReconciliation.pageToken
          : null;
      let merchantPagesScanned = checkpointReconciliation?.merchantPagesScanned ?? 0;
      let merchantRowsScanned = checkpointReconciliation?.merchantRowsScanned ?? 0;
      let merchantMatchedRows =
        checkpointReconciliation?.merchantMatchedRows ?? 0;
      let merchantDeleteTargets =
        checkpointReconciliation?.merchantDeleteTargets ?? 0;
      const reconciliationDeleteStartIndex =
        checkpointReconciliation?.stage === "deletes"
          ? checkpointReconciliation.deleteIndex
          : checkpointReconciliation?.stage === "pending_deletes"
            ? reconciliationTargets.length
            : 0;

      let reconcilingProgress = makeProgressSnapshot({
        input,
        startedAt,
        chunkTargetProducts,
        chunksCompleted,
        totalProducts: context.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        stage: "uploading",
        message:
          "Reconciling existing Merchant Center rows against the completed Shopify full scan.",
        merchantPhase: "reconciling",
        merchantCompleted: 0,
        merchantTotal: null,
        merchantErrors: merchant.errorCount,
        merchantPagesScanned,
        merchantRowsScanned,
        merchantMatchedRows,
        merchantDeleteTargets,
        lastChunkDurationMs,
        averageChunkDurationMs,
      });
      noteProgressPublish();
      await publishWorkflowEvent(
        runId,
        {
          type: "progress",
          progress: reconcilingProgress,
        },
        reconcilingProgress,
        undefined,
        startedAt,
      );

      if (
        checkpointReconciliation?.stage !== "deletes" &&
        checkpointReconciliation?.stage !== "pending_deletes"
      ) {
        while (true) {
          await maybePauseForBudget(reconcilingProgress);
          const reconciliationControlState = await waitForResumeIfPaused({
            runId,
            startedAt,
            progress: reconcilingProgress,
          });
          if (reconciliationControlState === "stop_requested") {
            const stopped = await maybeStopForCheckpoint({
              progress: reconcilingProgress,
              stage: "reconciling",
              reconciliationPageToken,
              merchantPagesScanned,
              merchantRowsScanned,
              merchantMatchedRows,
              merchantDeleteTargets,
              reconciliationTargets,
              reconciliationDeleteIndex: 0,
            });

            if (stopped) {
              return stopped;
            }
          }

          budgetUsage.vercelFunctionsUsed += 1;
          const page = await scanReconciliationPageStep(reconciliationPageToken);
          budgetUsage.estimatedTransferBytes += page.transferBytes;
          reconciliationPageToken = page.nextPageToken;
          merchantPagesScanned += 1;
          merchantRowsScanned += page.rowsScanned;
          merchantMatchedRows += page.matches.length;

          const pageTargets = page.matches.filter(
            (target) => !seenKeySet.has(buildDeleteTargetKey(target)),
          );
          merchantDeleteTargets += pageTargets.length;
          reconciliationTargets.push(...pageTargets);

          reconcilingProgress = makeProgressSnapshot({
            input,
            startedAt,
            chunkTargetProducts,
            chunksCompleted,
            totalProducts: context.totalProducts,
            productsScanned: productsFetched,
            pagesScanned,
            stage: "uploading",
            message: reconciliationPageToken
              ? "Reconciling Merchant Center rows against the completed Shopify full scan."
              : "Merchant reconciliation scan is complete. Preparing final delete batches.",
            merchantPhase: "reconciling",
            merchantCompleted: merchantMatchedRows,
            merchantTotal: null,
            merchantErrors: merchant.errorCount,
            merchantPagesScanned,
            merchantRowsScanned,
            merchantMatchedRows,
            merchantDeleteTargets,
            lastChunkDurationMs,
            averageChunkDurationMs,
          });
          noteProgressPublish();
          await publishWorkflowEvent(
            runId,
            {
              type: "progress",
              progress: reconcilingProgress,
            },
            reconcilingProgress,
            undefined,
            startedAt,
          );

          if (!reconciliationPageToken) {
            break;
          }
        }
      }

      merchant.existingProductsScanned = merchantMatchedRows;
      merchant.reconciliationDeletes = reconciliationTargets.length;

      for (
        let index = reconciliationDeleteStartIndex;
        index < reconciliationTargets.length;
        index += chunkTargetProducts
      ) {
        const reconciliationChunk = reconciliationTargets.slice(
          index,
          index + chunkTargetProducts,
        );
          const progressBase = makeProgressSnapshot({
            input,
            startedAt,
          chunkTargetProducts,
          chunksCompleted,
          totalProducts: context.totalProducts,
          productsScanned: productsFetched,
          pagesScanned,
          stage: "uploading",
          message:
            "Deleting Merchant Center rows missing from the completed full catalog.",
          merchantPhase: "deletes",
          merchantCompleted: index,
          merchantTotal: reconciliationTargets.length,
          merchantErrors: merchant.errorCount,
          merchantPagesScanned,
          merchantRowsScanned,
          merchantMatchedRows,
          merchantDeleteTargets,
            lastChunkDurationMs,
            averageChunkDurationMs,
          });
          await maybePauseForBudget(progressBase);
          const deleteControlState = await waitForResumeIfPaused({
            runId,
            startedAt,
            progress: progressBase,
          });
          if (deleteControlState === "stop_requested") {
            const stopped = await maybeStopForCheckpoint({
              progress: progressBase,
              stage: "deletes",
              merchantPagesScanned,
              merchantRowsScanned,
              merchantMatchedRows,
              merchantDeleteTargets,
              reconciliationTargets,
              reconciliationDeleteIndex: index,
            });

            if (stopped) {
              return stopped;
            }
          }
          budgetUsage.vercelFunctionsUsed += 1;
          const deleteBatch = await deleteChunkStep({
            runId,
            startedAt,
            progressBase,
            targets: reconciliationChunk,
          });
          budgetUsage.estimatedTransferBytes += deleteBatch.transferBytes;
          merchant.deletesAttempted += deleteBatch.summary.attempted;
        merchant.deletesSucceeded += deleteBatch.summary.succeeded;
        merchant.deleteTargetKeysSucceeded.push(
          ...deleteBatch.summary.deleteTargetKeysSucceeded,
        );
        mergeMerchantErrors(
          merchant,
          deleteBatch.summary.errors,
          deleteBatch.summary.errorCount,
        );
        pushLimitedMany(
          merchant.deleteTargetsSample,
          deleteBatch.summary.deleteTargetsSample,
          EXCLUDED_SAMPLE_LIMIT,
        );
        pushLimitedUniqueDeletePreviewSamples(
          deleteSample,
          deletePreviewKeys,
          reconciliationChunk.map((target) =>
            toDeletePreviewSample(target, "merchant_reconciliation"),
          ),
        );
      }
    }

    if (pendingDeleteScope.targets.length) {
      const progressBase = makeProgressSnapshot({
        input,
        startedAt,
        chunkTargetProducts,
        chunksCompleted,
        totalProducts: context.totalProducts,
        productsScanned: productsFetched,
        pagesScanned,
        stage: "uploading",
        message:
          "Sending Merchant delete calls for Shopify hard deletes captured from webhook events.",
        merchantPhase: "deletes",
        merchantCompleted: 0,
        merchantTotal: pendingDeleteScope.targets.length,
        merchantErrors: merchant.errorCount,
        merchantPagesScanned: 0,
        merchantRowsScanned: 0,
        merchantMatchedRows: 0,
        merchantDeleteTargets: pendingDeleteScope.targets.length,
        lastChunkDurationMs,
        averageChunkDurationMs,
      });
      await maybePauseForBudget(progressBase);
      const pendingDeleteControlState = await waitForResumeIfPaused({
        runId,
        startedAt,
        progress: progressBase,
      });
      if (pendingDeleteControlState === "stop_requested") {
        const stopped = await maybeStopForCheckpoint({
          progress: progressBase,
          stage: "pending_deletes",
          merchantDeleteTargets: pendingDeleteScope.targets.length,
        });

        if (stopped) {
          return stopped;
        }
      }
      budgetUsage.vercelFunctionsUsed += 1;
      const deleteBatch = await deleteChunkStep({
        runId,
        startedAt,
        progressBase,
        targets: pendingDeleteScope.targets,
      });
      budgetUsage.estimatedTransferBytes += deleteBatch.transferBytes;
      merchant.deletesAttempted += deleteBatch.summary.attempted;
      merchant.deletesSucceeded += deleteBatch.summary.succeeded;
      merchant.deleteTargetKeysSucceeded.push(
        ...deleteBatch.summary.deleteTargetKeysSucceeded,
      );
      mergeMerchantErrors(
        merchant,
        deleteBatch.summary.errors,
        deleteBatch.summary.errorCount,
      );
      pushLimitedMany(
        merchant.deleteTargetsSample,
        deleteBatch.summary.deleteTargetsSample,
        EXCLUDED_SAMPLE_LIMIT,
      );
      pushLimitedUniqueDeletePreviewSamples(
        deleteSample,
        deletePreviewKeys,
        pendingDeleteScope.previewSamples,
      );
      if (liveOfferKeys) {
        deleteBatch.summary.deleteTargetKeysSucceeded.forEach((key) => {
          liveOfferKeys.delete(key);
        });
      }
      if (liveOfferFingerprints) {
        deleteBatch.summary.deleteTargetKeysSucceeded.forEach((key) => {
          delete liveOfferFingerprints[key];
        });
      }

      if (deleteBatch.summary.deleteTargetKeysSucceeded.length) {
        budgetUsage.vercelFunctionsUsed += 1;
        budgetUsage.neonOpsUsed += 1;
        await removeSucceededPendingDeletesStep(
          pendingDeleteScope.targets.filter((target) =>
            deleteBatch.summary.deleteTargetKeysSucceeded.includes(
              buildDeleteTargetKey(target),
            ),
          ),
        );
      }
    }

    budgetUsage.vercelFunctionsUsed += 1;
    budgetUsage.neonOpsUsed += 2;
    const result = await persistSuccessfulRunStep({
      runId,
      input: {
        ...input,
        startedAt,
        chunkTargetProducts,
      },
      context,
      startedAt,
      exportArtifactId,
      includedSample,
      validationSample,
      excludedSample,
      deleteSample,
      productsFetched,
      pagesScanned,
      variantsConsidered,
      recordsPrepared,
      exclusions,
      merchant,
      pendingDeleteCount: pendingDeleteScope.targets.length,
      liveOfferKeys:
        input.mode === "full"
          ? Array.from(new Set(seenKeys))
          : Array.from(liveOfferKeys ?? new Set<string>()),
      liveOfferFingerprints:
        input.mode === "full" ? seenFingerprints : liveOfferFingerprints ?? {},
      unchangedRecordsSkipped,
      liveOfferIndexDataSourceName: merchantIdentity.dataSourceName,
    });

    if (
      result.ok &&
      input.mode === "delta" &&
      context.searchPlan.source === "webhook_queue" &&
      (context.searchPlan.productIds?.length ?? 0) > 0
    ) {
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 1;
      await removeSucceededPendingUpsertsStep(
        context.searchPlan.productIds ?? [],
        startedAt,
      );
    }
    const completionProgress = makeProgressSnapshot({
      input,
      startedAt,
      chunkTargetProducts,
      chunksCompleted,
      totalProducts: context.totalProducts,
      productsScanned: productsFetched,
      pagesScanned,
      stage: "complete",
      message: result.ok
        ? "Chunked live sync completed successfully."
        : "Chunked live sync completed with Merchant API write errors.",
      merchantErrors: merchant.errorCount,
      lastChunkDurationMs,
      averageChunkDurationMs,
    });
    noteProgressPublish();
    await publishWorkflowEvent(
      runId,
      {
        type: "progress",
        progress: completionProgress,
      },
      completionProgress,
      result.ok ? "completed" : "failed",
      startedAt,
    );
    await publishWorkflowEvent(
      runId,
      {
        type: "result",
        result: {
          ok: result.ok,
          finishedAt: result.finishedAt,
          message: completionProgress.message,
        },
      },
      undefined,
      result.ok ? "completed" : "failed",
    );
    budgetUsage.vercelFunctionsUsed += 1;
    budgetUsage.neonOpsUsed += 1;
    await cleanupActiveRunStep(runId);

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown chunked sync execution error.";
    budgetUsage.vercelFunctionsUsed += 1;
    budgetUsage.neonOpsUsed += 2;
    const failure = await persistFailedRunStep({
      runId,
      input: {
        ...input,
        startedAt,
        chunkTargetProducts,
      },
      context,
      startedAt,
      exportArtifactId,
      message,
    });
    await publishWorkflowEvent(
      runId,
      {
        type: "result",
        result: {
          ok: false,
          finishedAt: failure.finishedAt,
          message,
        },
      },
      undefined,
      "failed",
    );
    budgetUsage.vercelFunctionsUsed += 1;
    budgetUsage.neonOpsUsed += 1;
    await cleanupActiveRunStep(runId);
    return failure;
  }
}
