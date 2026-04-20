import { NextResponse, type NextRequest } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { startLiveSyncJob } from "@/lib/live-sync-jobs";
import { getBootstrapState, getSyncSettings } from "@/lib/operator-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        message: "Unauthorized",
      },
      { status: 401 },
    );
  }

  const bootstrap = await getBootstrapState();

  if (bootstrap.firstFullSyncCompletedAt) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "The first live full sync already completed successfully, so the one-time bootstrap run is no longer available.",
      },
      { status: 409 },
    );
  }

  const settings = await getSyncSettings();
  const startResult = await startLiveSyncJob({
    mode: "full",
    trigger: "manual",
    purpose: "sync",
    settings,
  });

  if (!startResult.ok) {
    if (startResult.activeRun.mode === "full") {
      return NextResponse.json({
        ok: true,
        runId: startResult.activeRun.runId,
        alreadyRunning: true,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        message:
          "Another live sync is already running. Wait for it to finish before starting the first full sync again.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    runId: startResult.runId,
    alreadyRunning: false,
  });
}
