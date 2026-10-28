// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ getToken: vi.fn() }));
const genai = vi.hoisted(() => ({ create: vi.fn(), apiKeys: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-server", () => auth);
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: genai.create };
    constructor({ apiKey }: { apiKey: string }) { genai.apiKeys.push(apiKey); }
  },
}));
import { POST } from "./route";

let ip = 0;
const record = (overrides: { origin?: string; type?: string; body?: BodyInit } = {}) => new Request("https://app.test/api/transcribe", {
  method: "POST",
  headers: { origin: overrides.origin ?? "https://app.test", "content-type": overrides.type ?? "audio/webm;codecs=opus", "x-forwarded-for": `10.0.0.${++ip}` },
  body: overrides.body ?? new Uint8Array([1, 2, 3]),
});

beforeEach(() => {
  vi.clearAllMocks();
  genai.apiKeys.length = 0;
  vi.stubEnv("SITE_URL", "https://app.test");
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-key");
  vi.stubEnv("GEMINI_TRANSCRIBE_MODEL", undefined);
  auth.getToken.mockResolvedValue("test-jwt");
  genai.create.mockResolvedValue({ output_text: "  What notice must my landlord give?\n" });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/transcribe", () => {
  it("sends the recording to gemini-3.5-transcribe and returns clean text", async () => {
    const response = await POST(record());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "What notice must my landlord give?" });
    expect(genai.apiKeys).toEqual(["test-key"]);
    const [request] = genai.create.mock.calls[0];
    expect(request).toMatchObject({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", data: "AQID", mime_type: "audio/webm" }],
      generation_config: { transcription_config: { mode: "smart" } },
      store: false,
    });
  });

  it("maps Safari's mp4 recordings to m4a and honours a model override", async () => {
    vi.stubEnv("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-transcribe-preview");
    await POST(record({ type: "audio/mp4" }));
    expect(genai.create.mock.calls[0][0]).toMatchObject({ model: "gemini-3.5-transcribe-preview", input: [{ mime_type: "audio/m4a" }] });
  });

  it("rejects requests from other sites and signed-out visitors before calling Gemini", async () => {
    expect((await POST(record({ origin: "https://evil.test" }))).status).toBe(403);
    auth.getToken.mockResolvedValue(null);
    expect((await POST(record())).status).toBe(401);
    expect(genai.create).not.toHaveBeenCalled();
  });

  it("rejects unknown formats, empty recordings and oversized uploads", async () => {
    expect((await POST(record({ type: "video/mp4" }))).status).toBe(415);
    expect((await POST(record({ body: new Uint8Array() }))).status).toBe(400);
    const tooLarge = await POST(record({ body: new Uint8Array(4 * 1024 * 1024 + 1) }));
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error).toMatch(/under two minutes/);
    expect(genai.create).not.toHaveBeenCalled();
  });

  it("explains silence and provider failures without leaking details", async () => {
    genai.create.mockResolvedValueOnce({ output_text: "" });
    const silent = await POST(record());
    expect(silent.status).toBe(422);
    expect((await silent.json()).error).toMatch(/couldn't make out any speech/);
    genai.create.mockRejectedValueOnce(new Error("upstream 500 secret detail"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await POST(record());
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("secret");
  });

  it("reports when voice input is not configured", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    expect((await POST(record())).status).toBe(503);
  });
});
