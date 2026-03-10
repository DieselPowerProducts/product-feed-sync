import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env, hasEnvValue } from "@/lib/env";
import {
  buildShopifyInstallUrl,
  createOauthState,
  exchangeClientCredentialsForAccessToken,
  fetchShopConnectionDetails,
  getRequestedShopDomain,
  getShopifyCookieNames,
} from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(params: {
  title: string;
  body: string;
  status?: number;
}) {
  return new NextResponse(
    `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${escapeHtml(params.title)}</title>
          <style>
            body {
              margin: 0;
              font-family: Arial, sans-serif;
              background: #f5efe5;
              color: #18120d;
            }
            main {
              max-width: 760px;
              margin: 48px auto;
              padding: 32px;
              background: rgba(255, 250, 244, 0.92);
              border: 1px solid rgba(24, 18, 13, 0.12);
              border-radius: 24px;
            }
            code, pre {
              font-family: Consolas, monospace;
              background: #f1e7d9;
              border-radius: 12px;
            }
            pre {
              overflow-x: auto;
              padding: 16px;
              white-space: pre-wrap;
              word-break: break-word;
            }
            a {
              color: #8f3600;
            }
          </style>
        </head>
        <body>
          <main>
            ${params.body}
          </main>
        </body>
      </html>
    `,
    {
      status: params.status ?? 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}

export async function GET(request: NextRequest) {
  const shop = getRequestedShopDomain(request);
  const mode = request.nextUrl.searchParams.get("mode") ?? env.shopifyAuthMode;

  if (!shop) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing or invalid Shopify store domain. Set SHOPIFY_STORE_DOMAIN or pass ?shop=your-store.myshopify.com.",
      },
      { status: 400 },
    );
  }

  if (
    !hasEnvValue(env.shopifyClientId) ||
    !hasEnvValue(env.shopifyClientSecret)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET in the environment.",
      },
      { status: 400 },
    );
  }

  if (mode !== "oauth") {
    try {
      const token = await exchangeClientCredentialsForAccessToken({
        shop,
      });
      const connection = await fetchShopConnectionDetails({
        shop,
        accessToken: token.access_token,
      });

      return renderPage({
        title: connection.connected
          ? "Shopify connected"
          : "Shopify token received but verification failed",
        status: connection.connected ? 200 : 502,
        body: connection.connected
          ? `
            <h1>Shopify connection succeeded</h1>
            <p>The app successfully exchanged its client credentials for a temporary Admin API token and verified the Shopify connection.</p>
            <p><strong>Connected shop:</strong> ${escapeHtml(connection.shop?.name ?? "Unknown")} (${escapeHtml(connection.shop?.myshopifyDomain ?? shop)})</p>
            <p><strong>Primary domain:</strong> ${escapeHtml(connection.shop?.primaryDomainUrl ?? "Not returned")}</p>
            <p><strong>Granted scopes:</strong> ${escapeHtml(token.scope ?? "Not returned by Shopify")}</p>
            <p><strong>Token source:</strong> client_credentials</p>
            <p><strong>Token expiry:</strong> ${escapeHtml(String(token.expires_in ?? "Not returned"))} second(s)</p>
            <h2>Next step</h2>
            <p>No manual access-token env var is required for this mode. Open <a href="/api/shopify/status">/api/shopify/status</a> to confirm the deployed app can mint a token and query Shopify at runtime.</p>
            <p>If you specifically need browser OAuth for this app, use <a href="/api/shopify/install?mode=oauth">/api/shopify/install?mode=oauth</a> after aligning the Shopify app URL and redirect host.</p>
          `
          : `
            <h1>Shopify token exchange worked, but verification failed</h1>
            <p>The app received a client-credentials token, but the follow-up shop query did not succeed.</p>
            <p><strong>Error:</strong> ${escapeHtml(connection.error ?? "Unknown error")}</p>
          `,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown Shopify client credentials error.";

      return renderPage({
        title: "Shopify connection failed",
        status: 500,
        body: `
          <h1>Shopify client-credentials connection failed</h1>
          <p>${escapeHtml(message)}</p>
          <p>If this app was not created as an internal server-to-server app, you can retry with <a href="/api/shopify/install?mode=oauth">browser OAuth mode</a>.</p>
        `,
      });
    }
  }

  const state = createOauthState();
  const response = NextResponse.redirect(
    buildShopifyInstallUrl({
      request,
      shop,
      state,
    }),
  );

  response.cookies.set(getShopifyCookieNames().state, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });

  return response;
}
