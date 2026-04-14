import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
import { env } from "@/lib/env";

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
const HISTORY_LIMIT = 50;
const RETAINED_SCHEDULED_SYNC_EXPORTS_PER_MODE = 2;

export type SyncHistoryPurpose = "sync" | "test-save";

export interface SyncSettings {
  anchorDate: string;
  deltaIntervalDays: number;
  fullIntervalDays: number;
  defaultDryRun: boolean;
  lookbackDays: number;
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

export interface ScheduledTestExport {
  mode: "delta" | "full";
  runAt: string;
  requestedAt: string;
}

interface OperatorState {
  settings: SyncSettings;
  history: SyncHistoryEntry[];
  scheduledTestExport: ScheduledTestExport | null;
}

type StorageMode = "blob" | "local" | "memory";

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
    defaultDryRun: env.defaultDryRun,
    lookbackDays: readPositiveInteger(env.lookbackDays, 8),
    updatedAt: new Date().toISOString(),
  };
}

function defaultState(): OperatorState {
  return {
    settings: defaultSettings(),
    history: [],
    scheduledTestExport: null,
  };
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
    defaultDryRun:
      typeof input?.defaultDryRun === "boolean"
        ? input.defaultDryRun
        : defaults.defaultDryRun,
    lookbackDays: readPositiveInteger(
      Number(input?.lookbackDays),
      defaults.lookbackDays,
    ),
    updatedAt: input?.updatedAt ?? defaults.updatedAt,
  } satisfies SyncSettings;
}

function sanitizeScheduledTestExport(
  input: Partial<ScheduledTestExport> | null | undefined,
) {
  if (!input) {
    return null;
  }

  const mode = input.mode === "delta" || input.mode === "full" ? input.mode : null;
  const runAt =
    typeof input.runAt === "string" &&
    Number.isFinite(new Date(input.runAt).getTime())
      ? new Date(input.runAt).toISOString()
      : null;
  const requestedAt =
    typeof input.requestedAt === "string" &&
    Number.isFinite(new Date(input.requestedAt).getTime())
      ? new Date(input.requestedAt).toISOString()
      : null;

  if (!mode || !runAt || !requestedAt) {
    return null;
  }

  return {
    mode,
    runAt,
    requestedAt,
  } satisfies ScheduledTestExport;
}

function sanitizeState(input: Partial<OperatorState> | null | undefined) {
  return {
    settings: sanitizeSettings(input?.settings),
    history: Array.isArray(input?.history)
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
      : [],
    scheduledTestExport: sanitizeScheduledTestExport(input?.scheduledTestExport),
  } satisfies OperatorState;
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

function getStorageMode(): StorageMode {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return "blob";
  }

  return process.env.NODE_ENV === "production" ? "memory" : "local";
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
  return sanitizeState(JSON.parse(text) as Partial<OperatorState>);
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
  return JSON.parse(text) as T;
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
    return sanitizeState(JSON.parse(raw) as Partial<OperatorState>);
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
    return JSON.parse(raw) as T;
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
  const mode = getStorageMode();

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
  const mode = getStorageMode();

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
  const mode = getStorageMode();

  return {
    mode,
    persistent: mode === "blob" || mode === "local",
    configured: mode === "blob",
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
  });

  if (prunedScheduledSyncExports.length) {
    await deleteScheduledSyncExportArtifacts(prunedScheduledSyncExports);
  }

  if (evictedHistory.length) {
    await deleteHistoryArtifacts(evictedHistory);
  }
}

export async function getScheduledTestExport() {
  const state = await readState();
  return sanitizeScheduledTestExport(state.scheduledTestExport);
}

export async function saveScheduledTestExport(input: ScheduledTestExport) {
  const state = await readState();
  const scheduledTestExport = sanitizeScheduledTestExport(input);

  if (!scheduledTestExport) {
    throw new Error("Scheduled test export is invalid.");
  }

  await writeState({
    ...state,
    scheduledTestExport,
  });

  return scheduledTestExport;
}

export async function clearScheduledTestExport() {
  const state = await readState();
  const scheduledTestExport = sanitizeScheduledTestExport(state.scheduledTestExport);

  await writeState({
    ...state,
    scheduledTestExport: null,
  });

  return scheduledTestExport;
}

export async function writeRunArtifact(id: string, artifact: unknown) {
  const mode = getStorageMode();

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
  const mode = getStorageMode();

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
  return JSON.parse(text) as T;
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
    return JSON.parse(raw) as T;
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
  const mode = getStorageMode();

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
  const mode = getStorageMode();

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
  const mode = getStorageMode();

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

export async function readPreviewExportArtifact<T = unknown>(id: string) {
  const mode = getStorageMode();

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
