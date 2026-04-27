export type SyncBudgetStatus = "ok" | "warning" | "pause_requested";

export interface SyncBudgetSnapshot {
  sampleSize: number;
  status: SyncBudgetStatus;
  summary: string;
  pauseReason: string | null;
  expectedDurationMs: number | null;
  warningDurationMs: number | null;
  pauseDurationMs: number | null;
  projectedDurationMs: number | null;
  throughputProductsPerMinute: number | null;
  throughputFloorProductsPerMinute: number | null;
  neonOpsUsed: number;
  neonOpsBudget: number;
  neonOpsProjected: number;
  vercelFunctionsUsed: number;
  vercelFunctionsBudget: number;
  vercelFunctionsProjected: number;
  transferUsedMb: number;
  transferBudgetMb: number;
  transferProjectedMb: number;
}

export interface SyncBudgetUsage {
  mode: "delta" | "full";
  elapsedMs: number;
  totalProducts: number | null;
  productsScanned: number;
  chunksCompleted: number;
  chunkTargetProducts: number;
  estimatedTransferBytes: number;
  neonOpsUsed: number;
  vercelFunctionsUsed: number;
}

export interface SyncBudgetHistorySample {
  mode: "delta" | "full";
  ok: boolean;
  dryRun: boolean;
  purpose: string | null | undefined;
  startedAt: string;
  finishedAt: string;
  stats: {
    productsFetched: number;
  };
}

interface SyncBudgetProfile {
  sampleSize: number;
  expectedMsPerProduct: number;
  throughputProductsPerMinute: number;
  warningMultiplier: number;
  pauseMultiplier: number;
  minWarningMs: number;
  minPauseMs: number;
  baseNeonOps: number;
  neonOpsPerChunk: number;
  baseVercelFunctions: number;
  vercelFunctionsPerChunk: number;
  transferOverheadBytes: number;
  defaultTransferBytesPerProduct: number;
  hardTransferBudgetMb: number;
}

const MS_PER_MINUTE = 60_000;
const BYTES_PER_MB = 1024 * 1024;
const LARGE_DELTA_PRODUCT_THRESHOLD = 2500;
const LARGE_DELTA_MIN_WARNING_MS = 90 * MS_PER_MINUTE;
const LARGE_DELTA_MIN_PAUSE_MS = 150 * MS_PER_MINUTE;
const NO_PROGRESS_PAUSE_MS = 15 * MS_PER_MINUTE;

const FALLBACK_PROFILES: Record<"delta" | "full", SyncBudgetProfile> = {
  delta: {
    sampleSize: 0,
    expectedMsPerProduct: 120,
    throughputProductsPerMinute: 500,
    warningMultiplier: 1.35,
    pauseMultiplier: 1.75,
    minWarningMs: 12 * MS_PER_MINUTE,
    minPauseMs: 20 * MS_PER_MINUTE,
    baseNeonOps: 40,
    neonOpsPerChunk: 18,
    baseVercelFunctions: 24,
    vercelFunctionsPerChunk: 12,
    transferOverheadBytes: 8 * BYTES_PER_MB,
    defaultTransferBytesPerProduct: 18_000,
    hardTransferBudgetMb: 220,
  },
  full: {
    sampleSize: 0,
    expectedMsPerProduct: 420,
    throughputProductsPerMinute: 150,
    warningMultiplier: 1.35,
    pauseMultiplier: 1.75,
    minWarningMs: 55 * MS_PER_MINUTE,
    minPauseMs: 85 * MS_PER_MINUTE,
    baseNeonOps: 70,
    neonOpsPerChunk: 20,
    baseVercelFunctions: 36,
    vercelFunctionsPerChunk: 14,
    transferOverheadBytes: 24 * BYTES_PER_MB,
    defaultTransferBytesPerProduct: 24_000,
    hardTransferBudgetMb: 900,
  },
};

function median(values: number[]) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function buildSyncBudgetProfile(params: {
  mode: "delta" | "full";
  history: SyncBudgetHistorySample[];
}): SyncBudgetProfile {
  const fallback = FALLBACK_PROFILES[params.mode];
  const samples = params.history.filter(
    (entry) =>
      entry.mode === params.mode &&
      entry.ok &&
      !entry.dryRun &&
      entry.purpose === "sync" &&
      entry.stats.productsFetched > 0,
  );

  if (!samples.length) {
    return fallback;
  }

  const msPerProductValues: number[] = [];
  const throughputValues: number[] = [];

  for (const sample of samples) {
    const startedMs = Date.parse(sample.startedAt);
    const finishedMs = Date.parse(sample.finishedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs <= startedMs) {
      continue;
    }

    const durationMs = finishedMs - startedMs;
    const productsFetched = Math.max(1, sample.stats.productsFetched);
    msPerProductValues.push(durationMs / productsFetched);
    throughputValues.push(productsFetched / (durationMs / MS_PER_MINUTE));
  }

  const expectedMsPerProduct = median(msPerProductValues);
  const throughputProductsPerMinute = median(throughputValues);

  return {
    ...fallback,
    sampleSize: samples.length,
    expectedMsPerProduct:
      expectedMsPerProduct && Number.isFinite(expectedMsPerProduct)
        ? expectedMsPerProduct
        : fallback.expectedMsPerProduct,
    throughputProductsPerMinute:
      throughputProductsPerMinute && Number.isFinite(throughputProductsPerMinute)
        ? throughputProductsPerMinute
        : fallback.throughputProductsPerMinute,
  };
}

