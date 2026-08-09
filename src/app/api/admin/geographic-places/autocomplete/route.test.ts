import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  fetchAuthQuery: vi.fn(),
}));
const placesMocks = vi.hoisted(() => ({ autocompletePlaces: vi.fn() }));
const rateLimitMocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("@/lib/google-places", () => placesMocks);
vi.mock("@/lib/rate-limit", () => rateLimitMocks);

import { POST } from "./route";

const sessionToken = "de305d54-75b4-431b-adb2-eb6b9e546014";

function request(body: string | Record<string, unknown>, contentLength?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/admin/geographic-places/autocomplete", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/admin/geographic-places/autocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthQuery.mockResolvedValue("admin-actor-1");
    rateLimitMocks.rateLimit.mockReturnValue({ ok: true, retryAfterSeconds: 0 });
    placesMocks.autocompletePlaces.mockResolvedValue([
      { placeId: "place-1", primaryText: "Accra", secondaryText: "Ghana", types: ["locality"] },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects too-short and invalid-session requests before authentication or Google", async () => {
    expect((await POST(request({ input: "Ac", sessionToken }))).status).toBe(400);
    expect((await POST(request({ input: "Acc", sessionToken: "de305d54-75b4-131b-adb2-eb6b9e546014" }))).status).toBe(400);
    expect((await POST(request({ input: "Acc", sessionToken: "de305d54-75b4-431b-7db2-eb6b9e546014" }))).status).toBe(400);
    expect(authMocks.isAuthenticated).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();
  });

  it("fails closed when authorization returns a malformed actor ID", async () => {
    authMocks.fetchAuthQuery.mockResolvedValueOnce("");

    const response = await POST(request({ input: "Acc", sessionToken }));

    expect(response.status).toBe(503);
    expect(rateLimitMocks.rateLimit).not.toHaveBeenCalled();
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();
  });

  it("stream-bounds the body even when Content-Length is absent or falsely small", async () => {
    const valid = JSON.stringify({ input: "Acc", sessionToken });
    const oversized = `${valid}${" ".repeat(1_025 - valid.length)}`;

    expect((await POST(request(oversized))).status).toBe(400);
    expect((await POST(request(oversized, "1"))).status).toBe(400);
    expect(authMocks.isAuthenticated).not.toHaveBeenCalled();
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated or unauthorized requests before Google", async () => {
    authMocks.isAuthenticated.mockResolvedValueOnce(false);
    expect((await POST(request({ input: "Acc", sessionToken }))).status).toBe(401);
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();

    authMocks.fetchAuthQuery.mockRejectedValueOnce({ data: { code: "ADMIN_FORBIDDEN" } });
    expect((await POST(request({ input: "Acc", sessionToken }))).status).toBe(403);
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();
  });

  it("authorizes before using the actor-derived rate limit key and Google", async () => {
    const response = await POST(request({ input: "  Acc  ", sessionToken }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [
      { placeId: "place-1", primaryText: "Accra", secondaryText: "Ghana", types: ["locality"] },
    ] });
    expect(getFunctionName(authMocks.fetchAuthQuery.mock.calls[0][0])).toBe(
      "admin/jurisdictions:assertCanManageJurisdictions",
    );
    expect(authMocks.fetchAuthQuery.mock.calls[0][1]).toEqual({});
    expect(rateLimitMocks.rateLimit).toHaveBeenCalledWith("places:admin-actor-1", expect.any(Number));
    expect(placesMocks.autocompletePlaces).toHaveBeenCalledWith("Acc", sessionToken);
    expect(authMocks.fetchAuthQuery.mock.invocationCallOrder[0]).toBeLessThan(
      placesMocks.autocompletePlaces.mock.invocationCallOrder[0],
    );
  });

  it("returns Retry-After and makes no paid request when rate limited", async () => {
    rateLimitMocks.rateLimit.mockReturnValueOnce({ ok: false, retryAfterSeconds: 42 });

    const response = await POST(request({ input: "Acc", sessionToken }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(placesMocks.autocompletePlaces).not.toHaveBeenCalled();
  });
});
