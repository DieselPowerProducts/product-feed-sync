import { getWorkflowMetadata } from "workflow";
import type {
  PendingShopifyDeleteRecord,
  SyncHistoryPurpose,
  SyncSettings,
} from "@/lib/operator-store";
import type {
  DeletePreviewSample,
  ExcludedPreviewSample,
  FeedPreviewRecord,
  SyncExecutionContext,
  SyncExportResult,
  SyncRunArtifact,
  SyncRunResult,
} from "@/lib/sync";
import { getConfigurationStatus } from "@/lib/env";

const DEFAULT_PREVIEW_LIMIT = 5;
const LIVE_SYNC_CHUNK_PRODUCT_TARGET = 1500;
const INCLUDED_SAMPLE_LIMIT = 50;
const EXCLUDED_SAMPLE_LIMIT = 250;

export interface TestSaveExportWorkflowInput {
  mode: "delta" | "full";
  trigger: "manual";
  purpose?: SyncHistoryPurpose;
  settings: SyncSettings;
  chunkTargetProducts?: number;
  startedAt?: string;
}

type PendingDeleteTarget = {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  reason: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string | null;
};

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

function toPendingDeleteTarget(record: PendingShopifyDeleteRecord): PendingDeleteTarget {
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
    artifactId,
    exportArtifactId: result.exportArtifactId ?? null,
    notes: result.notes.slice(0, 8),
    stats: result.stats,
  };
}

async function loadExecutionContextStep(input: TestSaveExportWorkflowInput) {
  "use step";
  const { prepareSyncExecutionContext } = await import("@/lib/sync");
  return prepareSyncExecutionContext({
    mode: input.mode,
    settings: input.settings,
    dryRun: true,
    effectiveNow: input.startedAt ? new Date(input.startedAt) : undefined,
    allowDeltaFallback: true,
  });
}

async function loadPendingDeleteScopeStep() {
  "use step";
  const { getPendingShopifyDeletes } = await import("@/lib/operator-store");
  const records = await getPendingShopifyDeletes();

  return {
    targets: records.map(toPendingDeleteTarget),
    previewSamples: records.map(toPendingDeletePreviewSample),
  };
}