function toMegabytes(bytes: number) {
  return Math.max(0, bytes) / BYTES_PER_MB;
}

function roundMetric(value: number) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function createInitialSyncBudgetSnapshot(
  mode: "delta" | "full",
): SyncBudgetSnapshot {
  const profile = FALLBACK_PROFILES[mode];

  return {
    sampleSize: profile.sampleSize,
    status: "ok",
    summary:
      "Budget guard is waiting for enough progress to calculate a reliable run envelope.",
    pauseReason: null,
    expectedDurationMs: null,
    warningDurationMs: null,
    pauseDurationMs: null,
    projectedDurationMs: null,
    throughputProductsPerMinute: null,
    throughputFloorProductsPerMinute: Math.round(
      profile.throughputProductsPerMinute * 0.45,
    ),
    neonOpsUsed: 0,
    neonOpsBudget: profile.baseNeonOps,
    neonOpsProjected: 0,
    vercelFunctionsUsed: 0,
    vercelFunctionsBudget: profile.baseVercelFunctions,
    vercelFunctionsProjected: 0,
    transferUsedMb: 0,
    transferBudgetMb: roundMetric(profile.hardTransferBudgetMb),
    transferProjectedMb: 0,
  };
}

export function evaluateSyncBudget(params: {
  profile: SyncBudgetProfile;
  usage: SyncBudgetUsage;
}): SyncBudgetSnapshot {
  const { usage } = params;
  const fullProfile = FALLBACK_PROFILES.full;
  const largeDelta =
    usage.mode === "delta" &&
    typeof usage.totalProducts === "number" &&
    usage.totalProducts >= LARGE_DELTA_PRODUCT_THRESHOLD;
  const profile = largeDelta
    ? {
        ...params.profile,
        expectedMsPerProduct: Math.max(
          params.profile.expectedMsPerProduct,
          fullProfile.expectedMsPerProduct,
        ),
        throughputProductsPerMinute: Math.min(
          params.profile.throughputProductsPerMinute,
          fullProfile.throughputProductsPerMinute,
        ),
        minWarningMs: Math.max(params.profile.minWarningMs, LARGE_DELTA_MIN_WARNING_MS),
        minPauseMs: Math.max(params.profile.minPauseMs, LARGE_DELTA_MIN_PAUSE_MS),
        baseVercelFunctions: Math.max(
          params.profile.baseVercelFunctions,
          fullProfile.baseVercelFunctions,
        ),
        vercelFunctionsPerChunk: Math.max(
          params.profile.vercelFunctionsPerChunk,
          fullProfile.vercelFunctionsPerChunk,
        ),
        transferOverheadBytes: Math.max(
          params.profile.transferOverheadBytes,
          fullProfile.transferOverheadBytes,
        ),
        hardTransferBudgetMb: Math.max(
          params.profile.hardTransferBudgetMb,
          fullProfile.hardTransferBudgetMb,
        ),
      }
    : params.profile;
  const expectedChunks =
    usage.totalProducts && usage.totalProducts > 0
      ? Math.max(1, Math.ceil(usage.totalProducts / usage.chunkTargetProducts))
      : Math.max(1, usage.chunksCompleted || 1);
  const progressRatio =
    usage.totalProducts && usage.totalProducts > 0 && usage.productsScanned > 0
      ? Math.min(1, usage.productsScanned / usage.totalProducts)
      : usage.chunksCompleted > 0
        ? Math.min(1, usage.chunksCompleted / expectedChunks)
        : 0;

  const throughputProductsPerMinute =
    usage.elapsedMs > 0 && usage.productsScanned > 0
      ? usage.productsScanned / (usage.elapsedMs / MS_PER_MINUTE)
      : null;
  const throughputFloorProductsPerMinute = Math.max(
    25,
    Math.round(profile.throughputProductsPerMinute * 0.45),
  );

  const expectedDurationMs =
    usage.totalProducts && usage.totalProducts > 0
      ? Math.round(usage.totalProducts * profile.expectedMsPerProduct)
      : null;
  const warningDurationMs = expectedDurationMs
    ? Math.max(
        profile.minWarningMs,
        Math.round(expectedDurationMs * profile.warningMultiplier),
      )
    : null;
  const pauseDurationMs = expectedDurationMs
    ? Math.max(
        profile.minPauseMs,
        Math.round(expectedDurationMs * profile.pauseMultiplier),
      )
    : null;
  const projectedDurationMs =
    progressRatio > 0.05 ? Math.round(usage.elapsedMs / progressRatio) : expectedDurationMs;

  const neonOpsBudget =
    profile.baseNeonOps + expectedChunks * profile.neonOpsPerChunk;
  const vercelFunctionsBudget =
    profile.baseVercelFunctions +
    expectedChunks * profile.vercelFunctionsPerChunk +
    (usage.mode === "full" ? 20 : 0);

  const neonOpsProjected =
    progressRatio > 0.05
      ? Math.round(usage.neonOpsUsed / progressRatio)
      : usage.neonOpsUsed;
  const vercelFunctionsProjected =
    progressRatio > 0.05
      ? Math.round(usage.vercelFunctionsUsed / progressRatio)
      : usage.vercelFunctionsUsed;

  const averageTransferBytesPerProduct =
    usage.productsScanned > 0
      ? usage.estimatedTransferBytes / usage.productsScanned
      : profile.defaultTransferBytesPerProduct;
  const projectedTransferBytes =
    (usage.totalProducts && usage.totalProducts > 0
      ? usage.totalProducts * averageTransferBytesPerProduct
      : usage.estimatedTransferBytes) + profile.transferOverheadBytes;
  const transferProjectedMb = roundMetric(toMegabytes(projectedTransferBytes));
  const transferBudgetMb = roundMetric(
    Math.min(
      profile.hardTransferBudgetMb,
      Math.max(12, toMegabytes(projectedTransferBytes) * 1.35),
    ),
  );

  const transferUsedMb = roundMetric(toMegabytes(usage.estimatedTransferBytes));
  const durationExceeded =
    Boolean(pauseDurationMs && usage.elapsedMs > pauseDurationMs) ||
    Boolean(projectedDurationMs && pauseDurationMs && projectedDurationMs > pauseDurationMs);
  const throughputExceeded =
    usage.elapsedMs > 6 * MS_PER_MINUTE &&
    Boolean(
      throughputProductsPerMinute &&
        throughputProductsPerMinute < throughputFloorProductsPerMinute,
    );
  const neonExceeded = neonOpsProjected > neonOpsBudget;
  const functionsExceeded = vercelFunctionsProjected > vercelFunctionsBudget;
  const transferExceeded = transferProjectedMb > transferBudgetMb;
  const noProgressExceeded =
    usage.elapsedMs > NO_PROGRESS_PAUSE_MS &&
    usage.productsScanned === 0 &&
    usage.chunksCompleted === 0;

  let status: SyncBudgetStatus = "ok";
  let summary =
    "Run budget is inside the expected envelope from historical live-sync behavior.";
  let pauseReason: string | null = null;

  if (
    noProgressExceeded ||
    durationExceeded ||
    (throughputExceeded && usage.elapsedMs > 10 * MS_PER_MINUTE) ||
    neonExceeded ||
    functionsExceeded ||
    transferExceeded
  ) {
    status = "pause_requested";
    pauseReason = noProgressExceeded
      ? "No Shopify scan progress was recorded inside the startup watchdog window."
      : durationExceeded
        ? "Run duration moved outside the safe budget envelope."
        : throughputExceeded
          ? "Observed throughput fell below the safe floor from historical runs."
          : neonExceeded
            ? "Projected Neon state activity moved above the safe budget."
            : functionsExceeded
              ? "Projected Vercel workflow function activity moved above the safe budget."
              : "Projected network transfer moved above the safe budget.";
    summary = `${pauseReason} The workflow should stop at the next safe checkpoint.`;
  } else if (
    Boolean(warningDurationMs && usage.elapsedMs > warningDurationMs) ||
    Boolean(
      projectedDurationMs &&
        warningDurationMs &&
        projectedDurationMs > warningDurationMs,
    ) ||
    (throughputExceeded && usage.elapsedMs > 4 * MS_PER_MINUTE) ||
    neonOpsProjected > neonOpsBudget * 0.85 ||
    vercelFunctionsProjected > vercelFunctionsBudget * 0.85 ||
    transferProjectedMb > transferBudgetMb * 0.85
  ) {
    status = "warning";
    summary = largeDelta
      ? "Large delta run is using the full-catalog safety envelope because many Shopify products changed in the same window."
      : "Run budget is drifting high. Watch the live metrics and stop the run if you need to inspect the current chunk.";
  }

  return {
    sampleSize: profile.sampleSize,
    status,
    summary,
    pauseReason,
    expectedDurationMs,
    warningDurationMs,
    pauseDurationMs,
    projectedDurationMs,
    throughputProductsPerMinute: throughputProductsPerMinute
      ? roundMetric(throughputProductsPerMinute)
      : null,
    throughputFloorProductsPerMinute,
    neonOpsUsed: usage.neonOpsUsed,
    neonOpsBudget,
    neonOpsProjected,
    vercelFunctionsUsed: usage.vercelFunctionsUsed,
    vercelFunctionsBudget,
    vercelFunctionsProjected,
    transferUsedMb,
    transferBudgetMb,
    transferProjectedMb,
  };
}
