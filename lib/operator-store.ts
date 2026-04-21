import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
import { env } from "@/lib/env";
import {
  deleteNeonObject,
  isNeonConfigured,
  readNeonObject,
  writeNeonObject,
} from "@/lib/neon";

const STATE_BLOB_PATH = "dpp-product-feed-sync/operator-state.json";
const RUN_ARTIFACT_BLOB_PREFIX = "dpp-product-feed-sync/run-artifacts";
const PREVIEW_EXPORT_BLOB_PREFIX = "dpp-product-feed-sync/preview-exports";
const LOCAL_STATE_PATH = path.join(
  process.cwd(),
  ".local-state",
  "operator-state.json",
);
const LOCAL_RUN_ARTIFACT_DIR = path.join(
  process.cwd(),
  ".local-state",
  "run-artifacts",
);
const LOCAL_PREVIEW_EXPORT_DIR = path.join(
  process.cwd(),
  ".local-state",
  "preview-exports",
);
const NEON_STATE_KEY = "state";
const NEON_STATE_KIND = "operator-state";
const NEON_RUN_ARTIFACT_PREFIX = "run-artifact";
const NEON_PREVIEW_EXPORT_PREFIX = "preview-export";
const HISTORY_LIMIT = 50;
const RETAINED_SCHEDULED_SYNC_EXPORTS_PER_MODE = 2;
const PENDING_DELETE_LIMIT = 5000;

export type SyncHistoryPurpose = "sync" | "test-save";

export interface SyncSettings {
  anchorDate: string;
  deltaIntervalDays: number;
  fullIntervalDays: number;
  updatedAt: string;
}

export interface SyncHistoryEntry {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  purpose: SyncHistoryPurpose | null;
  mode: "delta" | "full";
  dryRun: boolean;
  ok: boolean;
  scope: string;
  query: string;
  lookbackStart: string | null;
  artifactId?: string | null;
  exportArtifactId?: string | null;
  notes: string[];
  stats: {
    pageSize: number;
    pagesScanned: number;
    scanCompleted?: boolean;
    totalProducts?: number | null;
    productsFetched: number;
    variantsConsidered: number;
    recordsPrepared: number;
    excluded: number;
    validationIssues?: number;
    previewLimit: number;
  };
}

export interface PendingShopifyDeleteRecord {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  reason: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string | null;
  handle: string;
  sku: string | null;
  link?: string | null;
  queuedAt: string;
  source: "shopify_webhook";
  webhookId?: string | null;
  shopDomain?: string | null;
}

export interface ActiveSyncRunState {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: "cron" | "manual";
  purpose: SyncHistoryPurpose;
  mode: "delta" | "full";
  status: "queued" | "running" | "completed" | "failed";
  controlState: "running" | "pause_requested" | "paused";
  chunkTargetProducts: number;
  chunksCompleted: number;
  message: string;
  totalProducts: number | null;
  productsScanned: number;
  pagesScanned: number;
  merchantPhase: "reconciling" | "upserts" | "deletes" | null;
  merchantCompleted: number;
  merchantTotal: number | null;
  merchantPagesScanned: number;
  merchantRowsScanned: number;
  merchantMatchedRows: number;
  merchantDeleteTargets: number;
  lastChunkDurationMs: number | null;
  averageChunkDurationMs: number | null;
}

interface BootstrapState {
  firstFullSyncCompletedAt: string | null;
}

interface OperatorState {
  settings: SyncSettings;
  history: SyncHistoryEntry[];
  pendingDeletes: PendingShopifyDeleteRecord[];
  bootstrap: BootstrapState;
  activeSyncRun: ActiveSyncRunState | null;
}

type StorageMode = "neon" | "blob" | "local" | "memory";

declare global {
  var __dppOperatorState: OperatorState | undefined;
  var __dppRunArtifacts: Record<string, unknown> | undefined;
}

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultSettings(): SyncSettings {
  return {
    anchorDate: env.syncAnchorDate,
    deltaIntervalDays: readPositiveInteger(env.deltaIntervalDays, 7),
    fullIntervalDays: readPositiveInteger(env.fullIntervalDays, 15),
    updatedAt: new Date().toISOString(),
  };
}

