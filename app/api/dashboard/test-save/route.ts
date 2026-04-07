import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import {
  clearScheduledTestExport,
  getSyncSettings,
  saveScheduledTestExport,
} from "@/lib/operator-store";
import { runSync, type SyncMode } from "@/lib/sync";
import { getTomorrowPacificTestExportRunAt } from "@/lib/test-save";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function isSupportedMode(
  value: FormDataEntryValue | null,
): value is Exclude<SyncMode, "idle"> {
  return value === "delta" || value === "full";
}

function redirectToDashboard(request: NextRequest, saved: string) {
  const url = new URL("/dashboard", request.url);
  url.searchParams.set("saved", saved);
  return NextResponse.redirect(url, { status: 303 });
}

function redirectToLogin(request: NextRequest) {
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}

export async function POST(request: NextRequest) {
  if (
    !isOperatorAuthConfigured() ||
    !isValidOperatorSessionValue(
      request.cookies.get(getOperatorSessionCookieName())?.value,
    )
  ) {
    return redirectToLogin(request);
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "cancel") {
    await clearScheduledTestExport();
    return redirectToDashboard(request, "test-export-cancelled");
  }

  const mode = formData.get("mode");

  if (!isSupportedMode(mode)) {
    return redirectToDashboard(request, "test-export-invalid");
  }

  const scheduleTomorrow =
    formData.get("scheduleTomorrow") === "on" ||
    formData.get("scheduleTomorrow") === "true";

  if (scheduleTomorrow) {
    await saveScheduledTestExport({
      mode,
      runAt: getTomorrowPacificTestExportRunAt().toISOString(),
      requestedAt: new Date().toISOString(),
    });
    return redirectToDashboard(request, "test-export-scheduled");
  }

  const settings = await getSyncSettings();
  const result = await runSync(mode, {
    trigger: "manual",
    dryRun: settings.defaultDryRun,
    settings,
    prepareExportArtifact: true,
  });

  return redirectToDashboard(
    request,
    result.ok ? "test-export-ready" : "test-export-failed",
  );
}
