import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/env";
import { startLiveSyncJob } from "@/lib/live-sync-jobs";
import { getSyncSettings } from "@/lib/operator-store";
import { decideSyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized cron request.",
      },
      { status: 401 },
    );
  }

  const settings = await getSyncSettings();
  const decision = decideSyncMode(new Date(), settings);

  if (decision.mode === "idle") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      dryRun: false,
      decision,
    });
  }

  const startResult = await startLiveSyncJob({
    mode: decision.mode,
    trigger: "cron",
    purpose: "sync",
    settings,
  });

  if (!startResult.ok) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        decision,
        message:
          "A live sync workflow is already running, so the scheduled cron kickoff was skipped.",
        activeRun: startResult.activeRun,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    skipped: false,
    decision,
    runId: startResult.runId,
    queued: true,
  });
}
