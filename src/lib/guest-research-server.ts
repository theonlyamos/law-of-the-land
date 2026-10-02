import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { ApiFromModules, FunctionArgs, FunctionReturnType } from "convex/server";
import type * as Runtime from "../../convex/guestResearch";
import type { GuestError } from "../../convex/lib/guestResearchContracts";
import { GUEST_RESEARCH_LIFETIME_MS } from "../../convex/lib/guestResearchContracts";
import { createWidgetServiceProof } from "../../convex/lib/widgetProof";
import { hashOpaqueTelemetryValue } from "../../convex/lib/telemetryProof";
import { applicationOrigin, readWidgetBody, trustedWidgetIp } from "./embed/server";

type RuntimeApi = ApiFromModules<{ guestResearch: typeof Runtime }>["guestResearch"];
type Operations = {
  session: RuntimeApi["createSession"];
  read: RuntimeApi["readSession"];
  begin: RuntimeApi["beginTurn"];
  finish: RuntimeApi["finishTurn"];
  adopt: RuntimeApi["adoptSession"];
};

export async function callGuestBridge<K extends keyof Operations>(
  operation: K, input: FunctionArgs<Operations[K]>, options: { signal?: AbortSignal; authToken?: string } = {},
): Promise<FunctionReturnType<Operations[K]>> {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site) throw new Error("WIDGET_UNAVAILABLE");
  const body = JSON.stringify(input), issuedAt = Date.now();
  const signature = await createWidgetServiceProof(`guest-${operation}`, issuedAt, new TextEncoder().encode(body));
  const response = await fetch(new URL(`/private/guest-research/${operation}`, site), {
    method: "POST", body, cache: "no-store", credentials: "omit",
    headers: {
      "content-type": "application/json", "x-widget-issued-at": String(issuedAt), "x-widget-signature": signature,
      ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
    },
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "AUTH_REQUIRED" : "ANSWER_UNAVAILABLE");
  return response.json();
}

const cookieName = () => process.env.NODE_ENV === "production" ? "__Host-lotl-guest-research" : "lotl-guest-research";

export async function guestSessionHash(request: Request): Promise<string | null> {
  const token = new NextRequest(request.url, { headers: request.headers }).cookies.get(cookieName())?.value;
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return hashOpaqueTelemetryValue(token);
}

export function guestJson(body: unknown, status = 200, token?: string): NextResponse {
  const response = NextResponse.json(body, { status, headers: {
    "cache-control": "no-store, private", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
  if (token) response.cookies.set(cookieName(), token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
    maxAge: GUEST_RESEARCH_LIFETIME_MS / 1000,
  });
  return response;
}

export function assertResearchRequest(request: Request) {
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== applicationOrigin(request)) || (site && !["same-origin", "none"].includes(site))) throw new Error("INVALID_REQUEST");
  if (process.env.GUEST_RESEARCH_ENABLED !== "true") throw new Error("WIDGET_UNAVAILABLE");
}

export function researchIp(request: Request): string {
  // Local development has no trusted edge header; production always uses Vercel's overwritten IP.
  if (process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) return "local-development";
  return trustedWidgetIp(request);
}

export async function researchBody(request: Request, keys: readonly string[]): Promise<Record<string, string>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("INVALID_REQUEST");
  const bytes = await readWidgetBody(request, 32_768);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("INVALID_REQUEST"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_REQUEST");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => typeof record[key] !== "string")) throw new Error("INVALID_REQUEST");
  return record as Record<string, string>;
}

export function guestError(error: GuestError): NextResponse {
  const statuses: Partial<Record<GuestError["code"], number>> = {
    INVALID_REQUEST: 400, BODY_TOO_LARGE: 413, SESSION_INVALID: 401, SESSION_EXPIRED: 410,
    AUTH_REQUIRED: 401, TRIAL_EXHAUSTED: 429, RATE_LIMITED: 429, ALLOWANCE_EXHAUSTED: 429,
    GENERATION_BUSY: 409, REQUEST_CONFLICT: 409, LIBRARY_CHANGED: 409, GENERATION_TIMEOUT: 504,
  };
  const response = guestJson({ error }, statuses[error.code] ?? 503);
  if (["SESSION_EXPIRED", "SESSION_INVALID", "LIBRARY_CHANGED"].includes(error.code)) response.cookies.set(cookieName(), "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0,
  });
  if (error.retryAfterSeconds) response.headers.set("retry-after", String(error.retryAfterSeconds));
  return response;
}

export function guestFailure(caught: unknown): NextResponse {
  const message = caught instanceof Error ? caught.message : "";
  const code = ["INVALID_REQUEST", "BODY_TOO_LARGE", "SESSION_INVALID", "AUTH_REQUIRED", "WIDGET_UNAVAILABLE"].includes(message)
    ? message as GuestError["code"] : "ANSWER_UNAVAILABLE";
  return guestError({ code, message: code === "WIDGET_UNAVAILABLE"
    ? "Guest research is unavailable right now. You can sign in to continue."
    : code === "AUTH_REQUIRED" ? "Sign in to save this research."
    : code === "SESSION_INVALID" ? "Your guest research session is unavailable. Please return to the homepage."
    : "We couldn't complete this request. Please try again." });
}
