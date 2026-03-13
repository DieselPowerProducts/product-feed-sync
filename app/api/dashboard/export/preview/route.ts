import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildPreviewExportWorkbook } from "@/lib/feed-export";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { runSyncExport, type SyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function isSupportedMode(
  value: string | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

function buildFilename(mode: Exclude<SyncMode, "idle">) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `dpp-feed-${mode}-export-${timestamp}.xlsx`;
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
        error: "Unauthorized dashboard export request.",
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

  const result = await runSyncExport(mode, {
    dryRun: true,
  });
  const workbook = buildPreviewExportWorkbook(result);

  return new NextResponse(workbook, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${buildFilename(mode)}"`,
      "Cache-Control": "no-store",
    },
  });
}
