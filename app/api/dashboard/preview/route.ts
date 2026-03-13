import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { getSyncSettings } from "@/lib/operator-store";
import { DEFAULT_PREVIEW_LIMIT, runSync, type SyncMode } from "@/lib/sync";
import { captureShopifyGraphqlDiagnostics } from "@/lib/shopify";

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

function readBooleanish(value: string | null) {
  if (!value) {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
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
    DEFAULT_PREVIEW_LIMIT,
  );
  const { result, diagnostics } = await captureShopifyGraphqlDiagnostics(() =>
    runSync(mode, {
      trigger: "manual",
      dryRun: true,
      previewLimit: limit,
      persistHistory: false,
      settings,
      exhaustive: readBooleanish(request.nextUrl.searchParams.get("exhaustive")),
      prepareExportArtifact: readBooleanish(
        request.nextUrl.searchParams.get("exhaustive"),
      ),
    }),
  );

  return NextResponse.json({
    ok: result.ok,
    result: {
      ...result,
      shopifyDiagnostics: diagnostics,
    },
    error: result.ok ? null : result.notes[0] ?? "Preview request failed.",
  });
}
