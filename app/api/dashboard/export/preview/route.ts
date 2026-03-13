import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildPreviewExportWorkbook } from "@/lib/feed-export";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { readPreviewExportArtifact } from "@/lib/operator-store";
import { type SyncExportResult, type SyncMode } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function isSupportedMode(
  value: string | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

function buildFilename(mode: Exclude<SyncMode, "idle">, startedAt: string) {
  return `dpp-feed-${mode}-export-${startedAt.replaceAll(":", "-")}.xlsx`;
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

  const exportId = request.nextUrl.searchParams.get("id");
  const mode = request.nextUrl.searchParams.get("mode");

  if (exportId) {
    const artifact = await readPreviewExportArtifact<SyncExportResult>(exportId);

    if (!artifact) {
      return NextResponse.json(
        {
          ok: false,
          error: "Prepared preview export was not found. Run preview again.",
        },
        { status: 404 },
      );
    }

    const workbook = buildPreviewExportWorkbook(artifact);

    return new NextResponse(workbook, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${buildFilename(
          artifact.mode,
          artifact.startedAt,
        )}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (!isSupportedMode(mode)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Use ?id=<prepared-export-id>.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: `Run a ${mode} preview first so the prepared export is available.`,
    },
    { status: 400 },
  );
}
