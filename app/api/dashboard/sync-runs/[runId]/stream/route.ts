import type { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import type { LiveMerchantSyncWorkflowEvent } from "@/workflows/live-merchant-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function parseEventIndex(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { runId } = await params;

  let run;
  try {
    run = await getRun(runId);
  } catch {
    return new Response("Run not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const requestedStartIndex =
    parseEventIndex(request.nextUrl.searchParams.get("startIndex")) ??
    (() => {
      const lastEventId = parseEventIndex(request.headers.get("last-event-id"));
      return lastEventId === null ? null : lastEventId + 1;
    })();

  const readable = run.getReadable<LiveMerchantSyncWorkflowEvent>(
    requestedStartIndex === null ? undefined : { startIndex: requestedStartIndex },
  );
  let eventIndex = requestedStartIndex ?? 0;
  const stream = readable.pipeThrough(
    new TransformStream<LiveMerchantSyncWorkflowEvent, Uint8Array>({
      transform(chunk, controller) {
        const nextEventId = eventIndex;
        eventIndex += 1;

        if (chunk?.type === "result") {
          controller.enqueue(
            encoder.encode(
              `id: ${nextEventId}\nevent: result\ndata: ${JSON.stringify(chunk.result)}\n\n`,
            ),
          );
          return;
        }

        controller.enqueue(
          encoder.encode(
            `id: ${nextEventId}\nevent: progress\ndata: ${JSON.stringify(chunk.progress)}\n\n`,
          ),
        );
      },
    }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
