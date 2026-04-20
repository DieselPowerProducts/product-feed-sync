"use server";

import { redirect } from "next/navigation";
import {
  isOperatorAuthenticated,
  signOutOperator,
} from "@/lib/operator-auth";
import {
  deleteSyncHistoryEntry,
  getBootstrapState,
  getSyncSettings,
  saveSyncSettings,
} from "@/lib/operator-store";
import { runSync } from "@/lib/sync";

function readPositiveInteger(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function saveSettingsAction(formData: FormData) {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  await saveSyncSettings({
    anchorDate: String(formData.get("anchorDate") ?? ""),
    deltaIntervalDays: readPositiveInteger(formData.get("deltaIntervalDays"), 7),
    fullIntervalDays: readPositiveInteger(formData.get("fullIntervalDays"), 15),
  });

  redirect("/dashboard?saved=settings");
}

export async function runFirstFullSyncAction() {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  const bootstrap = await getBootstrapState();

  if (bootstrap.firstFullSyncCompletedAt) {
    redirect("/dashboard?saved=first-full-already-complete");
  }

  const settings = await getSyncSettings();
  const result = await runSync("full", {
    trigger: "manual",
    purpose: "sync",
    dryRun: false,
    settings,
    prepareExportArtifact: true,
  });

  redirect(
    result.ok
      ? "/dashboard?saved=first-full-success"
      : "/dashboard?saved=first-full-failed",
  );
}

export async function logoutAction() {
  await signOutOperator();
  redirect("/login");
}

export async function deleteHistoryEntryAction(formData: FormData) {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  const entryId = String(formData.get("entryId") ?? "").trim();

  if (!entryId) {
    redirect("/dashboard?saved=history-delete-invalid");
  }

  await deleteSyncHistoryEntry(entryId);
  redirect("/dashboard?saved=history-deleted");
}
