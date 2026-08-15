import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { createTelemetryServiceProof } from "../../../../convex/lib/telemetryProof";
import {
  decodeRetrievalObservationV1,
  E2E_JURISDICTION_QUESTIONS,
} from "../../../../shared/e2e-jurisdiction-provider-contract";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAuthenticated: vi.fn(),
}));

const groundxMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  initializationError: undefined as Error | undefined,
  searchContent: vi.fn(),
}));

const searchJurisdictionMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));
const plannerMocks = vi.hoisted(() => ({ planTopicScope: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/e2e-jurisdiction-provider-isolation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/e2e-jurisdiction-provider-isolation")>();
  return {
    ...original,
    resolveJurisdictionProviderMode: vi.fn(original.resolveJurisdictionProviderMode),
  };
});
vi.mock("groundx-typescript-sdk", () => ({
  Groundx: class {
    constructor(options: unknown) {
      groundxMocks.construct(options);
      if (groundxMocks.initializationError) throw groundxMocks.initializationError;
    }
    search = { content: groundxMocks.searchContent };
  },
}));
vi.mock("@/lib/jurisdiction-topic-planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jurisdiction-topic-planner")>()),
  planTopicScope: plannerMocks.planTopicScope,
}));

import { POST } from "./route";
import { resolveJurisdictionProviderMode } from "@/lib/e2e-jurisdiction-provider-isolation";

