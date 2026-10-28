import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyTelemetryServiceProof } from "@/convex/lib/telemetryProof";
import { documentReviewSourceProofParts } from "../../../../../../../../shared/document-review";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), fetchAuthAction: vi.fn() }));
vi.mock("@/lib/auth-server", () => mocks);
import { GET } from "./route";

const params = (citationIndex = "1") => ({ params: Promise.resolve({ reviewId: "review_1", findingId: "finding_1", citationIndex }) });
const request = (url = "http://localhost/api/document-reviews/review_1/sources/finding_1/1") => new Request(url);
const fileUrl = "https://backend.convex.cloud/api/storage/original";

beforeEach(() => {
  mocks.getToken.mockReset().mockResolvedValue("synthetic-session-token");
  mocks.fetchAuthAction.mockReset().mockResolvedValue({ url: fileUrl, filename: "rent act.pdf", mimeType: "application/pdf", byteSize: 3 });
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "review-source-test-secret-0123456789abcd");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://backend.convex.cloud");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://backend.convex.site");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("pdf", { headers: { "content-length": "3" } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("signs the selector, rechecks access and streams the original privately", async () => {
  const response = await GET(request(), params());
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pdf");
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(JSON.stringify([...response.headers])).not.toContain(fileUrl);
  const selector = mocks.fetchAuthAction.mock.calls[0][1];
  expect(selector).toMatchObject({ reviewId: "review_1", findingId: "finding_1", citationIndex: 1 });
  await expect(verifyTelemetryServiceProof(selector.serviceProof, documentReviewSourceProofParts(selector))).resolves.toBe(true);
  mocks.fetchAuthAction.mockResolvedValue(null);
  expect((await GET(request(), params())).status).toBe(404);
});

it("denies anonymous requests and invalid selectors before fetching bytes", async () => {
  mocks.getToken.mockResolvedValueOnce(null);
  expect((await GET(request(), params())).status).toBe(401);
  for (const citationIndex of ["4", "-1", "01", "a"]) expect((await GET(request(), params(citationIndex))).status).toBe(404);
  expect((await GET(request("http://localhost/api/document-reviews/review_1/sources/finding_1/1?x=1"), params())).status).toBe(404);
  expect(mocks.fetchAuthAction).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses an original stored anywhere but the Convex backend", async () => {
  mocks.fetchAuthAction.mockResolvedValueOnce({ url: "https://external.invalid/api/storage/x", filename: "act.pdf", mimeType: "application/pdf", byteSize: 3 });
  expect((await GET(request(), params())).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});
