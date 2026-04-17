import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getOperatorSessionCookieName,
  isOperatorAuthConfigured,
  isValidOperatorSessionValue,
} from "@/lib/operator-auth";
import { getSyncSettings } from "@/lib/operator-store";
import { runSync, type SyncMode } from "@/lib/sync";

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
  const mode = formData.get("mode");

  if (!isSupportedMode(mode)) {
    return redirectToDashboard(request, "test-export-invalid");
  }

  const settings = await getSyncSettings();
  const result = await runSync(mode, {
    trigger: "manual",
    purpose: "test-save",
    dryRun: true,
    settings,
    prepareExportArtifact: true,
  });

  return redirectToDashboard(
    request,
    result.ok ? "test-export-ready" : "test-export-failed",
  );
}
