"use server";

import { redirect } from "next/navigation";
import { signInOperator } from "@/lib/operator-auth";

export async function loginAction(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const authenticated = await signInOperator(password);

  if (!authenticated) {
    redirect("/login?error=invalid");
  }

  redirect("/dashboard");
}
