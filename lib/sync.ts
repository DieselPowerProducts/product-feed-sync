import { env, getConfigurationStatus } from "@/lib/env";

const MS_PER_DAY = 86_400_000;
const FALLBACK_ANCHOR_DATE = "2026-03-10";

export type SyncMode = "idle" | "delta" | "full";

export interface SyncDecision {
  mode: SyncMode;
  anchorDate: string;
  daysSinceAnchor: number;
  reason: string;
}

export interface SyncRunResult {
  ok: boolean;
  trigger: "cron" | "manual";
  mode: Exclude<SyncMode, "idle">;
  dryRun: boolean;
  scope: string;
  startedAt: string;
  finishedAt: string;
  configuration: ReturnType<typeof getConfigurationStatus>;
  notes: string[];
}

function parseAnchorDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return new Date(`${FALLBACK_ANCHOR_DATE}T00:00:00.000Z`);
  }

  return parsed;
}

function toUtcDayNumber(date: Date) {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
      MS_PER_DAY,
  );
}

export function decideSyncMode(now = new Date()): SyncDecision {
  const anchorDate = parseAnchorDate(env.syncAnchorDate);
  const daysSinceAnchor = Math.max(
    0,
    toUtcDayNumber(now) - toUtcDayNumber(anchorDate),
  );

  if (daysSinceAnchor % env.fullIntervalDays === 0) {
    return {
      mode: "full",
      anchorDate: anchorDate.toISOString().slice(0, 10),
      daysSinceAnchor,
      reason: `Full refresh is due every ${env.fullIntervalDays} days.`,
    };
  }

  if (daysSinceAnchor % env.deltaIntervalDays === 0) {
    return {
      mode: "delta",
      anchorDate: anchorDate.toISOString().slice(0, 10),
      daysSinceAnchor,
      reason: `Delta sync is due every ${env.deltaIntervalDays} days.`,
    };
  }

  return {
    mode: "idle",
    anchorDate: anchorDate.toISOString().slice(0, 10),
    daysSinceAnchor,
    reason: "No scheduled sync is due today.",
  };
}

export async function runSync(
  mode: Exclude<SyncMode, "idle">,
  options: {
    trigger: "cron" | "manual";
    dryRun?: boolean;
  },
): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? env.defaultDryRun;

  const scope =
    mode === "full"
      ? "All active and eligible products."
      : `Products created or updated in the last ${env.lookbackDays} day(s).`;

  const notes = [
    "Starter scaffold only. No live Shopify or Google Merchant API requests run yet.",
    "Replace runSync() with the real fetch, transform, validate, and upsert pipeline.",
    dryRun
      ? "Dry run is enabled. This is the safest mode for the first proof-of-life test."
      : "Dry run is disabled. Do not use live writes until mapping rules are validated.",
  ];

  return {
    ok: true,
    trigger: options.trigger,
    mode,
    dryRun,
    scope,
    startedAt,
    finishedAt: new Date().toISOString(),
    configuration: getConfigurationStatus(),
    notes,
  };
}
