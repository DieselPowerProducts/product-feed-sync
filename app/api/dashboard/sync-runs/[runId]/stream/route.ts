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
  const readable = run.getReadable<LiveMerchantSyncWorkflowEvent>();
  const stream = readable.pipeThrough(
    new TransformStream<LiveMerchantSyncWorkflowEvent, Uint8Array>({
      transform(chunk, controller) {
        if (chunk?.type === "result") {
          controller.enqueue(
            encoder.encode(`event: result\ndata: ${JSON.stringify(chunk.result)}\n\n`),
          );
          return;
        }

        controller.enqueue(
          encoder.encode(
            `event: progress\ndata: ${JSON.stringify(chunk.progress)}\n\n`,
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