async function initializeExportArtifactStep(params: {
  exportArtifactId: string;
  mode: "delta" | "full";
  startedAt: string;
  context: SyncExecutionContext;
}) {
  "use step";
  const { writePreviewExportArtifact } = await import("@/lib/operator-store");

  await writePreviewExportArtifact(params.exportArtifactId, {
    ok: true,
    mode: params.mode,
    dryRun: true,
    exhaustive: true,
    startedAt: params.startedAt,
    finishedAt: params.startedAt,
    notes: ["Test-save export is running in chunked mode."],
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
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
  const { scanSyncExecutionChunk } = await import("@/lib/sync");
  return scanSyncExecutionChunk({
    context: params.context,
    cursor: params.cursor,
    maxProducts: params.chunkTargetProducts,
    artifactSampleLimit: INCLUDED_SAMPLE_LIMIT,
    collectAllRecords: true,
    captureDeleteCandidates: true,
  });
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

async function persistSuccessfulTestSaveStep(params: {
  input: TestSaveExportWorkflowInput;
  context: SyncExecutionContext;
  startedAt: string;
  exportArtifactId: string;
  includedSample: FeedPreviewRecord[];
  validationSample: ExcludedPreviewSample[];
  excludedSample: ExcludedPreviewSample[];
  deleteSample: DeletePreviewSample[];
  pagesScanned: number;
  productsFetched: number;
  variantsConsidered: number;
  recordsPrepared: number;
  exclusions: Record<string, number>;
  pendingDeleteCount: number;
}) {
  "use step";
  const { buildSyncNotes, buildSyncScope, countValidationIssues } = await import(
    "@/lib/sync"
  );
  const {
    appendSyncHistory,
    writeRunArtifact,
    readPreviewExportArtifact,
    writePreviewExportArtifact,
  } = await import("@/lib/operator-store");

  const validationIssues = countValidationIssues(params.exclusions);
  const notes = buildSyncNotes({
    dryRun: true,
    exhaustive: true,
    previewLimit: DEFAULT_PREVIEW_LIMIT,
    scanCompleted: true,
    validationIssues,
    searchNotes: params.context.searchNotes,
    merchant: null,
    testSavePurpose: true,
  });
  notes.push(
    `Test-save export ran in chunked mode with a target of ${params.input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET} Shopify products per chunk.`,
  );
  if (params.pendingDeleteCount > 0) {
    notes.unshift(
      `${params.pendingDeleteCount} hard-deleted Shopify variant(s) were also included in the delete sample for QA context.`,
    );
  }

  const exportArtifact = (await readPreviewExportArtifact<SyncExportResult>(
    params.exportArtifactId,
  )) ?? {
    rows: [],
    excludedRows: [],
    validationRows: [],
  };

  const finalizedExport = {
    ok: true,
    mode: params.input.mode,
    dryRun: true,
    exhaustive: true,
    startedAt: params.startedAt,
    finishedAt: new Date().toISOString(),
    notes,
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
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
    },
    exclusions: params.exclusions,
    rows: exportArtifact.rows ?? [],
    excludedRows: exportArtifact.excludedRows ?? [],
    validationRows: exportArtifact.validationRows ?? [],
  } satisfies SyncExportResult;

  const result = {
    ok: true,
    trigger: params.input.trigger,
    purpose: params.input.purpose ?? "test-save",
    mode: params.input.mode,
    dryRun: true,
    exhaustive: true,
    scope: buildSyncScope(
      params.input.mode,
      params.context.searchPlan,
      params.input.settings,
      true,
    ),
    startedAt: params.startedAt,
    finishedAt: finalizedExport.finishedAt,
    configuration: getConfigurationStatus(),
    notes,
    query: params.context.query,
    lookbackStart: params.context.lookbackStart,
    storefrontBaseUrl: params.context.storefrontBaseUrl,
    stats: finalizedExport.stats,
    exclusions: params.exclusions,
    preview: params.includedSample.slice(0, DEFAULT_PREVIEW_LIMIT),
    exportArtifactId: params.exportArtifactId,
    deleteSample: params.deleteSample,
    merchant: null,
  } satisfies SyncRunResult;

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
    exportArtifactId: result.exportArtifactId ?? null,
    notes: result.notes,
    stats: result.stats,
    includedSample: params.includedSample,
    validationSample: params.validationSample,
    excludedSample: params.excludedSample,
    deleteSample: params.deleteSample,
    merchant: null,
  };

  await writeRunArtifact(artifactId, artifact);
  await appendSyncHistory(toHistoryEntry(result, artifactId));

  return result;
}

async function persistFailedTestSaveStep(params: {
  input: TestSaveExportWorkflowInput;
  context: SyncExecutionContext | null;
  startedAt: string;
  exportArtifactId: string | null;
  message: string;
}) {
  "use step";
  const { buildSyncScope } = await import("@/lib/sync");
  const {
    appendSyncHistory,
    writeRunArtifact,
    deletePreviewExportArtifact,
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
        ? "All Shopify products are scanned across active, draft, and archived statuses for a dry-run QA export."
        : "Shopify products changed after the last successful live sync are scanned exhaustively for a dry-run QA export.";

  const result = {
    ok: false,
    trigger: params.input.trigger,
    purpose: params.input.purpose ?? "test-save",
    mode: params.input.mode,
    dryRun: true,
    exhaustive: true,
    scope,
    startedAt: params.startedAt,
    finishedAt: new Date().toISOString(),
    configuration: getConfigurationStatus(),
    notes: [
      ...(params.context?.searchNotes ?? []),
      `Chunked test-save export failed: ${params.message}`,
      "No Merchant Center writes were attempted because this run stayed in dry-run mode.",
    ],
    query: params.context?.query ?? "",
    lookbackStart: params.context?.lookbackStart ?? null,
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
    exportArtifactId: null,
    notes: result.notes,
    stats: result.stats,
    includedSample: [],
    validationSample: [],
    excludedSample: [],
    deleteSample: [],
    merchant: null,
  };

  await writeRunArtifact(artifactId, artifact);
  await appendSyncHistory(toHistoryEntry(result, artifactId));

  return result;
}

async function markActiveRunRunningStep(runId: string, message: string) {
  "use step";
  const { updateActiveSyncRun } = await import("@/lib/operator-store");
  await updateActiveSyncRun(runId, {
    status: "running",
    message,
  });
}

async function clearActiveRunStep(runId: string) {
  "use step";
  const { clearActiveSyncRun } = await import("@/lib/operator-store");
  await clearActiveSyncRun(runId);
}

export async function testSaveExportWorkflow(
  input: TestSaveExportWorkflowInput,
): Promise<SyncRunResult> {
  "use workflow";

  const metadata = getWorkflowMetadata();
  const runId = metadata.workflowRunId;
  const startedAt = input.startedAt ?? metadata.workflowStartedAt.toISOString();
  const chunkTargetProducts = Math.max(
    1,
    input.chunkTargetProducts ?? LIVE_SYNC_CHUNK_PRODUCT_TARGET,
  );
  const exportArtifactId = `test-save-${input.mode}-${startedAt.replaceAll(":", "-")}`;
  let context: SyncExecutionContext | null = null;

  try {
    await markActiveRunRunningStep(
      runId,
      input.mode === "full"
        ? "Building chunked full test-save export."
        : "Building chunked delta test-save export.",
    );
    context = await loadExecutionContextStep({
      ...input,
      startedAt,
      chunkTargetProducts,
    });
    const pendingDeleteScope = await loadPendingDeleteScopeStep();
    await initializeExportArtifactStep({
      exportArtifactId,
      mode: input.mode,
      startedAt,
      context,
    });

    const includedSample: FeedPreviewRecord[] = [];
    const validationSample: ExcludedPreviewSample[] = [];
    const excludedSample: ExcludedPreviewSample[] = [];
    const deleteSample: DeletePreviewSample[] = [];
    const exclusions: Record<string, number> = {};
    let cursor: string | null = null;
    let scanCompleted = false;
    let pagesScanned = 0;
    let productsFetched = 0;
    let variantsConsidered = 0;
    let recordsPrepared = 0;

    while (!scanCompleted) {
      const chunk = await scanChunkStep({
        context,
        cursor,
        chunkTargetProducts,
      });
      cursor = chunk.nextCursor;
      scanCompleted = chunk.scanCompleted;
      pagesScanned += chunk.pagesScanned;
      productsFetched += chunk.productsFetched;
      variantsConsidered += chunk.variantsConsidered;
      recordsPrepared += chunk.recordsPrepared;
      mergeExclusions(exclusions, chunk.exclusions);
      pushLimitedMany(includedSample, chunk.includedSamples, INCLUDED_SAMPLE_LIMIT);
      pushLimitedMany(validationSample, chunk.validationSamples, EXCLUDED_SAMPLE_LIMIT);
      pushLimitedMany(excludedSample, chunk.excludedSamples, EXCLUDED_SAMPLE_LIMIT);
      pushLimitedMany(deleteSample, chunk.deleteSamples, EXCLUDED_SAMPLE_LIMIT);

      await appendExportChunkStep({
        exportArtifactId,
        rows: chunk.rows,
        excludedRows: chunk.excludedRows,
        validationRows: chunk.validationRows,
      });
    }

    pushLimitedMany(
      deleteSample,
      pendingDeleteScope.previewSamples,
      EXCLUDED_SAMPLE_LIMIT,
    );

    const result = await persistSuccessfulTestSaveStep({
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
      pagesScanned,
      productsFetched,
      variantsConsidered,
      recordsPrepared,
      exclusions,
      pendingDeleteCount: pendingDeleteScope.targets.length,
    });
    await clearActiveRunStep(runId);
    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown chunked test-save export error.";

    const result = await persistFailedTestSaveStep({
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
    await clearActiveRunStep(runId);
    return result;
  }
}
