import { NextResponse } from "next/server";
import { isOperatorAuthenticated } from "@/lib/operator-auth";
import { ensureShopifyProductsDeleteWebhook } from "@/lib/shopify";

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

  try {
    const productsDelete = await ensureShopifyProductsDeleteWebhook();

    return NextResponse.json({
      ok: true,
      mode: "delete_webhook_only",
      message:
        "Only the Shopify products/delete webhook is enabled. Product updates are handled during the scheduled cron delta.",
      webhooks: {
        productsDelete,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Shopify webhook registration error.",
      },
      { status: 500 },
    );
  }
}
