import { redirect } from "next/navigation";
import { isOperatorAuthenticated } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (await isOperatorAuthenticated()) {
    redirect("/dashboard");
  }

  redirect("/login");
}
