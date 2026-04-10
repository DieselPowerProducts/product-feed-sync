import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildExcludedExportCsv,
  buildExcludedExportWorkbook,
  buildPreviewExportCsv,
  buildPreviewExportWorkbook,
} from "@/lib/feed-export";
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

function isSupportedFormat(value: string | null): value is "csv" | "xlsx" {
  return value === "csv" || value === "xlsx";
}

function isSupportedKind(
  value: string | null,
): value is "feed" | "excluded" | "validation" {
  return value === "feed" || value === "excluded" || value === "validation";
}

function buildFilename(
  mode: Exclude<SyncMode, "idle">,
  startedAt: string,
  kind: "feed" | "excluded" | "validation",
  format: "csv" | "xlsx",
) {
  const suffix = kind === "feed" ? "export" : kind;
  return `dpp-feed-${mode}-${suffix}-${startedAt.replaceAll(":", "-")}.${format}`;
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
  const requestedFormat = request.nextUrl.searchParams.get("format");
  const format = isSupportedFormat(requestedFormat) ? requestedFormat : "xlsx";
  const requestedKind = request.nextUrl.searchParams.get("kind");
  const kind = isSupportedKind(requestedKind) ? requestedKind : "feed";

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

    const payload =
      kind === "feed"
        ? format === "csv"
          ? buildPreviewExportCsv(artifact)
          : buildPreviewExportWorkbook(artifact)
        : kind === "excluded"
          ? format === "csv"
            ? buildExcludedExportCsv(artifact.excludedRows)
            : buildExcludedExportWorkbook({
                result: artifact,
                rows: artifact.excludedRows,
                source: "excluded_rows",
              })
          : format === "csv"
            ? buildExcludedExportCsv(artifact.validationRows)
            : buildExcludedExportWorkbook({
                result: artifact,
                rows: artifact.validationRows,
                source: "validation_rows",
              });

    return new NextResponse(payload, {
      status: 200,
      headers: {
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${buildFilename(
          artifact.mode,
          artifact.startedAt,
          kind,
          format,
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
