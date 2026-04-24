import { NextResponse } from "next/server";
import { isOperatorAuthenticated } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (!(await isOperatorAuthenticated())) {
    return NextResponse.json(
      {
        ok: false,
        error: "Operator authentication required.",
      },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    disabled: true,
    message:
      "Shopify product webhooks are disabled. Delta sync now reads Shopify changes during the scheduled cron run only.",
  });
}
