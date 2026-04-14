import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/env";
import {
  clearScheduledTestExport,
  getScheduledTestExport,
  getSyncSettings,
} from "@/lib/operator-store";
import { runSync } from "@/lib/sync";

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

  const scheduledTestExport = await getScheduledTestExport();

  if (!scheduledTestExport) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "No scheduled test save is pending.",
    });
  }

  const now = new Date();
  const runAt = new Date(scheduledTestExport.runAt);

  if (!Number.isFinite(runAt.getTime()) || runAt.getTime() > now.getTime()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "Scheduled test save is not due yet.",
      scheduledTestExport,
    });
  }

  const settings = await getSyncSettings();
  const result = await runSync(scheduledTestExport.mode, {
    trigger: "cron",
    purpose: "test-save",
    dryRun: settings.defaultDryRun,
    settings,
    prepareExportArtifact: true,
  });

  await clearScheduledTestExport();

  return NextResponse.json(
    {
      ok: result.ok,
      skipped: false,
      scheduledTestExport,
      result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
