// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ getToken: vi.fn(), fetchAuthMutation: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-server", () => auth);
vi.mock("../../../../../convex/lib/chatAttachmentProof", () => ({ createChatAttachmentProof: vi.fn(async () => "proof") }));
import { POST } from "./route";
import { GET, DELETE } from "./[attachmentId]/route";

const file = { id: "file-one", filename: "agreement.pdf", mimeType: "application/pdf", byteSize: 3, kind: "document", url: "https://test.convex.cloud/api/storage/one" };
const context = { params: Promise.resolve({ attachmentId: "file-one" }) };
const prepare = (overrides = {}, origin = "https://app.test") => new Request("https://app.test/api/chat/attachments", {
  method: "POST", headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ externalId: "chat-one", filename: "notes.txt", mimeType: "", byteSize: 24, ...overrides }),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SITE_URL", "https://app.test");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud");
  auth.getToken.mockResolvedValue("test-jwt");
  auth.fetchAuthMutation.mockResolvedValue({ attachmentId: "file-one" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("chat attachment routes", () => {
  it("prepares a bounded same-origin upload with private response caching", async () => {
    const response = await POST(prepare());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachmentId: "file-one", uploadUrl: "https://test.convex.site/chat-attachments/upload", token: "test-jwt" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects cross-origin, unauthenticated and oversized preparation before mutation", async () => {
    expect((await POST(prepare({}, "https://other.test"))).status).toBe(403);
    auth.getToken.mockResolvedValueOnce(null);
    expect((await POST(prepare())).status).toBe(401);
    expect((await POST(prepare({ byteSize: 10 * 1024 * 1024 + 1 }))).status).toBe(400);
    expect(auth.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("streams originals through current authorization without returning storage URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(new Response("pdf", { headers: { "content-length": "3" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("https://app.test/api/chat/attachments/file-one"), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pdf");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer test-jwt");
  });
  it("does not read storage when authorization has been revoked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await GET(new Request("https://app.test/api/chat/attachments/file-one"), context)).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("protects draft removal against cross-site requests", async () => {
    const response = await DELETE(new Request("https://app.test/api/chat/attachments/file-one", { method: "DELETE", headers: { origin: "https://other.test" } }), context);
    expect(response.status).toBe(403);
    expect(auth.fetchAuthMutation).not.toHaveBeenCalled();
  });
});
