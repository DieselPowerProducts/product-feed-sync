import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildRunArtifactWorkbook } from "@/lib/feed-export";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { readRunArtifact } from "@/lib/operator-store";
import type { SyncRunArtifact } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildFilename(id: string) {
  return `dpp-feed-run-sample-${id}.xlsx`;
}

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
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

  const { id } = await context.params;
  const artifact = await readRunArtifact<SyncRunArtifact>(id);

  if (!artifact) {
    return NextResponse.json(
      {
        ok: false,
        error: "Run artifact not found.",
      },
      { status: 404 },
    );
  }

  const workbook = buildRunArtifactWorkbook(artifact);

  return new NextResponse(workbook, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${buildFilename(id)}"`,
      "Cache-Control": "no-store",
    },
  });
}
