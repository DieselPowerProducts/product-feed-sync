import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { getSyncSettings } from "@/lib/operator-store";
import { runSync, type SyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isSupportedMode(
  value: string | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

function readPreviewLimit(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, 25);
}

export async function GET(request: NextRequest) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized dashboard preview request.",
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

  const settings = await getSyncSettings();
  const limit = readPreviewLimit(
    request.nextUrl.searchParams.get("limit"),
    settings.previewLimit,
  );
  const result = await runSync(mode, {
    trigger: "manual",
    dryRun: true,
    previewLimit: limit,
    persistHistory: false,
    settings,
  });

  return NextResponse.json({
    ok: result.ok,
    result,
    error: result.ok ? null : result.notes[0] ?? "Preview request failed.",
  });
}
