import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/embed/server", () => ({ assertGuestRequest: () => {}, readWidgetBody: async (r: Request) => new Uint8Array(await r.arrayBuffer()), callWidgetBridge: mocks.bridge, trustedWidgetIp: () => "hashed-ip", guestTokenHash: async () => "token-hash", widgetErrorResponse: (error: unknown) => Response.json({ error }, { status: 429 }), widgetFailureResponse: () => Response.json({ error: "failed" }, { status: 400 }) }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));
vi.mock("@/lib/gemini-file-search-chat", () => ({ GeminiFileSearchChat: class { run = mocks.run; } }));
import { POST } from "./route";
beforeEach(() => { mocks.bridge.mockReset(); mocks.run.mockReset(); vi.stubEnv("GOOGLE_AI_API_KEY", "unit-test-only"); });
afterEach(() => vi.unstubAllEnvs());
it("never releases generated text before canonical persistence", async () => {
  const requestId = crypto.randomUUID();
  let finish!: (result: unknown) => void;
  mocks.bridge.mockImplementation((operation: string) => operation === "begin" ? Promise.resolve({ kind: "admitted", turnId: "turn", attemptNonce: "nonce", messages: [], authority: { store: { name: "Greenfield" } } }) : new Promise(resolve => { finish = resolve; }));
  mocks.run.mockResolvedValue({ answer: "Provisional text", citations: [] });
  const response = await POST(new Request("https://app.example/api/embed/widget/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, query: "Policy?" }) }), { params: Promise.resolve({ embedId: "widget" }) });
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain("generating");
  expect(decoder.decode((await reader.read()).value)).toContain("validating");
  let received = false; const terminal = reader.read().then(value => { received = true; return value; });
  await Promise.resolve(); expect(received).toBe(false);
  finish({ status: "failed", error: { code: "LIBRARY_CHANGED", message: "Library changed" } });
  expect(decoder.decode((await terminal).value)).not.toContain("Provisional text");
  expect(mocks.run.mock.calls[0][0].maxOutputTokens).toBe(4096);
});
it("returns an existing request without invoking the provider again", async () => {
  const requestId = crypto.randomUUID();
  mocks.bridge.mockResolvedValue({ kind: "existing", turn: { requestId, status: "pending" } });
  const response = await POST(new Request("https://app.example/api/embed/widget/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, query: "Policy?" }) }), { params: Promise.resolve({ embedId: "widget" }) });
  expect(response.status).toBe(202); expect(mocks.run).not.toHaveBeenCalled();
});
