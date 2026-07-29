import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAuthenticated: vi.fn(),
}));

const groundxMocks = vi.hoisted(() => ({
  searchContent: vi.fn(),
}));

const searchJurisdictionMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("groundx-typescript-sdk", () => ({
  Groundx: class {
    search = { content: groundxMocks.searchContent };
  },
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

const publicGhana = {
  code: "GH",
  name: "Ghana",
  slug: "ghana",
  isDefault: true,
};

const gh = {
  ...publicGhana,
  enabled: true as const,
  productionBucketId: "11833",
};

describe("POST /api/search governed jurisdiction lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", searchJurisdictionMocks.fetch);
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://law-test.convex.site";
    process.env.SEARCH_JURISDICTION_SECRET = "route-search-secret-with-at-least-32-characters";
    process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthMutation.mockResolvedValue(undefined);
    authMocks.fetchAuthQuery.mockResolvedValue(gh);
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify(gh)));
    groundxMocks.searchContent.mockResolvedValue({
      data: { search: { text: "governed answer" } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the governed production bucket returned by Convex", async () => {
    const response = await POST(request({ query: "What is the law?", country: "gh" }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ result: "governed answer", jurisdictionCode: "GH" });
    expect(payload.correlationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(searchJurisdictionMocks.fetch).toHaveBeenCalledWith(
      "https://law-test.convex.site/internal/search-jurisdiction",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-search-jurisdiction-secret": "route-search-secret-with-at-least-32-characters",
        },
        body: JSON.stringify({ code: "GH" }),
      },
    );
    expect(JSON.stringify(payload)).not.toContain("11833");
    expect(groundxMocks.searchContent).toHaveBeenCalledWith({
      id: 11833,
      query: "What is the law?",
    });
    const telemetryCalls = authMocks.fetchAuthMutation.mock.calls.filter(
      ([reference]) => getFunctionName(reference).startsWith("telemetry:"),
    );
    expect(telemetryCalls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:issueCorrelation",
      "telemetry:recordSearchPhase",
    ]);
    expect(telemetryCalls[0][1]).toMatchObject({
      token: payload.correlationToken,
      jurisdictionCode: "GH",
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(telemetryCalls[1][1]).toMatchObject({
      token: payload.correlationToken,
      providerStatus: "success",
      resultCount: 1,
      latencyMs: expect.any(Number),
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("uses the governed default when a client omits the jurisdiction", async () => {
    const publicNigeria = {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      isDefault: true,
    };
    const nigeria = {
      ...publicNigeria,
      enabled: true as const,
      productionBucketId: "22001",
    };
    authMocks.fetchAuthQuery.mockImplementation(async (reference) =>
      getFunctionName(reference) === "jurisdictions:listPublicEnabled"
        ? [publicNigeria]
        : nigeria,
    );
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify(nigeria)));

    const response = await POST(request({ query: "What is the law?" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jurisdictionCode: "NG" });
    expect(authMocks.fetchAuthQuery.mock.calls.map(([reference]) =>
      getFunctionName(reference),
    )).toEqual(["jurisdictions:listPublicEnabled"]);
    expect(searchJurisdictionMocks.fetch).toHaveBeenCalledWith(
      "https://law-test.convex.site/internal/search-jurisdiction",
      expect.objectContaining({ body: JSON.stringify({ code: "NG" }) }),
    );
    expect(groundxMocks.searchContent).toHaveBeenCalledWith({
      id: 22001,
      query: "What is the law?",
    });
  });

  it("records one sanitized terminal search failure without returning its correlation token", async () => {
    groundxMocks.searchContent.mockRejectedValue(new Error("provider token secret-provider-value"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({ query: "What is the law?", country: "GH" }));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-provider-value");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret-provider-value");
    const telemetryCalls = authMocks.fetchAuthMutation.mock.calls.filter(
      ([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase",
    );
    expect(telemetryCalls).toHaveLength(1);
    expect(telemetryCalls[0][1]).toMatchObject({
      providerStatus: "failure",
      resultCount: 0,
    });
    expect(telemetryCalls[0][1]).not.toHaveProperty("error");
    errorLog.mockRestore();
  });

  it("does not rewrite a successful provider outcome as failure when telemetry delivery fails", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "telemetry:recordSearchPhase") throw new Error("transport unavailable");
      return undefined;
    });
    const response = await POST(request({ query: "What is the law?", country: "GH" }));
    expect(response.status).toBe(500);
    const telemetryCalls = authMocks.fetchAuthMutation.mock.calls.filter(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase");
    expect(telemetryCalls).toHaveLength(1);
    expect(telemetryCalls[0][1]).toMatchObject({ providerStatus: "success" });
  });

  it("rejects an unknown jurisdiction before quota or GroundX calls", async () => {
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response("null"));

    const response = await POST(request({ query: "Question", country: "ZZ" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That country is not supported yet." });
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { ...gh, enabled: false }],
    ["missing production bucket", { ...gh, productionBucketId: "" }],
  ])("rejects a %s jurisdiction before GroundX", async (_case, jurisdiction) => {
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify(jurisdiction)));

    const response = await POST(request({ query: "Question", country: "GH" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That country is not supported yet." });
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it.each([
    ["above the JavaScript safe integer limit", "9007199254740992"],
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "12.5"],
    ["non-digit", "bucket-1"],
  ])("rejects a %s production bucket before quota or GroundX", async (_case, bucket) => {
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ...gh,
      productionBucketId: bucket,
    })));

    const response = await POST(request({ query: "Question", country: "GH" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That country is not supported yet." });
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });
});
