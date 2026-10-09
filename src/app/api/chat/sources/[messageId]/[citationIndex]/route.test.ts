import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), fetchAuthAction: vi.fn() }));
vi.mock("@/lib/auth-server", () => mocks);
import { GET } from "./route";

const context = { params: Promise.resolve({ messageId: "saved_answer", citationIndex: "0" }) };
const request = (headers?: HeadersInit) => new Request("http://localhost/api/chat/sources/saved_answer/0?chat=owned-chat", { headers });
const fileUrl = "https://backend.convex.cloud/api/storage/original";

beforeEach(() => {
  mocks.getToken.mockReset().mockResolvedValue("synthetic-session-token");
  mocks.fetchAuthAction.mockReset().mockResolvedValue({ url: fileUrl, filename: "labour act.pdf", mimeType: "application/pdf", byteSize: 3 });
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://backend.convex.cloud");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://backend.convex.site");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("pdf", { headers: { "content-length": "3" } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("reauthorizes each click and streams the original privately without exposing its storage URL", async () => {
  const response = await GET(request(), context);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pdf");
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-disposition")).toContain("labour%20act.pdf");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("location")).toBeNull();
  expect(JSON.stringify([...response.headers])).not.toContain(fileUrl);
  expect(mocks.fetchAuthAction).toHaveBeenCalledWith(expect.anything(), { externalId: "owned-chat", messageId: "saved_answer", citationIndex: 0 });
  mocks.fetchAuthAction.mockResolvedValueOnce(null);
  expect((await GET(request(), context)).status).toBe(404);
  expect(mocks.getToken).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("denies anonymous and invalid selectors before fetching original bytes", async () => {
  mocks.getToken.mockResolvedValueOnce(null);
  expect((await GET(request(), context)).status).toBe(401);
  expect(mocks.fetchAuthAction).not.toHaveBeenCalled();
  for (const citationIndex of ["-1", "1.5", "4", "00"])
    expect((await GET(request(), { params: Promise.resolve({ messageId: "saved_answer", citationIndex }) })).status).toBe(404);
  expect((await GET(new Request("http://localhost/api/chat/sources/saved_answer/0?chat=owned-chat&other=1"), context)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not follow an unauthorized upstream host or redirect", async () => {
  mocks.fetchAuthAction.mockResolvedValueOnce({ url: "https://external.invalid/api/storage/original", filename: "act.pdf", mimeType: "application/pdf", byteSize: 3 });
  expect((await GET(request(), context)).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://external.invalid" } }));
  expect((await GET(request(), context)).status).toBe(503);
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
});

it("preserves range and unsatisfiable-range responses for the PDF viewer", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response("p", { status: 206, headers: { "content-range": "bytes 0-0/3", "content-length": "1", "accept-ranges": "bytes" } }));
  const partial = await GET(request({ range: "bytes=0-0" }), context);
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 0-0/3");
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ headers: { range: "bytes=0-0" } });
  vi.mocked(fetch).mockResolvedValueOnce(new Response("range error", { status: 416, headers: { "content-range": "bytes */3", "content-length": "11" } }));
  const unsatisfiable = await GET(request({ range: "bytes=4-" }), context);
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get("content-range")).toBe("bytes */3");
  expect(unsatisfiable.headers.get("content-length")).toBeNull();
});
