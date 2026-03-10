import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedManualRequest, readDryRunValue } from "@/lib/env";
import { runSync, type SyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isSupportedMode(
  value: string | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedManualRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized manual sync request.",
      },
      { status: 401 },
    );
  }

  const mode = request.nextUrl.searchParams.get("mode");

  if (!isSupportedMode(mode)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Use ?mode=delta or ?mode=full.",
      },
      { status: 400 },
    );
  }

  const dryRun = readDryRunValue(request.nextUrl.searchParams.get("dryRun"));
  const result = await runSync(mode, {
    trigger: "manual",
    dryRun,
  });

  return NextResponse.json({
    ok: true,
    result,
  });
}
