import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/env";
import { getSyncSettings } from "@/lib/operator-store";
import { decideSyncMode, runSync } from "@/lib/sync";

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

  const result = await runSync(decision.mode, {
    trigger: "cron",
    purpose: "sync",
    dryRun: false,
    settings,
    prepareExportArtifact: true,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      skipped: false,
      decision,
      result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
