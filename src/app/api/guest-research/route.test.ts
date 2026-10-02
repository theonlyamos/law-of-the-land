import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bridge: vi.fn(), run: vi.fn(), getToken: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/guest-research-server", async importOriginal => ({
  ...await importOriginal<object>(), callGuestBridge: mocks.bridge,
}));
vi.mock("@/lib/auth-server", () => ({ getToken: mocks.getToken }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));
vi.mock("@/lib/gemini-file-search-chat", () => ({ GeminiFileSearchChat: class { run = mocks.run; } }));

import { GET, PUT, POST } from "./route";
import { POST as claim } from "./claim/route";

const requestId = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(43);
const session = { jurisdictionId: "ghana", jurisdictionName: "Ghana", jurisdictionKind: "geographic", expiresAt: Date.now() + 86400000, remaining: 2, turns: [] };
const admission = { kind: "admitted", turnId: "turn", attemptNonce: "nonce", manifest: { stores: [{ jurisdictionId: "ghana", name: "Ghana", kind: "geographic", relation: "selected", storeName: "fileSearchStores/ghana" }], partialCoverage: false, authorizedScopeSize: 1 }, messages: [] };

function request(method: string, body?: unknown, cookie = true, headers: Record<string, string> = {}) {
  return new Request("https://law.test/api/guest-research", {
    method, headers: { origin: "https://law.test", "content-type": "application/json", ...(cookie ? { cookie: `lotl-guest-research=${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GUEST_RESEARCH_ENABLED", "true");
  vi.stubEnv("SITE_URL", "https://law.test");
  vi.stubEnv("WIDGET_IP_HASH_SECRET", "s".repeat(32));
  vi.stubEnv("GOOGLE_AI_API_KEY", "test");
  vi.stubEnv("NODE_ENV", "test");
  mocks.getToken.mockResolvedValue("account-jwt");
});
afterEach(() => vi.unstubAllEnvs());

it("creates the HttpOnly session before generation and restores it on reload", async () => {
  expect(await (await GET(request("GET", undefined, false))).json()).toBeNull();
  mocks.bridge.mockResolvedValue(session);
  const created = await PUT(request("PUT", { jurisdictionId: "ghana" }, false));
  expect(created.status).toBe(200);
  expect(created.headers.get("set-cookie")).toMatch(/lotl-guest-research=[A-Za-z0-9_-]{43}/);
  expect(created.headers.get("set-cookie")).toContain("HttpOnly");
  expect(created.headers.get("set-cookie")).toContain("SameSite=lax");
  expect(mocks.run).not.toHaveBeenCalled();
  expect(await (await GET(request("GET"))).json()).toEqual(session);
});

it("rejects cross-site requests, extra fields and generation without a session", async () => {
  expect((await PUT(request("PUT", { jurisdictionId: "ghana" }, false, { origin: "https://evil.test" }))).status).toBe(400);
  expect((await POST(request("POST", { jurisdictionId: "ghana", requestId, query: "Tenancy?", stores: [] }))).status).toBe(400);
  expect((await POST(request("POST", { jurisdictionId: "ghana", requestId, query: "Tenancy?" }, false))).status).toBe(401);
  expect(mocks.bridge).not.toHaveBeenCalled();
});

it("uses only the server manifest/history and returns the persisted canonical answer", async () => {
  const turn = { requestId, query: "Tenancy?", status: "completed", result: { requestId, answer: "Verified answer", answerKind: "legal", partialCoverage: false, citations: [], completedAt: 1 } };
  mocks.bridge.mockImplementation(async operation => operation === "begin" ? admission : operation === "finish" ? turn : { ...session, remaining: 1, turns: [turn] });
  mocks.run.mockResolvedValue({ answer: "Verified answer", citations: [], usage: {} });
  const response = await POST(request("POST", { jurisdictionId: "ghana", requestId, query: "Tenancy?" }));
  expect(response.status).toBe(200);
  expect((await response.json()).turns[0]).toEqual(turn);
  expect(mocks.run.mock.calls[0][0]).toEqual({ query: "Tenancy?", stores: admission.manifest.stores, history: [], maxOutputTokens: 4096 });
  expect(mocks.bridge).toHaveBeenCalledWith("finish", expect.objectContaining({ outcome: "completed", answer: "Verified answer" }), expect.anything());
});

it("replays an existing request without another provider call and keeps pending requests recoverable", async () => {
  mocks.bridge.mockImplementation(async operation => operation === "begin" ? { kind: "existing", turn: { requestId, query: "Tenancy?", status: "pending" } } : session);
  expect((await POST(request("POST", { jurisdictionId: "ghana", requestId, query: "Tenancy?" }))).status).toBe(202);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("records failed generations without returning provisional content", async () => {
  mocks.bridge.mockImplementation(async operation => operation === "begin" ? admission : operation === "read" ? session : { requestId, status: "failed" });
  mocks.run.mockRejectedValue(new Error("provider failure"));
  const response = await POST(request("POST", { jurisdictionId: "ghana", requestId, query: "Tenancy?" }));
  expect(response.status).toBe(503);
  expect(mocks.bridge).toHaveBeenCalledWith("finish", expect.objectContaining({ outcome: "failed", citations: [] }), expect.anything());
  expect(await response.text()).not.toContain("provider failure");
});

it("requires account authentication and guest possession before forwarding an adoption", async () => {
  mocks.getToken.mockResolvedValueOnce(null);
  expect((await claim(request("POST"))).status).toBe(401);
  expect((await claim(request("POST", undefined, false))).status).toBe(401);
  expect(mocks.bridge).not.toHaveBeenCalled();
  mocks.bridge.mockResolvedValue({ chatId: "saved-chat" });
  expect(await (await claim(request("POST"))).json()).toEqual({ chatId: "saved-chat" });
  expect(mocks.bridge).toHaveBeenCalledWith("adopt", { tokenHash: expect.any(String) }, { authToken: "account-jwt" });
});

it("clears unusable sessions so returning to the homepage can start research again", async () => {
  for (const code of ["SESSION_EXPIRED", "SESSION_INVALID", "LIBRARY_CHANGED"]) {
    mocks.bridge.mockResolvedValueOnce({ error: { code, message: "Start again" } });
    const response = await GET(request("GET"));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    mocks.bridge.mockResolvedValueOnce({ error: { code, message: "Start again" } }).mockResolvedValueOnce(session);
    const reset = await PUT(request("PUT", { jurisdictionId: "ghana" }));
    expect(reset.status).toBe(200);
    expect(reset.headers.get("set-cookie")).toMatch(/lotl-guest-research=[A-Za-z0-9_-]{43}/);
  }
});

it("keeps generation behind the deployment flag and the canonical jurisdiction", async () => {
  vi.stubEnv("GUEST_RESEARCH_ENABLED", "false");
  expect((await PUT(request("PUT", { jurisdictionId: "ghana" }, false))).status).toBe(503);
  expect(mocks.bridge).not.toHaveBeenCalled();
  vi.stubEnv("GUEST_RESEARCH_ENABLED", "true");
  mocks.bridge.mockResolvedValue(session);
  expect((await POST(request("POST", { jurisdictionId: "another", requestId, query: "Tenancy?" }))).status).toBe(409);
  expect(mocks.run).not.toHaveBeenCalled();
});
