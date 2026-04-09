"use server";

import { redirect } from "next/navigation";
import {
  isOperatorAuthenticated,
  signOutOperator,
} from "@/lib/operator-auth";
import {
  deleteSyncHistoryEntry,
  saveSyncSettings,
} from "@/lib/operator-store";

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
    lookbackDays: readPositiveInteger(formData.get("lookbackDays"), 8),
    defaultDryRun:
      formData.get("defaultDryRun") === "on" ||
      formData.get("defaultDryRun") === "true",
  });

  redirect("/dashboard?saved=settings");
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