function request(body: Record<string, unknown>, observationSecret?: string) {
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
      ...(observationSecret
        ? { "x-admin-e2e-provider-observation": observationSecret }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

const STUB_SHA = "a".repeat(40);
const STUB_OBSERVATION_SECRET = "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM";

function enableStubBoundary() {
  vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
  vi.stubEnv("ADMIN_E2E_TARGET_ENV", "test");
  vi.stubEnv("ADMIN_E2E_ISOLATED_TARGET_MARKER", "isolated-admin-e2e");
  vi.stubEnv("ADMIN_E2E_PROVIDER_STUB_MODE", "true");
  vi.stubEnv("ADMIN_E2E_CONVEX_URL", "http://127.0.0.1:3210");
  vi.stubEnv("ADMIN_E2E_CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("ADMIN_E2E_APPROVED_COMMIT_SHA", STUB_SHA);
  vi.stubEnv("ADMIN_E2E_LOCAL_HEAD_SHA", STUB_SHA);
  vi.stubEnv("ADMIN_E2E_PROVIDER_OBSERVATION_SECRET", STUB_OBSERVATION_SECRET);
}

function observation(response: Response) {
  const encoded = response.headers.get("x-admin-e2e-retrieval-plan-v1");
  expect(encoded).not.toBeNull();
  return decodeRetrievalObservationV1(encoded!);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    groundxMocks.initializationError = undefined;
    vi.stubGlobal("fetch", searchJurisdictionMocks.fetch);
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://law-test.convex.site";
    process.env.SEARCH_JURISDICTION_SECRET = "route-search-secret-with-at-least-32-characters";
    process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthMutation.mockResolvedValue(undefined);
    authMocks.fetchAuthQuery.mockImplementation(async (reference) =>
      getFunctionName(reference) === "jurisdictions:isUnifiedJurisdictionsEnabled" ? false : gh,
    );
    plannerMocks.planTopicScope.mockResolvedValue({ geographicHints: [], ancestorDepth: 0, status: "fallback", latencyMs: 1 });
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
    expect(authMocks.fetchAuthQuery.mock.calls.map(([reference]) => getFunctionName(reference)))
      .toEqual(["jurisdictions:isUnifiedJurisdictionsEnabled"]);
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
      legacyResolutionUsed: false,
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
    authMocks.fetchAuthQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return false;
      return name === "jurisdictions:listPublicEnabled" ? [publicNigeria] : nigeria;
    });
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify(nigeria)));

    const response = await POST(request({ query: "What is the law?" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jurisdictionCode: "NG" });
    expect(authMocks.fetchAuthQuery.mock.calls.map(([reference]) =>
      getFunctionName(reference),
    )).toEqual(["jurisdictions:isUnifiedJurisdictionsEnabled", "jurisdictions:listPublicEnabled"]);
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
    expect(authMocks.fetchAuthQuery.mock.calls.map(([reference]) => getFunctionName(reference)))
      .toEqual(["jurisdictions:isUnifiedJurisdictionsEnabled"]);
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

describe("POST /api/search unified jurisdictions", () => {
  const selectedId = "selected-jurisdiction-id";
  const scopeItems = [
    { jurisdictionId: selectedId, name: "Accra", kind: "geographic", relation: "selected" },
    { jurisdictionId: "greater-accra-id", name: "Greater Accra", kind: "geographic", relation: "geographic_ancestor" },
    { jurisdictionId: "ghana-id", name: "Ghana", kind: "geographic", relation: "geographic_ancestor" },
    { jurisdictionId: "west-africa-id", name: "West Africa", kind: "geographic", relation: "geographic_ancestor" },
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    groundxMocks.initializationError = undefined;
    vi.stubGlobal("fetch", searchJurisdictionMocks.fetch);
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://law-test.convex.site";
    process.env.SEARCH_JURISDICTION_SECRET = "route-search-secret-with-at-least-32-characters";
    process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
    process.env.GROUNDX_API_KEY = "route-groundx-key";
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthMutation.mockResolvedValue(undefined);
    groundxMocks.searchContent.mockResolvedValue({ data: { search: { text: "governed answer" } } });
  });

  function enableUnified() {
    authMocks.fetchAuthQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return true;
      if (name === "jurisdictions:resolveResearchSelection") {
        return { id: selectedId, name: "Accra", slug: "accra", kind: "geographic", isDefault: false, legacyCountryCode: "GH" };
      }
      if (name === "jurisdictions:resolveResearchScope") {
        return { selectedJurisdictionId: selectedId, items: scopeItems };
      }
      throw new Error(`unexpected query ${name}`);
    });
    plannerMocks.planTopicScope.mockResolvedValue({ geographicHints: ["accra"], ancestorDepth: 3, status: "planned", latencyMs: 2 });
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "ready", productionBucketId: "100" },
      supplementary: scopeItems.slice(1).map((item, index) => ({
        jurisdictionId: item.jurisdictionId,
        status: "ready",
        productionBucketId: String(101 + index),
      })),
    })));
  }

  it("authorizes before secret lookup and caps four provider calls at three concurrent starts", async () => {
    enableUnified();
    let active = 0;
    let peak = 0;
    groundxMocks.searchContent.mockImplementation(async ({ id }: { id: number }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return { data: { search: { text: `Law from ${id}.` } } };
    });

    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId, country: "GH" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ jurisdictionId: selectedId, legacyCountryCode: "GH" });
    const issueArgs = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:issueCorrelation",
    )?.[1];
    expect(issueArgs).toMatchObject({
      token: payload.correlationToken,
      jurisdictionId: selectedId,
      legacyCountryCode: "GH",
      legacyResolutionUsed: false,
    });
    expect(issueArgs?.serviceProof).toBe(await createTelemetryServiceProof([
      "issue-jurisdiction-v1", payload.correlationToken, selectedId, "GH", 0,
    ]));
    expect(payload.result.length).toBeLessThanOrEqual(120_000);
    expect(peak).toBeLessThanOrEqual(3);
    expect(groundxMocks.searchContent).toHaveBeenCalledTimes(4);
    expect(searchJurisdictionMocks.fetch).toHaveBeenCalledWith(
      "https://law-test.convex.site/internal/search-jurisdictions",
      expect.objectContaining({ body: JSON.stringify({
        selectedJurisdictionId: selectedId,
        supplementaryJurisdictionIds: scopeItems.slice(1).map((item) => item.jurisdictionId),
      }) }),
    );
    const phase = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase",
    )?.[1];
    expect(phase).toMatchObject({
      providerStatus: "success", scopeSize: 4, retrievalPlanSize: 4,
      providerCallCount: 4, contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      partialCoverage: false, configurationUnavailableCount: 0,
      supplementaryProviderFailureCount: 0,
    });
  });

  it("binds country-only legacy resolution into unified correlation issuance", async () => {
    enableUnified();
    const response = await POST(request({ query: "parking rules", country: "GH" }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    const issueArgs = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:issueCorrelation",
    )?.[1];
    expect(issueArgs).toMatchObject({
      token: payload.correlationToken,
      jurisdictionId: selectedId,
      legacyCountryCode: "GH",
      legacyResolutionUsed: true,
    });
    expect(issueArgs?.serviceProof).toBe(await createTelemetryServiceProof([
      "issue-jurisdiction-v1", payload.correlationToken, selectedId, "GH", 1,
    ]));
  });

  it("rejects a mismatched selector before quota, planner, secret lookup, telemetry, or provider", async () => {
    enableUnified();
    authMocks.fetchAuthQuery.mockImplementation(async (reference) =>
      getFunctionName(reference) === "jurisdictions:isUnifiedJurisdictionsEnabled" ? true : null,
    );
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId, country: "NG" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That jurisdiction is not available for research." });
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(plannerMocks.planTopicScope).not.toHaveBeenCalled();
    expect(searchJurisdictionMocks.fetch).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it("omits an unconfigured supplementary library and returns cause-free named partial coverage", async () => {
    enableUnified();
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "ready", productionBucketId: "100" },
      supplementary: [
        { jurisdictionId: "greater-accra-id", status: "unconfigured" },
        { jurisdictionId: "ghana-id", status: "ready", productionBucketId: "102" },
        { jurisdictionId: "west-africa-id", status: "ready", productionBucketId: "103" },
      ],
    })));
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(groundxMocks.searchContent).toHaveBeenCalledTimes(3);
    expect(payload.partialCoverage).toEqual([{
      jurisdictionId: "greater-accra-id", name: "Greater Accra",
      kind: "geographic", relation: "geographic_ancestor",
    }]);
    expect(JSON.stringify(payload)).not.toMatch(/unconfigured|bucket|provider|cause/i);
  });

  it("returns the uniform unavailable response for an unconfigured selected library without GroundX", async () => {
    enableUnified();
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "unconfigured" },
      supplementary: scopeItems.slice(1).map((item) => ({ jurisdictionId: item.jurisdictionId, status: "unconfigured" })),
    })));
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That jurisdiction is not available for research." });
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it("fails before GroundX when the secret response changes supplementary order", async () => {
    enableUnified();
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "ready", productionBucketId: "100" },
      supplementary: [
        { jurisdictionId: "ghana-id", status: "ready", productionBucketId: "102" },
        { jurisdictionId: "greater-accra-id", status: "ready", productionBucketId: "101" },
        { jurisdictionId: "west-africa-id", status: "ready", productionBucketId: "103" },
      ],
    })));
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));
    expect(response.status).toBe(500);
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it("initializes GroundX once before the pool and records a safe zero-call failure", async () => {
    enableUnified();
    groundxMocks.initializationError = new Error("constructor secret detail");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "We couldn't find relevant legal information for your question.",
    });
    expect(groundxMocks.construct).toHaveBeenCalledOnce();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("constructor secret detail");
    const phase = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase",
    )?.[1];
    expect(phase).toMatchObject({
      providerStatus: "failure",
      providerCallCount: 0,
      configurationUnavailableCount: 0,
      supplementaryProviderFailureCount: 0,
    });
    errorLog.mockRestore();
  });

  it("rejects an oversized internal availability response before GroundX", async () => {
    enableUnified();
    const valid = JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "ready", productionBucketId: "100" },
      supplementary: scopeItems.slice(1).map((item, index) => ({
        jurisdictionId: item.jurisdictionId, status: "ready", productionBucketId: String(101 + index),
      })),
    });
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(`${valid}${" ".repeat(5_000)}`));
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));
    expect(response.status).toBe(500);
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it("fails the request when selected retrieval fails even if supplementary calls settle", async () => {
    enableUnified();
    groundxMocks.searchContent.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 100) throw new Error("selected provider detail");
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { data: { search: { text: `Law from ${id}.` } } };
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request({ query: "parking rules", jurisdictionId: selectedId }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("selected provider detail");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("selected provider detail");
    const phase = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase",
    )?.[1];
    expect(phase).toMatchObject({
      providerStatus: "failure",
      providerCallCount: groundxMocks.searchContent.mock.calls.length,
      supplementaryProviderFailureCount: 0,
    });
    errorLog.mockRestore();
  });

  it("reports ordered partial coverage when a successful selected retrieval exhausts the total deadline", async () => {
    vi.useFakeTimers();
    try {
      enableUnified();
      let startedCount = 0;
      let resolveStarted!: () => void;
      const allWorkersStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
      groundxMocks.searchContent.mockImplementation(async ({ id }: { id: number }) => {
        startedCount += 1;
        if (startedCount === 3) resolveStarted();
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        return { data: { search: { text: `Law from ${id}.` } } };
      });

      const pending = POST(request({ query: "parking rules", jurisdictionId: selectedId }));
      await allWorkersStarted;
      await vi.advanceTimersByTimeAsync(25_000);
      const response = await pending;
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(groundxMocks.searchContent).toHaveBeenCalledTimes(3);
      expect(payload.partialCoverage).toEqual([{
        jurisdictionId: "west-africa-id",
        name: "West Africa",
        kind: "geographic",
        relation: "geographic_ancestor",
      }]);
      const phase = authMocks.fetchAuthMutation.mock.calls.find(
        ([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase",
      )?.[1];
      expect(phase).toMatchObject({
        providerStatus: "success",
        providerCallCount: 3,
        partialCoverage: true,
        supplementaryProviderFailureCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a complete bounded observation only for the authorized parent", async () => {
    enableUnified();
    enableStubBoundary();
    const body = {
      query: E2E_JURISDICTION_QUESTIONS.complete,
      jurisdictionId: selectedId,
    };

    const authorized = await POST(request(body, STUB_OBSERVATION_SECRET));
    const wrong = await POST(request(body, `${STUB_OBSERVATION_SECRET.slice(0, -1)}A`));
    const missing = await POST(request(body));

    expect(authorized.status).toBe(200);
    expect((await authorized.clone().json()).jurisdictionId).toBe(selectedId);
    expect(observation(authorized)).toMatchObject({
      version: 1,
      planner: { status: "planned", latencyMs: expect.any(Number) },
      authorizedScopeSize: 4,
      planSize: 4,
      peakConcurrency: 3,
      libraries: [
        { ordinal: 0, relation: "selected", status: "fulfilled", latencyMs: expect.any(Number) },
        { ordinal: 1, relation: "geographic_ancestor", status: "fulfilled", latencyMs: expect.any(Number) },
        { ordinal: 2, relation: "geographic_ancestor", status: "fulfilled", latencyMs: expect.any(Number) },
        { ordinal: 3, relation: "geographic_ancestor", status: "fulfilled", latencyMs: expect.any(Number) },
      ],
      failureCount: 0,
      coverageState: "complete",
      providerCallCount: 4,
      unexpectedRealProviderCallCount: 0,
    });
    expect(wrong.headers.has("x-admin-e2e-retrieval-plan-v1")).toBe(false);
    expect(missing.headers.has("x-admin-e2e-retrieval-plan-v1")).toBe(false);
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
    expect(resolveJurisdictionProviderMode).toHaveBeenCalledTimes(3);
  });

  it("rejoins an unconfigured supplementary library into its original plan ordinal", async () => {
    enableUnified();
    enableStubBoundary();
    searchJurisdictionMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      selected: { jurisdictionId: selectedId, status: "ready", productionBucketId: "100" },
      supplementary: [
        { jurisdictionId: "greater-accra-id", status: "unconfigured" },
        { jurisdictionId: "ghana-id", status: "ready", productionBucketId: "102" },
        { jurisdictionId: "west-africa-id", status: "ready", productionBucketId: "103" },
      ],
    })));

    const response = await POST(request({
      query: E2E_JURISDICTION_QUESTIONS.complete,
      jurisdictionId: selectedId,
    }, STUB_OBSERVATION_SECRET));

    expect(response.status).toBe(200);
    expect(observation(response)).toMatchObject({
      planSize: 4,
      libraries: [
        { ordinal: 0, status: "fulfilled" },
        { ordinal: 1, status: "unconfigured", latencyMs: 0 },
        { ordinal: 2, status: "fulfilled" },
        { ordinal: 3, status: "fulfilled" },
      ],
      failureCount: 0,
      coverageState: "supplementary_incomplete",
      providerCallCount: 3,
    });
  });

  it("records the exact supplementary stub failure without losing later settlements", async () => {
    enableUnified();
    enableStubBoundary();

    const response = await POST(request({
      query: E2E_JURISDICTION_QUESTIONS.supplementary_failure,
      jurisdictionId: selectedId,
    }, STUB_OBSERVATION_SECRET));
    const payload = await response.clone().json();

    expect(response.status).toBe(200);
    expect(payload.jurisdictionId).toBe(selectedId);
    expect(payload.partialCoverage).toEqual([expect.objectContaining({
      jurisdictionId: "greater-accra-id",
    })]);
    expect(observation(response)).toMatchObject({
      libraries: [
        { ordinal: 0, status: "fulfilled" },
        { ordinal: 1, status: "rejected" },
        { ordinal: 2, status: "fulfilled" },
        { ordinal: 3, status: "fulfilled" },
      ],
      failureCount: 1,
      coverageState: "supplementary_incomplete",
      providerCallCount: 4,
    });
  });

  it("emits an authorized selected-error observation with suppressed work as not started", async () => {
    enableUnified();
    enableStubBoundary();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({
      query: E2E_JURISDICTION_QUESTIONS.selected_failure,
      jurisdictionId: selectedId,
    }, STUB_OBSERVATION_SECRET));

    expect(response.status).toBe(500);
    expect(await response.clone().json()).toEqual({
      error: "We couldn't find relevant legal information for your question.",
    });
    expect(observation(response)).toMatchObject({
      authorizedScopeSize: 4,
      planSize: 4,
      peakConcurrency: 3,
      libraries: [
        { ordinal: 0, relation: "selected", status: "rejected" },
        { ordinal: 1, relation: "geographic_ancestor", status: "fulfilled" },
        { ordinal: 2, relation: "geographic_ancestor", status: "fulfilled" },
        { ordinal: 3, relation: "geographic_ancestor", status: "not_started", latencyMs: 0 },
      ],
      failureCount: 1,
      coverageState: "selected_unavailable",
      providerCallCount: 3,
    });
    const issueArgs = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "telemetry:issueCorrelation",
    )?.[1];
    expect(issueArgs).toMatchObject({ jurisdictionId: selectedId });
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
    expect(resolveJurisdictionProviderMode).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("does not trim a non-exact stub question into a known scenario", async () => {
    enableUnified();
    enableStubBoundary();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({
      query: `${E2E_JURISDICTION_QUESTIONS.complete} `,
      jurisdictionId: selectedId,
    }, STUB_OBSERVATION_SECRET));

    expect(response.status).toBe(500);
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
    expect(resolveJurisdictionProviderMode).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
