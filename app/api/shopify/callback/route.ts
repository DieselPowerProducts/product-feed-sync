import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  exchangeCodeForAccessToken,
  fetchShopConnectionDetails,
  getShopifyCallbackUrl,
  getShopifyCookieNames,
  isValidShopifyCallback,
  normalizeShopDomain,
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
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const shop = normalizeShopDomain(request.nextUrl.searchParams.get("shop"));
  const storedState = request.cookies.get(getShopifyCookieNames().state)?.value;

  if (!code || !state || !shop) {
    return renderPage({
      title: "Shopify callback error",
      status: 400,
      body: `
        <h1>Missing required Shopify callback parameters</h1>
        <p>The callback needs <code>code</code>, <code>state</code>, and <code>shop</code>.</p>
        <p>Configured callback URL: <code>${escapeHtml(getShopifyCallbackUrl(request))}</code></p>
      `,
    });
  }

  if (!storedState || storedState !== state) {
    return renderPage({
      title: "Shopify state mismatch",
      status: 400,
      body: `
        <h1>State validation failed</h1>
        <p>The OAuth state in the callback did not match the state cookie.</p>
        <p>Start the install flow again from <a href="/api/shopify/install">/api/shopify/install</a>.</p>
      `,
    });
  }

  if (!isValidShopifyCallback(request)) {
    return renderPage({
      title: "Shopify signature mismatch",
      status: 400,
      body: `
        <h1>HMAC validation failed</h1>
        <p>The Shopify callback signature could not be verified.</p>
      `,
    });
  }

  try {
    const tokenResponse = await exchangeCodeForAccessToken({
      code,
      shop,
    });

    const connection = await fetchShopConnectionDetails({
      shop,
      accessToken: tokenResponse.access_token,
    });

    const response = renderPage({
      title: connection.connected
        ? "Shopify connected"
        : "Shopify token received but verification failed",
      status: connection.connected ? 200 : 502,
      body: connection.connected
        ? `
          <h1>Shopify handshake succeeded</h1>
          <p>The app successfully exchanged the authorization code for an offline Admin API token and verified the store connection.</p>
          <p><strong>Connected shop:</strong> ${escapeHtml(connection.shop?.name ?? "Unknown")} (${escapeHtml(connection.shop?.myshopifyDomain ?? shop)})</p>
          <p><strong>Primary domain:</strong> ${escapeHtml(connection.shop?.primaryDomainUrl ?? "Not returned")}</p>
          <p><strong>Granted scopes:</strong> ${escapeHtml(tokenResponse.scope ?? "Not returned by Shopify")}</p>
          <h2>Next step</h2>
          <p>Copy the token below into the Vercel environment variable <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code>, save it, and redeploy.</p>
          <pre>${escapeHtml(tokenResponse.access_token)}</pre>
          <p>Treat that token like a password. After you save it in Vercel, open <a href="/api/shopify/status">/api/shopify/status</a> to confirm the deployed app can talk to Shopify with its runtime credentials.</p>
        `
        : `
          <h1>Token exchange worked, but the verification request failed</h1>
          <p>Shopify returned an access token, but the follow-up shop query did not succeed.</p>
          <p><strong>Error:</strong> ${escapeHtml(connection.error ?? "Unknown error")}</p>
          <p>You can retry the install flow from <a href="/api/shopify/install">/api/shopify/install</a>.</p>
        `,
    });

    response.cookies.delete(getShopifyCookieNames().state);
    response.cookies.set(getShopifyCookieNames().connectedShop, shop, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    response.cookies.set(
      getShopifyCookieNames().verifiedAt,
      new Date().toISOString(),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      },
    );

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Shopify callback error.";

    const response = renderPage({
      title: "Shopify callback failed",
      status: 500,
      body: `
        <h1>Shopify callback failed</h1>
        <p>${escapeHtml(message)}</p>
        <p>Configured callback URL: <code>${escapeHtml(getShopifyCallbackUrl(request))}</code></p>
      `,
    });

    response.cookies.delete(getShopifyCookieNames().state);

    return response;
  }
}