function defaultState(): OperatorState {
  return {
    settings: defaultSettings(),
    history: [],
    pendingDeletes: [],
    bootstrap: {
      firstFullSyncCompletedAt: null,
    },
    activeSyncRun: null,
  };
}

function deriveFirstFullSyncCompletedAt(history: SyncHistoryEntry[]) {
  const matchingEntry = [...history]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .find(
      (entry) =>
        entry.ok &&
        !entry.dryRun &&
        entry.purpose === "sync" &&
        entry.mode === "full",
    );

  return matchingEntry?.finishedAt ?? null;
}

function sanitizeSettings(input: Partial<SyncSettings> | null | undefined) {
  const defaults = defaultSettings();

  return {
    anchorDate:
      input?.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate)
        ? input.anchorDate
        : defaults.anchorDate,
    deltaIntervalDays: readPositiveInteger(
      Number(input?.deltaIntervalDays),
      defaults.deltaIntervalDays,
    ),
    fullIntervalDays: readPositiveInteger(
      Number(input?.fullIntervalDays),
      defaults.fullIntervalDays,
    ),
    updatedAt: input?.updatedAt ?? defaults.updatedAt,
  } satisfies SyncSettings;
}

function sanitizeState(input: Partial<OperatorState> | null | undefined) {
  const history = Array.isArray(input?.history)
    ? input.history.slice(0, HISTORY_LIMIT).map((entry) => ({
        ...entry,
        purpose:
          entry.purpose === "sync" || entry.purpose === "test-save"
            ? entry.purpose
            : null,
        artifactId: entry.artifactId ?? null,
        exportArtifactId: entry.exportArtifactId ?? null,
        notes: Array.isArray(entry.notes) ? entry.notes.slice(0, 8) : [],
        stats: {
          ...entry.stats,
          validationIssues: entry.stats?.validationIssues ?? 0,
        },
      }))
    : [];

  return {
    settings: sanitizeSettings(input?.settings),
    history,
    pendingDeletes: Array.isArray(input?.pendingDeletes)
      ? input.pendingDeletes
          .slice(0, PENDING_DELETE_LIMIT)
          .map((entry) => ({
            offerId: entry.offerId,
            contentLanguage: entry.contentLanguage,
            feedLabel: entry.feedLabel,
            reason: entry.reason ?? "shopify_hard_delete",
            productId: entry.productId,
            variantId: entry.variantId,
            title: entry.title ?? "",
            variantTitle: entry.variantTitle ?? null,
            handle: entry.handle ?? "",
            sku: entry.sku ?? null,
            link: entry.link ?? null,
            queuedAt: entry.queuedAt ?? new Date().toISOString(),
            source: "shopify_webhook",
            webhookId: entry.webhookId ?? null,
            shopDomain: entry.shopDomain ?? null,
          }))
      : [],
    bootstrap: {
      firstFullSyncCompletedAt:
        input?.bootstrap?.firstFullSyncCompletedAt ??
        deriveFirstFullSyncCompletedAt(history),
    },
    activeSyncRun:
      input?.activeSyncRun &&
      (input.activeSyncRun.mode === "delta" || input.activeSyncRun.mode === "full")
        ? {
            runId: input.activeSyncRun.runId,
            startedAt: input.activeSyncRun.startedAt ?? new Date().toISOString(),
            finishedAt: input.activeSyncRun.finishedAt ?? null,
            trigger:
              input.activeSyncRun.trigger === "cron" ? "cron" : "manual",
            purpose:
              input.activeSyncRun.purpose === "test-save" ? "test-save" : "sync",
            mode: input.activeSyncRun.mode,
            status:
              input.activeSyncRun.status === "queued" ||
              input.activeSyncRun.status === "running" ||
              input.activeSyncRun.status === "completed" ||
              input.activeSyncRun.status === "failed"
                ? input.activeSyncRun.status
                : "queued",
            controlState:
              input.activeSyncRun.controlState === "pause_requested" ||
              input.activeSyncRun.controlState === "paused"
                ? input.activeSyncRun.controlState
                : "running",
            chunkTargetProducts: readPositiveInteger(
              Number(input.activeSyncRun.chunkTargetProducts),
              1,
            ),
            chunksCompleted: Math.max(
              0,
              Number(input.activeSyncRun.chunksCompleted ?? 0),
            ),
            message: input.activeSyncRun.message ?? "",
            totalProducts:
              typeof input.activeSyncRun.totalProducts === "number"
                ? input.activeSyncRun.totalProducts
                : null,
            productsScanned: Math.max(
              0,
              Number(input.activeSyncRun.productsScanned ?? 0),
            ),
            pagesScanned: Math.max(
              0,
              Number(input.activeSyncRun.pagesScanned ?? 0),
            ),
            merchantPhase:
              input.activeSyncRun.merchantPhase === "reconciling" ||
              input.activeSyncRun.merchantPhase === "upserts" ||
              input.activeSyncRun.merchantPhase === "deletes"
                ? input.activeSyncRun.merchantPhase
                : null,
            merchantCompleted: Math.max(
              0,
              Number(input.activeSyncRun.merchantCompleted ?? 0),
            ),
            merchantTotal:
              typeof input.activeSyncRun.merchantTotal === "number"
                ? input.activeSyncRun.merchantTotal
                : null,
            merchantPagesScanned: Math.max(
              0,
              Number(input.activeSyncRun.merchantPagesScanned ?? 0),
            ),
            merchantRowsScanned: Math.max(
              0,
              Number(input.activeSyncRun.merchantRowsScanned ?? 0),
            ),
            merchantMatchedRows: Math.max(
              0,
              Number(input.activeSyncRun.merchantMatchedRows ?? 0),
            ),
            merchantDeleteTargets: Math.max(
              0,
              Number(input.activeSyncRun.merchantDeleteTargets ?? 0),
            ),
            lastChunkDurationMs:
              typeof input.activeSyncRun.lastChunkDurationMs === "number" &&
              Number.isFinite(input.activeSyncRun.lastChunkDurationMs)
                ? input.activeSyncRun.lastChunkDurationMs
                : null,
            averageChunkDurationMs:
              typeof input.activeSyncRun.averageChunkDurationMs === "number" &&
              Number.isFinite(input.activeSyncRun.averageChunkDurationMs)
                ? input.activeSyncRun.averageChunkDurationMs
                : null,
          }
        : null,
  } satisfies OperatorState;
}

