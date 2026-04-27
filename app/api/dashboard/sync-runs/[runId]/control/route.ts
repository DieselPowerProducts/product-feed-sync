import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import {
  clearActiveSyncRun,
  getActiveSyncRun,
  updateActiveSyncRun,
  updateCronInvocationByRunId,
} from "@/lib/operator-store";

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
    | { action?: "pause" | "resume" | "stop" | "cancel" }
    | null;

  if (
    body?.action !== "pause" &&
    body?.action !== "resume" &&
    body?.action !== "stop" &&
    body?.action !== "cancel"
  ) {
    return NextResponse.json(
      {
        ok: false,
        message: "Use action=pause, action=resume, action=stop, or action=cancel.",
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

  if (body.action === "cancel") {
    try {
      const run = await getRun(runId);
      await run.cancel();
      await run.wakeUp().catch(() => null);
    } catch (error) {
      console.warn("[dashboard/sync-runs/control] Workflow cancel failed.", {
        runId,
        error,
      });
    }

    await updateCronInvocationByRunId(runId, {
      outcome: "cancelled",
      message:
        "Operator cancelled and cleared the active live sync from the dashboard.",
    });
    await clearActiveSyncRun(runId);

    return NextResponse.json({
      ok: true,
      activeRun: null,
      message: "The active workflow was cancelled and cleared.",
    });
  }

  const nextState =
    body.action === "pause"
      ? {
          controlState: "pause_requested" as const,
          message:
            "Pause requested. The sync will stop after the current batch finishes.",
        }
      : body.action === "stop"
        ? {
            controlState: "stop_requested" as const,
            message:
              "Stop requested. The sync will save a restart checkpoint at the next safe boundary.",
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
