import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedManualRequest, readDryRunValue } from "@/lib/env";
import { DEFAULT_PREVIEW_LIMIT, runSync, type SyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function isSupportedMode(
  value: string | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

function readPreviewLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PREVIEW_LIMIT;
  }

  return Math.min(parsed, 25);
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
  const previewLimit = readPreviewLimit(
    request.nextUrl.searchParams.get("limit"),
  );
  const result = await runSync(mode, {
    trigger: "manual",
    dryRun,
    previewLimit,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
