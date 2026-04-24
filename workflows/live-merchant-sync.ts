import { getWorkflowMetadata, getWritable, sleep } from "workflow";
import type {
  MerchantCatalogSyncSummary,
  MerchantDeleteTarget,
  MerchantSyncError,
} from "@/lib/google-merchant";
import type {
  ActiveSyncRunState,
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
  allowDeltaFallback?: boolean;
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

    if (controlState === "running") {
      return;
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
    effectiveNow: input.startedAt ? new Date(input.startedAt) : undefined,
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

async function requestBudgetPauseStep(runId: string, message: string) {
  "use step";
  const { updateActiveSyncRun } = await import("@/lib/operator-store");
  await updateActiveSyncRun(runId, {
    controlState: "pause_requested",
    message,
  });
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
  const chunkTargetProducts = Math.max(
    1,
    input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET,
  );
  const exportArtifactId = `live-sync-${input.mode}-${startedAt.replaceAll(":", "-")}`;
  let context: SyncExecutionContext | null = null;
  const budgetUsage = createBudgetUsage({
    ...input,
    startedAt,
    chunkTargetProducts,
  });

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
    await initializeExportArtifactStep({
      exportArtifactId,
      input,
      startedAt,
      context,
    });
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
    budgetUsage.totalProducts = context.totalProducts;
    budgetUsage.vercelFunctionsUsed += input.mode === "delta" ? 5 : 4;
    budgetUsage.neonOpsUsed += input.mode === "delta" ? 5 : 4;

    const buildBudgetSnapshot = () => {
      budgetUsage.elapsedMs = Math.max(0, Date.now() - Date.parse(startedAt));
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

    const maybePauseForBudget = async (
      progress: LiveMerchantSyncWorkflowProgress,
    ) => {
      if (progress.budget?.status !== "pause_requested") {
        return;
      }

      const pauseMessage = progress.budget.pauseReason ?? progress.budget.summary;
      budgetUsage.vercelFunctionsUsed += 1;
      budgetUsage.neonOpsUsed += 1;
      await requestBudgetPauseStep(runId, pauseMessage);

      const pauseProgress = {
        ...progress,
        controlState: "pause_requested" as const,
        message: pauseMessage,
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
      await waitForResumeIfPaused({
        runId,
        startedAt,
        progress: pauseProgress,
      });
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
      await waitForResumeIfPaused({
        runId,
        startedAt,
        progress: scanningProgress,
      });
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
      const reconciliationTargets: MerchantDeleteTarget[] = [];
      let reconciliationPageToken: string | null = null;
      let merchantPagesScanned = 0;
      let merchantRowsScanned = 0;
      let merchantMatchedRows = 0;
      let merchantDeleteTargets = 0;

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

      while (true) {
        await maybePauseForBudget(reconcilingProgress);
        await waitForResumeIfPaused({
          runId,
          startedAt,
          progress: reconcilingProgress,
        });
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

      merchant.existingProductsScanned = merchantMatchedRows;
      merchant.reconciliationDeletes = reconciliationTargets.length;

      for (
        let index = 0;
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
          await waitForResumeIfPaused({
            runId,
            startedAt,
            progress: progressBase,
          });
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
      await waitForResumeIfPaused({
        runId,
        startedAt,
        progress: progressBase,
      });
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