function buildPendingDeleteKey(
  target: Pick<PendingShopifyDeleteRecord, "contentLanguage" | "feedLabel" | "offerId">,
) {
  return `${target.contentLanguage}~${target.feedLabel}~${target.offerId}`;
}

function getRunArtifactBlobPath(id: string) {
  return `${RUN_ARTIFACT_BLOB_PREFIX}/${id}.json`;
}

function getLocalRunArtifactPath(id: string) {
  return path.join(LOCAL_RUN_ARTIFACT_DIR, `${id}.json`);
}

function getPreviewExportBlobPath(id: string) {
  return `${PREVIEW_EXPORT_BLOB_PREFIX}/${id}.json`;
}

function getLocalPreviewExportPath(id: string) {
  return path.join(LOCAL_PREVIEW_EXPORT_DIR, `${id}.json`);
}

function getNeonRunArtifactKey(id: string) {
  return `${NEON_RUN_ARTIFACT_PREFIX}:${id}`;
}

function getNeonPreviewExportKey(id: string) {
  return `${NEON_PREVIEW_EXPORT_PREFIX}:${id}`;
}

function getStateStorageMode(): StorageMode {
  if (isNeonConfigured()) {
    return "neon";
  }

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return "blob";
  }

  return process.env.NODE_ENV === "production" ? "memory" : "local";
}

function getPreviewExportStorageMode(): StorageMode {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return "blob";
  }

  if (isNeonConfigured()) {
    return "neon";
  }

  return process.env.NODE_ENV === "production" ? "memory" : "local";
}

function safeJsonParse<T>(
  raw: string,
  fallback: T,
  label: string,
) {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`[operator-store] Failed to parse ${label}.`, error);
    return fallback;
  }
}

async function readNeonStateRaw() {
  const state = await readNeonObject<Partial<OperatorState>>(NEON_STATE_KEY);
  return state ? sanitizeState(state) : null;
}

async function readFallbackStateForNeon() {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return readBlobState();
  }

  if (process.env.NODE_ENV !== "production") {
    return readLocalState();
  }

  return readMemoryState();
}

