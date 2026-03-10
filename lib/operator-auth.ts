import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env, hasEnvValue } from "@/lib/env";

const SESSION_COOKIE = "dpp_operator_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function getSessionSecret() {
  return env.dashboardSessionSecret || env.shopifyClientSecret;
}

function createSessionSignature(payload: string) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("hex");
}

function encodeSession(expiresAt: number) {
  const payload = `${expiresAt}`;
  return `${payload}.${createSessionSignature(payload)}`;
}

function decodeSession(value: string | undefined) {
  if (!value) {
    return null;
  }

  const [payload, signature] = value.split(".");

  if (!payload || !signature || !hasEnvValue(getSessionSecret())) {
    return null;
  }

  const expected = createSessionSignature(payload);

  if (expected.length !== signature.length) {
    return null;
  }

  if (
    !crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    )
  ) {
    return null;
  }

  const expiresAt = Number.parseInt(payload, 10);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  return {
    expiresAt,
  };
}

function passwordsMatch(input: string, configured: string) {
  const inputBuffer = Buffer.from(input, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");

  if (inputBuffer.length !== configuredBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(inputBuffer, configuredBuffer);
}

export function isOperatorAuthConfigured() {
  return (
    hasEnvValue(env.dashboardPassword) &&
    hasEnvValue(env.dashboardSessionSecret || env.shopifyClientSecret)
  );
}

export async function isOperatorAuthenticated() {
  if (!isOperatorAuthConfigured()) {
    return false;
  }

  const cookieStore = await cookies();
  return Boolean(
    decodeSession(cookieStore.get(SESSION_COOKIE)?.value),
  );
}

export async function requireOperatorAuthentication() {
  const authenticated = await isOperatorAuthenticated();

  if (!authenticated) {
    redirect("/login");
  }
}

export async function signInOperator(password: string) {
  if (!isOperatorAuthConfigured()) {
    return false;
  }

  if (!passwordsMatch(password, env.dashboardPassword)) {
    return false;
  }

  const cookieStore = await cookies();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  cookieStore.set(SESSION_COOKIE, encodeSession(expiresAt), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });

  return true;
}

export async function signOutOperator() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
