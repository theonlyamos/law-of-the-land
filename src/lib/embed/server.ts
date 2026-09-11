import "server-only";
import { isIP } from "node:net";
import { createHmac } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type ApiFromModules, type FunctionArgs, type FunctionReturnType } from "convex/server";
import type * as Runtime from "../../../convex/widgetRuntime";
import { createWidgetServiceProof } from "../../../convex/lib/widgetProof";
import { hashOpaqueTelemetryValue } from "../../../convex/lib/telemetryProof";
import type { WidgetConfig, WidgetError, WidgetErrorCode } from "../../../convex/lib/widgetContracts";

type RuntimeApi = ApiFromModules<{ widgetRuntime: typeof Runtime }>["widgetRuntime"];
type Operations = { session: RuntimeApi["createSession"]; begin: RuntimeApi["beginTurn"]; finish: RuntimeApi["finishTurn"]; read: RuntimeApi["readTurn"]; cancel: RuntimeApi["cancelTurn"]; revoke: RuntimeApi["revokeSession"] };
export async function callWidgetBridge<K extends keyof Operations>(operation: K, input: FunctionArgs<Operations[K]>, signal?: AbortSignal): Promise<FunctionReturnType<Operations[K]>> {
  const origin = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!origin) throw new Error("WIDGET_UNAVAILABLE");
  const body = JSON.stringify(input), issuedAt = Date.now();
  const signature = await createWidgetServiceProof(operation, issuedAt, new TextEncoder().encode(body));
  const response = await fetch(new URL(`/private/widget/${operation}`, origin), { method: "POST", headers: { "content-type": "application/json", "x-widget-issued-at": String(issuedAt), "x-widget-signature": signature }, body, cache: "no-store", credentials: "omit", signal: signal ?? AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("ANSWER_UNAVAILABLE");
  return response.json();
}
export async function publicWidgetConfig(publicId: string, parentOrigin: string): Promise<WidgetConfig | null> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  return new ConvexHttpClient(url).query(makeFunctionReference<"query", { publicId: string; parentOrigin: string }, WidgetConfig | null>("widgets:getPublicConfig"), { publicId, parentOrigin });
}
export function trustedWidgetIp(request: Request): string {
  const secret = process.env.WIDGET_IP_HASH_SECRET;
  if (!secret || secret.length < 32) throw new Error("WIDGET_UNAVAILABLE");
  // Vercel overwrites this header at its edge; never accept generic forwarded-for.
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : process.env.NODE_ENV === "test" ? "127.0.0.1" : null;
  if (!ip || !isIP(ip)) throw new Error("WIDGET_UNAVAILABLE");
  return createHmac("sha256", secret).update(`${new Date().toISOString().slice(0, 10)}:${ip}`).digest("base64url");
}
export function applicationOrigin(request: Request): string {
  // Next's internal request URL may use localhost behind a reverse proxy.
  return new URL(process.env.SITE_URL || request.url).origin;
}
export function assertGuestRequest(request: Request) {
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== applicationOrigin(request)) || (site && !["same-origin", "none"].includes(site))) throw new Error("INVALID_REQUEST");
  if (process.env.WIDGET_CHAT_ENABLED !== "true") throw new Error("WIDGET_UNAVAILABLE");
}
export async function guestTokenHash(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new Error("SESSION_INVALID");
  return hashOpaqueTelemetryValue(authorization.slice(7));
}
export function widgetErrorResponse(error: WidgetError): Response {
  const statuses: Record<WidgetErrorCode, number> = { INVALID_REQUEST: 400, BODY_TOO_LARGE: 413, WIDGET_UNAVAILABLE: 404, SESSION_EXPIRED: 401, SESSION_INVALID: 401, RATE_LIMITED: 429, ALLOWANCE_EXHAUSTED: 429, GENERATION_BUSY: 429, REQUEST_CONFLICT: 409, LIBRARY_CHANGED: 409, GENERATION_TIMEOUT: 504, ANSWER_UNAVAILABLE: 503, TURN_NOT_FOUND: 404 };
  return Response.json({ error }, { status: statuses[error.code], headers: { "cache-control": "no-store", ...(error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {}) } });
}
export function widgetFailureResponse(caught: unknown) {
  const message = caught instanceof Error ? caught.message : "";
  const code = ["INVALID_REQUEST", "BODY_TOO_LARGE", "SESSION_INVALID", "WIDGET_UNAVAILABLE"].includes(message) ? message as WidgetErrorCode : "ANSWER_UNAVAILABLE";
  return widgetErrorResponse({ code, message: code === "WIDGET_UNAVAILABLE" ? "This assistant isn't available right now. Please contact the organization for help." : code === "BODY_TOO_LARGE" ? "This question is too large to send." : "We couldn't complete this request. Please try again." });
}

export async function readWidgetBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error("BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
