import type { NextRequest } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { getSyncSettings } from "@/lib/operator-store";
import { runSync, type SyncMode, type SyncProgressUpdate } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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

function encodeEvent(
  encoder: TextEncoder,
  event: "progress" | "complete" | "failure",
  payload: unknown,
) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: NextRequest) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const mode = request.nextUrl.searchParams.get("mode");

  if (!isSupportedMode(mode)) {
    return new Response("Use ?mode=delta or ?mode=full.", { status: 400 });
  }

  const settings = await getSyncSettings();
  const limit = readPreviewLimit(
    request.nextUrl.searchParams.get("limit"),
    settings.previewLimit,
  );
  const exhaustive = readBooleanish(
    request.nextUrl.searchParams.get("exhaustive"),
  );
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendProgress = async (update: SyncProgressUpdate) => {
        controller.enqueue(encodeEvent(encoder, "progress", update));
      };

      try {
        const result = await runSync(mode, {
          trigger: "manual",
          dryRun: true,
          previewLimit: limit,
          persistHistory: false,
          settings,
          exhaustive,
          onProgress: sendProgress,
        });

        controller.enqueue(encodeEvent(encoder, "complete", result));
      } catch (error) {
        controller.enqueue(
          encodeEvent(encoder, "failure", {
            message:
              error instanceof Error ? error.message : "Unknown preview stream error.",
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
