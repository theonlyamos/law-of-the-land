import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ getToken: mocks.getToken }));
import { POST } from "./route";

const reference = `exp_${"d".repeat(64)}`;
const validBody = JSON.stringify({ reference });
function requestWithBody(body: string, contentLength?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/admin/exports/download", { method: "POST", headers, body });
}

beforeEach(() => {
  mocks.getToken.mockReset().mockResolvedValue("assured-session-token");
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://convex.example.test";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("export", { status: 200, headers: { "content-type": "application/x-ndjson" } })));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.NEXT_PUBLIC_CONVEX_SITE_URL; });

describe("admin export download proxy body limits", () => {
  it("rejects a missing body before authentication", async () => {
    expect((await POST(new Request("http://localhost/api/admin/exports/download", { method: "POST" }))).status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without Content-Length before authentication", async () => {
    expect((await POST(requestWithBody(`${validBody}${" ".repeat(257 - validBody.length)}`))).status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even when Content-Length is falsely small", async () => {
    expect((await POST(requestWithBody(`${validBody}${" ".repeat(257 - validBody.length)}`, "1"))).status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("accepts an exact 256-byte valid JSON body", async () => {
    const response = await POST(requestWithBody(`${validBody}${" ".repeat(256 - validBody.length)}`));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON before authentication", async () => {
    expect((await POST(requestWithBody("{not-json"))).status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("proxies a normal bounded reference request", async () => {
    const response = await POST(requestWithBody(validBody));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export");
  });

  it("preserves an upstream 503 as non-consuming", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await POST(requestWithBody(validBody))).status).toBe(503);
  });

  it("turns an upstream network failure into a retryable 503", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network unavailable"));
    expect((await POST(requestWithBody(validBody))).status).toBe(503);
  });
});
