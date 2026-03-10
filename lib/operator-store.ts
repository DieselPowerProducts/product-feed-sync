import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import { env } from "@/lib/env";

const STATE_BLOB_PATH = "dpp-product-feed-sync/operator-state.json";
const LOCAL_STATE_PATH = path.join(
  process.cwd(),
  ".local-state",
  "operator-state.json",
);
const HISTORY_LIMIT = 50;

export interface SyncSettings {
  anchorDate: string;
  deltaIntervalDays: number;
  fullIntervalDays: number;
  defaultDryRun: boolean;
  lookbackDays: number;
  previewLimit: number;
  updatedAt: string;
}

export interface SyncHistoryEntry {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  mode: "delta" | "full";
  dryRun: boolean;
  ok: boolean;
  scope: string;
  query: string;
  lookbackStart: string | null;
  notes: string[];
  stats: {
    pageSize: number;
    pagesScanned: number;
    productsFetched: number;
    variantsConsidered: number;
    recordsPrepared: number;
    excluded: number;
    previewLimit: number;
  };
}

interface OperatorState {
  settings: SyncSettings;
  history: SyncHistoryEntry[];
}

type StorageMode = "blob" | "local" | "memory";

declare global {
  var __dppOperatorState: OperatorState | undefined;
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
    previewLimit: 5,
    updatedAt: new Date().toISOString(),
  };
}

function defaultState(): OperatorState {
  return {
    settings: defaultSettings(),
    history: [],
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
    previewLimit: Math.min(
      25,
      Math.max(1, readPositiveInteger(Number(input?.previewLimit), 5)),
    ),
    updatedAt: input?.updatedAt ?? defaults.updatedAt,
  } satisfies SyncSettings;
}

function sanitizeState(input: Partial<OperatorState> | null | undefined) {
  return {
    settings: sanitizeSettings(input?.settings),
    history: Array.isArray(input?.history)
      ? input.history.slice(0, HISTORY_LIMIT).map((entry) => ({
          ...entry,
          notes: Array.isArray(entry.notes) ? entry.notes.slice(0, 8) : [],
        }))
      : [],
  } satisfies OperatorState;
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

async function readMemoryState() {
  return globalThis.__dppOperatorState ?? defaultState();
}

async function writeMemoryState(state: OperatorState) {
  globalThis.__dppOperatorState = state;
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

  await writeState({
    ...state,
    history: [entry, ...state.history].slice(0, HISTORY_LIMIT),
  });
}
