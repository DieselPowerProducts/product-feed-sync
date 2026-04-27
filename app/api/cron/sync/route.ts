import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isAuthorizedCronSchedulerRequest,
  VERCEL_CRON_USER_AGENT,
} from "@/lib/env";
import { startLiveSyncJob } from "@/lib/live-sync-jobs";
import {
  appendCronInvocation,
  getCronInvocations,
  getSyncHistory,
  getSyncSettings,
  type CronInvocationEntry,
} from "@/lib/operator-store";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const PRIMARY_CRON_HOUR_UTC = 9;
const PRIMARY_CRON_MINUTE_UTC = 0;

function buildCronInvocationId(firedAt: string) {
  return `cron-${firedAt.replaceAll(":", "-")}`;
}

function getCronWindowStart(now: Date) {
  const todayWindow = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      PRIMARY_CRON_HOUR_UTC,
      PRIMARY_CRON_MINUTE_UTC,
      0,
      0,
    ),
  );

  if (now.getTime() >= todayWindow.getTime()) {
    return todayWindow;
  }

  return new Date(todayWindow.getTime() - 86_400_000);
}

async function hasSuccessfulSyncForCronWindow(params: {
  mode: "delta" | "full";
  windowStart: Date;
}) {
  const [history, cronInvocations] = await Promise.all([
    getSyncHistory(20),
    getCronInvocations(30),
  ]);
  const windowStartMs = params.windowStart.getTime();

  const successfulHistoryEntry = history.some((entry) => {
    if (
      !entry.ok ||
      entry.dryRun ||
      entry.purpose !== "sync" ||
      entry.mode !== params.mode
    ) {
      return false;
    }

    const startedAtMs = new Date(entry.startedAt).getTime();
    return Number.isFinite(startedAtMs) && startedAtMs >= windowStartMs;
  });

  if (successfulHistoryEntry) {
    return true;
  }

  return cronInvocations.some((entry) => {
    if (
      entry.decisionMode !== params.mode ||
      entry.outcome !== "completed"
    ) {
      return false;
    }

    const firedAtMs = new Date(entry.firedAt).getTime();
    return Number.isFinite(firedAtMs) && firedAtMs >= windowStartMs;
  });
}

async function countStartedCronAttemptsForWindow(params: {
  mode: "delta" | "full";
  windowStart: Date;
}) {
  const cronInvocations = await getCronInvocations(30);
  const windowStartMs = params.windowStart.getTime();
  const startedRunIds = new Set<string>();

  for (const entry of cronInvocations) {
    if (
      entry.decisionMode !== params.mode ||
      !entry.runId ||
      !["queued", "completed", "cancelled", "failed"].includes(entry.outcome)
    ) {
      continue;
    }

    const firedAtMs = new Date(entry.firedAt).getTime();

    if (!Number.isFinite(firedAtMs) || firedAtMs < windowStartMs) {
      continue;
    }

    startedRunIds.add(entry.runId);
  }

  return startedRunIds.size;
}

async function recordCronInvocation(
  entry: Omit<CronInvocationEntry, "id">,
) {
  const invocation = {
    ...entry,
    id: buildCronInvocationId(entry.firedAt),
  } satisfies CronInvocationEntry;

  try {
    await appendCronInvocation(invocation);
  } catch (error) {
    console.error("[cron/sync] Failed to record cron invocation.", error);
  }

  console.log("[cron/sync] invocation", invocation);
}

export async function GET(request: NextRequest) {
  const firedAt = new Date().toISOString();
  const path = new URL(request.url).pathname;
  const userAgent = request.headers.get("user-agent");
  const authorizationPresent = Boolean(request.headers.get("authorization"));

  if (!isAuthorizedCronSchedulerRequest(request)) {
    console.warn("[cron/sync] Rejected non-scheduler request.", {
      path,
      userAgent,
      authorizationPresent,
      expectedUserAgent: VERCEL_CRON_USER_AGENT,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "Only the Vercel cron scheduler may invoke this route.",
      },
      { status: 401 },
    );
  }

  try {
    const now = new Date(firedAt);
    const settings = await getSyncSettings();
    const decision = decideSyncMode(now, settings);

    if (decision.mode === "idle") {
      await recordCronInvocation({
        firedAt,
        path,
        userAgent,
        authorizationPresent,
        authorized: true,
        decisionMode: decision.mode,
        outcome: "skipped_idle",
        runId: null,
        message: decision.reason,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        dryRun: false,
        decision,
      });
    }

    const windowStart = getCronWindowStart(now);
    const alreadyCompleted = await hasSuccessfulSyncForCronWindow({
      mode: decision.mode,
      windowStart,
    });

    if (alreadyCompleted) {
      const message = `A successful ${decision.mode} sync already ran after ${windowStart.toISOString()}, so this backup cron invocation skipped.`;
      await recordCronInvocation({
        firedAt,
        path,
        userAgent,
        authorizationPresent,
        authorized: true,
        decisionMode: decision.mode,
        outcome: "skipped_duplicate",
        runId: null,
        message,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        decision,
        message,
      });
    }

    const startedAttempts = await countStartedCronAttemptsForWindow({
      mode: decision.mode,
      windowStart,
    });

    if (startedAttempts >= 2) {
      const message = `Two scheduled ${decision.mode} sync attempts have already started after ${windowStart.toISOString()}, so no more backup cron invocations will run for this window.`;
      await recordCronInvocation({
        firedAt,
        path,
        userAgent,
        authorizationPresent,
        authorized: true,
        decisionMode: decision.mode,
        outcome: "skipped_retry_limit",
        runId: null,
        message,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        decision,
        message,
        startedAttempts,
      });
    }

    const startResult = await startLiveSyncJob({
      mode: decision.mode,
      trigger: "cron",
      purpose: "sync",
      settings,
    });

    if (!startResult.ok) {
      const message =
        "A live sync workflow is already running, so the scheduled cron kickoff was skipped.";
      await recordCronInvocation({
        firedAt,
        path,
        userAgent,
        authorizationPresent,
        authorized: true,
        decisionMode: decision.mode,
        outcome: "skipped_active_run",
        runId: startResult.activeRun.runId,
        message,
      });
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          decision,
          message,
          activeRun: startResult.activeRun,
        },
        { status: 200 },
      );
    }

    await recordCronInvocation({
      firedAt,
      path,
      userAgent,
      authorizationPresent,
      authorized: true,
      decisionMode: decision.mode,
      outcome: "queued",
      runId: startResult.runId,
      message: `Queued ${decision.mode} live sync workflow from Vercel cron.`,
    });
    return NextResponse.json({
      ok: true,
      skipped: false,
      decision,
      runId: startResult.runId,
      queued: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown cron sync failure.";
    await recordCronInvocation({
      firedAt,
      path,
      userAgent,
      authorizationPresent,
      authorized: true,
      decisionMode: null,
      outcome: "failed",
      runId: null,
      message,
    });
    console.error("[cron/sync] failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 },
    );
  }
}
