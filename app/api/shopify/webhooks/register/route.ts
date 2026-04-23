import { NextResponse } from "next/server";
import { isOperatorAuthenticated } from "@/lib/operator-auth";
import {
  ensureShopifyProductsCreateWebhook,
  ensureShopifyProductsDeleteWebhook,
  ensureShopifyProductsUpdateWebhook,
} from "@/lib/shopify";

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
    const [productsCreate, productsUpdate, productsDelete] = await Promise.all([
      ensureShopifyProductsCreateWebhook(),
      ensureShopifyProductsUpdateWebhook(),
      ensureShopifyProductsDeleteWebhook(),
    ]);

    return NextResponse.json({
      ok: true,
      webhooks: {
        productsCreate,
        productsUpdate,
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
