import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env, isAuthorizedCronRequest } from "@/lib/env";
import { decideSyncMode, runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  const decision = decideSyncMode();

  if (decision.mode === "idle") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      dryRun: env.defaultDryRun,
      decision,
    });
  }

  const result = await runSync(decision.mode, {
    trigger: "cron",
    dryRun: env.defaultDryRun,
  });

  return NextResponse.json({
    ok: true,
    skipped: false,
    decision,
    result,
  });
}