async function readNeonState() {
  const existing = await readNeonStateRaw();

  if (existing) {
    return existing;
  }

  const fallbackState = await readFallbackStateForNeon();
  await writeNeonState(fallbackState);
  return fallbackState;
}

async function writeNeonState(state: OperatorState) {
  await writeNeonObject(NEON_STATE_KEY, NEON_STATE_KIND, state);
}

async function readNeonArtifact<T>(id: string) {
  return readNeonObject<T>(getNeonRunArtifactKey(id));
}

async function writeNeonArtifact(id: string, artifact: unknown) {
  await writeNeonObject(
    getNeonRunArtifactKey(id),
    NEON_RUN_ARTIFACT_PREFIX,
    artifact,
  );
}

async function deleteNeonArtifact(id: string) {
  await deleteNeonObject(getNeonRunArtifactKey(id));
}

async function readBlobState() {
  const result = await get(STATE_BLOB_PATH, {
    access: "private",
    useCache: false,
  });

  if (!result || result.statusCode !== 200) {
    return defaultState();
  }

  const text = await new Response(result.stream).text();
  return sanitizeState(
    safeJsonParse<Partial<OperatorState>>(text, defaultState(), STATE_BLOB_PATH),
  );
}

async function writeBlobState(state: OperatorState) {
  await put(STATE_BLOB_PATH, JSON.stringify(state, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

async function readBlobArtifact<T>(id: string) {
  const result = await get(getRunArtifactBlobPath(id), {
    access: "private",
    useCache: false,
  });

  if (!result || result.statusCode !== 200) {
    return null;
  }

  const text = await new Response(result.stream).text();
  return safeJsonParse<T | null>(
    text,
    null,
    getRunArtifactBlobPath(id),
  );
}

async function writeBlobArtifact(id: string, artifact: unknown) {
  await put(getRunArtifactBlobPath(id), JSON.stringify(artifact, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

async function deleteBlobArtifact(id: string) {
  try {
    await del(getRunArtifactBlobPath(id));
  } catch {
    // Ignore missing artifacts so delete remains idempotent.
  }
}

async function readLocalState() {
  try {
    const raw = await readFile(LOCAL_STATE_PATH, "utf8");
    return sanitizeState(
      safeJsonParse<Partial<OperatorState>>(raw, defaultState(), LOCAL_STATE_PATH),
    );
  } catch {
    return defaultState();
  }
}

async function writeLocalState(state: OperatorState) {
  await mkdir(path.dirname(LOCAL_STATE_PATH), { recursive: true });
  await writeFile(LOCAL_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function readLocalArtifact<T>(id: string) {
  try {
    const raw = await readFile(getLocalRunArtifactPath(id), "utf8");
    return safeJsonParse<T | null>(raw, null, getLocalRunArtifactPath(id));
  } catch {
    return null;
  }
}

async function writeLocalArtifact(id: string, artifact: unknown) {
  await mkdir(LOCAL_RUN_ARTIFACT_DIR, { recursive: true });
  await writeFile(
    getLocalRunArtifactPath(id),
    JSON.stringify(artifact, null, 2),
    "utf8",
  );
}

async function deleteLocalArtifact(id: string) {
  try {
    await unlink(getLocalRunArtifactPath(id));
  } catch {
    // Ignore missing artifacts so delete remains idempotent.
  }
}

async function readMemoryState() {
  return globalThis.__dppOperatorState ?? defaultState();
}

async function writeMemoryState(state: OperatorState) {
  globalThis.__dppOperatorState = state;
}

async function readMemoryArtifact<T>(id: string) {
  return (globalThis.__dppRunArtifacts?.[id] as T | undefined) ?? null;
}

async function writeMemoryArtifact(id: string, artifact: unknown) {
  if (!globalThis.__dppRunArtifacts) {
    globalThis.__dppRunArtifacts = {};
  }

  globalThis.__dppRunArtifacts[id] = artifact;
}

async function deleteMemoryArtifact(id: string) {
  if (!globalThis.__dppRunArtifacts) {
    return;
  }

  delete globalThis.__dppRunArtifacts[id];
}

async function readState() {
  const mode = getStateStorageMode();

  if (mode === "neon") {
    return readNeonState();
  }

  if (mode === "blob") {
    return readBlobState();
  }

  if (mode === "local") {
    return readLocalState();
  }

  return readMemoryState();
}

async function writeState(state: OperatorState) {
  const normalized = sanitizeState(state);
  const mode = getStateStorageMode();

  if (mode === "neon") {
    await writeNeonState(normalized);
    return;
  }

  if (mode === "blob") {
    await writeBlobState(normalized);
    return;
  }

  if (mode === "local") {
    await writeLocalState(normalized);
    return;
  }

  await writeMemoryState(normalized);
}

export function getOperatorStoreStatus() {
  const mode = getStateStorageMode();

  return {
    mode,
    persistent: mode === "neon" || mode === "blob" || mode === "local",
    configured: mode === "neon" || mode === "blob",
  };
}

export async function getSyncSettings() {
  const state = await readState();
  return sanitizeSettings(state.settings);
}

export async function saveSyncSettings(input: Partial<SyncSettings>) {
  const state = await readState();
  const settings = sanitizeSettings({
    ...state.settings,
    ...input,
    updatedAt: new Date().toISOString(),
  });

  await writeState({
    ...state,
    settings,
  });

  return settings;
}

export async function getSyncHistory(limit = 20) {
  const state = await readState();

  return [...state.history]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

export async function getBootstrapState() {
  const state = await readState();
  return {
    firstFullSyncCompletedAt: state.bootstrap.firstFullSyncCompletedAt,
  };
}

export async function getActiveSyncRun() {
  const state = await readState();
  return state.activeSyncRun;
}

export async function setActiveSyncRun(run: ActiveSyncRunState) {
  const state = await readState();

  await writeState({
    ...state,
    activeSyncRun: run,
  });

  return run;
}

export async function updateActiveSyncRun(
  runId: string,
  patch: Partial<ActiveSyncRunState>,
) {
  const state = await readState();

  if (!state.activeSyncRun || state.activeSyncRun.runId !== runId) {
    return null;
  }

  const activeSyncRun = {
    ...state.activeSyncRun,
    ...patch,
    runId,
  } satisfies ActiveSyncRunState;

  await writeState({
    ...state,
    activeSyncRun,
  });

  return activeSyncRun;
}

export async function clearActiveSyncRun(runId: string) {
  const state = await readState();

  if (!state.activeSyncRun || state.activeSyncRun.runId !== runId) {
    return false;
  }

  await writeState({
    ...state,
    activeSyncRun: null,
  });

  return true;
}

export async function getPendingShopifyDeletes() {
  const state = await readState();

  return [...state.pendingDeletes].sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt),
  );
}

export async function appendPendingShopifyDeletes(
  entries: PendingShopifyDeleteRecord[],
) {
  if (!entries.length) {
    return [];
  }

  const state = await readState();
  const pendingByKey = new Map(
    state.pendingDeletes.map((entry) => [buildPendingDeleteKey(entry), entry]),
  );

  for (const entry of entries) {
    pendingByKey.set(buildPendingDeleteKey(entry), entry);
  }

  const pendingDeletes = Array.from(pendingByKey.values())
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
    .slice(0, PENDING_DELETE_LIMIT);

  await writeState({
    ...state,
    pendingDeletes,
  });

  return pendingDeletes;
}

export async function removePendingShopifyDeletes(
  targets: Array<
    Pick<PendingShopifyDeleteRecord, "contentLanguage" | "feedLabel" | "offerId">
  >,
) {
  if (!targets.length) {
    return [];
  }

  const state = await readState();
  const keysToRemove = new Set(targets.map((target) => buildPendingDeleteKey(target)));
  const removed: PendingShopifyDeleteRecord[] = [];
  const pendingDeletes = state.pendingDeletes.filter((entry) => {
    if (!keysToRemove.has(buildPendingDeleteKey(entry))) {
      return true;
    }

    removed.push(entry);
    return false;
  });

  if (removed.length) {
    await writeState({
      ...state,
      pendingDeletes,
    });
  }

  return removed;
}

export async function getLatestSuccessfulLiveSyncHistory() {
  const state = await readState();

  return (
    [...state.history]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .find(
        (entry) =>
          entry.ok &&
          !entry.dryRun &&
          entry.purpose === "sync" &&
          (entry.mode === "delta" || entry.mode === "full"),
      ) ?? null
  );
}

export async function seedSuccessfulLiveSyncBaseline(params: {
  startedAt: string;
  finishedAt?: string;
  recordsPrepared?: number | null;
  notes?: string[];
}) {
  const state = await readState();
  const existingBaseline =
    [...state.history]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .find(
        (entry) =>
          entry.ok &&
          !entry.dryRun &&
          entry.purpose === "sync" &&
          entry.mode === "full",
      ) ?? null;

  if (existingBaseline) {
    return existingBaseline;
  }

  const finishedAt = params.finishedAt ?? new Date().toISOString();
  const startedAt = params.startedAt;
  const entryId = `seeded-full-${startedAt}`;
  const recordsPrepared =
    typeof params.recordsPrepared === "number" && params.recordsPrepared > 0
      ? params.recordsPrepared
      : 0;
  const artifactId = startedAt.replaceAll(":", "-");
  const notes = [
    "Baseline was seeded manually after confirming that the initial full catalog was already present in the Merchant Center API data source.",
    "Future delta runs now use this checkpoint instead of falling back or blocking on a missing successful full-sync history entry.",
    ...(params.notes ?? []),
  ].slice(0, 8);
  const entry: SyncHistoryEntry = {
    id: entryId,
    startedAt,
    finishedAt,
    trigger: "manual",
    purpose: "sync",
    mode: "full",
    dryRun: false,
    ok: true,
    scope:
      "All Shopify products are scanned across active, draft, and archived statuses so current feed rows can be inserted and inactive rows can be deleted from Merchant Center.",
    query: "",
    lookbackStart: null,
    artifactId,
    exportArtifactId: null,
    notes,
    stats: {
      pageSize: 250,
      pagesScanned: 0,
      scanCompleted: true,
      totalProducts: recordsPrepared || null,
      productsFetched: 0,
      variantsConsidered: 0,
      recordsPrepared,
      excluded: 0,
      validationIssues: 0,
      previewLimit: 5,
    },
  };

  await writeRunArtifact(artifactId, {
    id: artifactId,
    startedAt,
    finishedAt,
    trigger: "manual",
    purpose: "sync",
    mode: "full",
    dryRun: false,
    exhaustive: true,
    ok: true,
    scope: entry.scope,
    query: entry.query,
    lookbackStart: null,
    exportArtifactId: null,
    notes,
    stats: entry.stats,
    includedSample: [],
    validationSample: [],
    excludedSample: [],
    deleteSample: [],
    merchant: null,
  });
  await appendSyncHistory(entry);

  return entry;
}

export async function appendSyncHistory(entry: SyncHistoryEntry) {
  const state = await readState();
  const combinedHistory = [entry, ...state.history];
  const cappedHistory = combinedHistory.slice(0, HISTORY_LIMIT);
  const {
    history: retainedHistory,
    prunedScheduledSyncExports,
  } = retainScheduledSyncExports(cappedHistory);
  const evictedHistory = combinedHistory.slice(HISTORY_LIMIT);

  await writeState({
    ...state,
    history: retainedHistory,
    bootstrap: {
      firstFullSyncCompletedAt:
        state.bootstrap.firstFullSyncCompletedAt ??
        (entry.ok &&
        !entry.dryRun &&
        entry.purpose === "sync" &&
        entry.mode === "full"
          ? entry.finishedAt
          : null),
    },
  });

  if (prunedScheduledSyncExports.length) {
    await deleteScheduledSyncExportArtifacts(prunedScheduledSyncExports);
  }

  if (evictedHistory.length) {
    await deleteHistoryArtifacts(evictedHistory);
  }
}

export async function writeRunArtifact(id: string, artifact: unknown) {
  const mode = getStateStorageMode();

  if (mode === "neon") {
    await writeNeonArtifact(id, artifact);
    return;
  }

  if (mode === "blob") {
    await writeBlobArtifact(id, artifact);
    return;
  }

  if (mode === "local") {
    await writeLocalArtifact(id, artifact);
    return;
  }

  await writeMemoryArtifact(id, artifact);
}

export async function readRunArtifact<T = unknown>(id: string) {
  const mode = getStateStorageMode();

  if (mode === "neon") {
    const artifact = await readNeonArtifact<T>(id);

    if (artifact !== null) {
      return artifact;
    }

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blobArtifact = await readBlobArtifact<T>(id);

      if (blobArtifact !== null) {
        await writeNeonArtifact(id, blobArtifact);
      }

      return blobArtifact;
    }

    if (process.env.NODE_ENV !== "production") {
      const localArtifact = await readLocalArtifact<T>(id);

      if (localArtifact !== null) {
        await writeNeonArtifact(id, localArtifact);
      }

      return localArtifact;
    }

    return readMemoryArtifact<T>(id);
  }

  if (mode === "blob") {
    return readBlobArtifact<T>(id);
  }

  if (mode === "local") {
    return readLocalArtifact<T>(id);
  }

  return readMemoryArtifact<T>(id);
}

async function readBlobPreviewExport<T>(id: string) {
  const result = await get(getPreviewExportBlobPath(id), {
    access: "private",
    useCache: false,
  });

  if (!result || result.statusCode !== 200) {
    return null;
  }

  const text = await new Response(result.stream).text();
  return safeJsonParse<T | null>(
    text,
    null,
    getPreviewExportBlobPath(id),
  );
}

async function writeBlobPreviewExport(id: string, artifact: unknown) {
  await put(getPreviewExportBlobPath(id), JSON.stringify(artifact, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

async function deleteBlobPreviewExport(id: string) {
  try {
    await del(getPreviewExportBlobPath(id));
  } catch {
    // Ignore missing artifacts so delete remains idempotent.
  }
}

async function readLocalPreviewExport<T>(id: string) {
  try {
    const raw = await readFile(getLocalPreviewExportPath(id), "utf8");
    return safeJsonParse<T | null>(raw, null, getLocalPreviewExportPath(id));
  } catch {
    return null;
  }
}

async function writeLocalPreviewExport(id: string, artifact: unknown) {
  await mkdir(LOCAL_PREVIEW_EXPORT_DIR, { recursive: true });
  await writeFile(
    getLocalPreviewExportPath(id),
    JSON.stringify(artifact, null, 2),
    "utf8",
  );
}

async function deleteLocalPreviewExport(id: string) {
  try {
    await unlink(getLocalPreviewExportPath(id));
  } catch {
    // Ignore missing artifacts so delete remains idempotent.
  }
}

async function readMemoryPreviewExport<T>(id: string) {
  return (globalThis.__dppRunArtifacts?.[`preview-export:${id}`] as T | undefined) ?? null;
}

async function writeMemoryPreviewExport(id: string, artifact: unknown) {
  if (!globalThis.__dppRunArtifacts) {
    globalThis.__dppRunArtifacts = {};
  }

  globalThis.__dppRunArtifacts[`preview-export:${id}`] = artifact;
}

async function deleteMemoryPreviewExport(id: string) {
  if (!globalThis.__dppRunArtifacts) {
    return;
  }

  delete globalThis.__dppRunArtifacts[`preview-export:${id}`];
}

async function deleteRunArtifactById(id: string) {
  const mode = getStateStorageMode();

  if (mode === "neon") {
    await deleteNeonArtifact(id);

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      await deleteBlobArtifact(id);
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      await deleteLocalArtifact(id);
      return;
    }

    await deleteMemoryArtifact(id);
    return;
  }

  if (mode === "blob") {
    await deleteBlobArtifact(id);
    return;
  }

  if (mode === "local") {
    await deleteLocalArtifact(id);
    return;
  }

  await deleteMemoryArtifact(id);
}

async function deletePreviewExportArtifactById(id: string) {
  const mode = getPreviewExportStorageMode();

  if (mode === "neon") {
    await deleteNeonObject(getNeonPreviewExportKey(id));
    return;
  }

  if (mode === "blob") {
    await deleteBlobPreviewExport(id);
    return;
  }

  if (mode === "local") {
    await deleteLocalPreviewExport(id);
    return;
  }

  await deleteMemoryPreviewExport(id);
}

export async function deletePreviewExportArtifact(id: string) {
  await deletePreviewExportArtifactById(id);
}

async function deleteHistoryArtifacts(entries: SyncHistoryEntry[]) {
  for (const entry of entries) {
    if (entry.artifactId) {
      await deleteRunArtifactById(entry.artifactId);
    }

    if (entry.exportArtifactId) {
      await deletePreviewExportArtifactById(entry.exportArtifactId);
    }
  }
}

function retainScheduledSyncExports(history: SyncHistoryEntry[]) {
  const retainedByMode: Record<SyncHistoryEntry["mode"], number> = {
    delta: 0,
    full: 0,
  };
  const prunedScheduledSyncExports: SyncHistoryEntry[] = [];

  const retainedHistory = history.map((entry) => {
    if (
      entry.trigger !== "cron" ||
      entry.purpose !== "sync" ||
      !entry.exportArtifactId
    ) {
      return entry;
    }

    if (retainedByMode[entry.mode] < RETAINED_SCHEDULED_SYNC_EXPORTS_PER_MODE) {
      retainedByMode[entry.mode] += 1;
      return entry;
    }

    prunedScheduledSyncExports.push(entry);
    return {
      ...entry,
      exportArtifactId: null,
    };
  });

  return {
    history: retainedHistory,
    prunedScheduledSyncExports,
  };
}

async function clearRunArtifactExportReference(id: string) {
  const artifact = await readRunArtifact<Record<string, unknown>>(id);

  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return;
  }

  if (!("exportArtifactId" in artifact) || !artifact.exportArtifactId) {
    return;
  }

  await writeRunArtifact(id, {
    ...artifact,
    exportArtifactId: null,
  });
}

async function deleteScheduledSyncExportArtifacts(entries: SyncHistoryEntry[]) {
  for (const entry of entries) {
    if (entry.exportArtifactId) {
      await deletePreviewExportArtifactById(entry.exportArtifactId);
    }

    if (entry.artifactId) {
      await clearRunArtifactExportReference(entry.artifactId);
    }
  }
}

export async function writePreviewExportArtifact(id: string, artifact: unknown) {
  const mode = getPreviewExportStorageMode();

  if (mode === "neon") {
    await writeNeonObject(
      getNeonPreviewExportKey(id),
      NEON_PREVIEW_EXPORT_PREFIX,
      artifact,
    );
    return;
  }

  if (mode === "blob") {
    await writeBlobPreviewExport(id, artifact);
    return;
  }

  if (mode === "local") {
    await writeLocalPreviewExport(id, artifact);
    return;
  }

  await writeMemoryPreviewExport(id, artifact);
}

export async function appendPreviewExportArtifactChunk(
  id: string,
  chunk: {
    rows?: unknown[];
    excludedRows?: unknown[];
    validationRows?: unknown[];
    [key: string]: unknown;
  },
) {
  const existing =
    (await readPreviewExportArtifact<Record<string, unknown>>(id)) ?? {};
  const existingRows = Array.isArray(existing.rows) ? existing.rows : [];
  const existingExcludedRows = Array.isArray(existing.excludedRows)
    ? existing.excludedRows
    : [];
  const existingValidationRows = Array.isArray(existing.validationRows)
    ? existing.validationRows
    : [];

  await writePreviewExportArtifact(id, {
    ...existing,
    ...chunk,
    rows: [...existingRows, ...(chunk.rows ?? [])],
    excludedRows: [
      ...existingExcludedRows,
      ...(chunk.excludedRows ?? []),
    ],
    validationRows: [
      ...existingValidationRows,
      ...(chunk.validationRows ?? []),
    ],
  });
}

export async function readPreviewExportArtifact<T = unknown>(id: string) {
  const mode = getPreviewExportStorageMode();

  if (mode === "neon") {
    return readNeonObject<T>(getNeonPreviewExportKey(id));
  }

  if (mode === "blob") {
    return readBlobPreviewExport<T>(id);
  }

  if (mode === "local") {
    return readLocalPreviewExport<T>(id);
  }

  return readMemoryPreviewExport<T>(id);
}

export async function deleteSyncHistoryEntry(id: string) {
  const state = await readState();
  const entry = state.history.find((historyEntry) => historyEntry.id === id) ?? null;

  if (!entry) {
    return null;
  }

  await writeState({
    ...state,
    history: state.history.filter((historyEntry) => historyEntry.id !== id),
  });
  await deleteHistoryArtifacts([entry]);

  return entry;
}
