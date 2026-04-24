"use server";

import { redirect } from "next/navigation";
import {
  isOperatorAuthenticated,
  signOutOperator,
} from "@/lib/operator-auth";
import {
  clearLiveSyncRestartCheckpoint,
  deleteCronInvocationEntry,
  deleteSyncHistoryEntry,
  getBootstrapState,
  getSyncSettings,
  saveSyncSettings,
} from "@/lib/operator-store";
import { restartLiveSyncFromCheckpointJob } from "@/lib/live-sync-jobs";
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

export async function deleteCronInvocationAction(formData: FormData) {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  const entryId = String(formData.get("entryId") ?? "").trim();

  if (!entryId) {
    redirect("/dashboard?saved=cron-delete-invalid");
  }

  const deleted = await deleteCronInvocationEntry(entryId);
  redirect(
    deleted
      ? "/dashboard?saved=cron-deleted"
      : "/dashboard?saved=cron-delete-invalid",
  );
}

export async function restartCheckpointAction() {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  const result = await restartLiveSyncFromCheckpointJob();

  if (!result.ok) {
    redirect("/dashboard?saved=checkpoint-restart-invalid");
  }

  redirect("/dashboard?saved=checkpoint-restart-started");
}

export async function discardCheckpointAction() {
  if (!(await isOperatorAuthenticated())) {
    redirect("/login");
  }

  const cleared = await clearLiveSyncRestartCheckpoint();
  redirect(
    cleared
      ? "/dashboard?saved=checkpoint-cleared"
      : "/dashboard?saved=checkpoint-restart-invalid",
  );
}
