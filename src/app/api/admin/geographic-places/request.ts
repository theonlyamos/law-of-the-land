import { api } from "../../../../../convex/_generated/api";
import { isAdminAccessDenial } from "@/lib/admin/server";
import { fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";
import { rateLimit } from "@/lib/rate-limit";

const MAX_BODY_BYTES = 1_024;
const PLACES_REQUESTS_PER_MINUTE = 60;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE_HEADERS = { "cache-control": "no-store" };

export function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export async function readBoundedObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function authorizePlacesRequest(): Promise<
  | { actorId: string; response?: never }
  | { actorId?: never; response: Response }
> {
  try {
    if (!(await isAuthenticated())) {
      return {
        response: json({ error: "Sign in to manage jurisdictions." }, 401),
      };
    }
  } catch {
    return {
      response: json({ error: "Authorization is temporarily unavailable." }, 503),
    };
  }

  let actorId: string;
  try {
    actorId = await fetchAuthQuery(
      api.admin.jurisdictions.assertCanManageJurisdictions,
      {},
    );
  } catch (error) {
    if (isAdminAccessDenial(error)) {
      return {
        response: json({ error: "You do not have permission to manage jurisdictions." }, 403),
      };
    }
    return {
      response: json({ error: "Authorization is temporarily unavailable." }, 503),
    };
  }
  if (typeof actorId !== "string" || !actorId || actorId.length > 500) {
    return {
      response: json({ error: "Authorization is temporarily unavailable." }, 503),
    };
  }

  // This per-process limit is only a first line of defense. Google Cloud quota
  // remains the cross-instance billing guard.
  const limit = rateLimit(`places:${actorId}`, PLACES_REQUESTS_PER_MINUTE);
  if (!limit.ok) {
    return {
      response: json(
        { error: "Too many place requests. Wait a moment and try again." },
        429,
        { "Retry-After": String(limit.retryAfterSeconds) },
      ),
    };
  }
  return { actorId };
}
