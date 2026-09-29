import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ getToken: mocks.getToken }));
import { GET } from "./route";

const params = { params: Promise.resolve({ versionId: "version_2" }) };
const fileUrl = "https://files.example.test/original.pdf";

beforeEach(() => {
  mocks.getToken.mockReset().mockResolvedValue("session-token");
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "review-file-test-secret-".repeat(2));
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://convex.example.test");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("checks access before streaming a ranged file without exposing its storage URL", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ url: fileUrl, filename: "act 843.pdf", mimeType: "application/pdf" }))
    .mockResolvedValueOnce(new Response("pdf", { status: 206, headers: { "content-range": "bytes 0-2/3", "content-length": "3", "accept-ranges": "bytes" } }));
  const response = await GET(new Request("http://localhost/api/admin/review-files/version_2", { headers: { range: "bytes=0-2" } }), params);
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("pdf");
  expect(response.headers.get("content-range")).toBe("bytes 0-2/3");
  expect(response.headers.get("content-disposition")).toContain("act%20843.pdf");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(JSON.stringify([...response.headers])).not.toContain(fileUrl);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(fetch).mock.calls[0][0].toString()).toBe("https://convex.example.test/private/admin-review-file");
  expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({ headers: { range: "bytes=0-2" }, cache: "no-store" });
});

it("denies signed-out and revoked requests before fetching file bytes", async () => {
  mocks.getToken.mockResolvedValueOnce(null);
  expect((await GET(new Request("http://localhost/api/admin/review-files/version_2"), params)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();

  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await GET(new Request("http://localhost/api/admin/review-files/version_2"), params)).status).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves an unsatisfiable range response for the browser", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ url: fileUrl, filename: "act.pdf", mimeType: "application/pdf" }))
    .mockResolvedValueOnce(new Response(null, { status: 416, headers: { "content-range": "bytes */3" } }));
  const response = await GET(new Request("http://localhost/api/admin/review-files/version_2", { headers: { range: "bytes=4-" } }), params);
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */3");
});
