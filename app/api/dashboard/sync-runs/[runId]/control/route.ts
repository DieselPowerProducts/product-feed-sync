import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { getActiveSyncRun, updateActiveSyncRun } from "@/lib/operator-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        message: "Unauthorized",
      },
      { status: 401 },
    );
  }

  const { runId } = await params;
  const body = (await request.json().catch(() => null)) as
    | { action?: "pause" | "resume" }
    | null;

  if (body?.action !== "pause" && body?.action !== "resume") {
    return NextResponse.json(
      {
        ok: false,
        message: "Use action=pause or action=resume.",
      },
      { status: 400 },
    );
  }

  const activeRun = await getActiveSyncRun();

  if (!activeRun || activeRun.runId !== runId) {
    return NextResponse.json(
      {
        ok: false,
        message: "That sync run is no longer active.",
      },
      { status: 409 },
    );
  }

  const nextState =
    body.action === "pause"
      ? {
          controlState: "pause_requested" as const,
          message:
            "Pause requested. The sync will stop after the current batch finishes.",
        }
      : {
          controlState: "running" as const,
          message: "Resume requested. The sync will continue shortly.",
        };

  const updatedRun = await updateActiveSyncRun(runId, nextState);

  if (!updatedRun) {
    return NextResponse.json(
      {
        ok: false,
        message: "That sync run is no longer active.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    activeRun: updatedRun,
  });
}
