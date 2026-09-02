import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { webcrypto } from "node:crypto";
import { decodeRetrievalObservationV2 } from "../../../../shared/e2e-jurisdiction-provider-contract";

const auth = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(), fetchAuthQuery: vi.fn(), isAuthenticated: vi.fn(),
}));
const providers = vi.hoisted(() => ({
  createTopic: vi.fn(), createResearch: vi.fn(), topicGenerate: vi.fn(), initialize: vi.fn(), search: vi.fn(),
}));
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/auth-server", () => auth);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/jurisdiction-provider-adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jurisdiction-provider-adapters")>()),
  createTopicProvider: (...args: unknown[]) => {
    providers.createTopic(...args);
    return { generate: providers.topicGenerate };
  },
  createResearchProvider: (...args: unknown[]) => {
    providers.createResearch(...args);
    return { initialize: providers.initialize, search: providers.search };
  },
}));

import { POST } from "./route";

const selected = { id: "selected-id", name: "Accra", slug: "accra", kind: "geographic", isDefault: false };
const plan = [
  { jurisdictionId: "selected-id", name: "Accra", kind: "geographic", relation: "selected" },
  { jurisdictionId: "ghana-id", name: "Ghana", kind: "geographic", relation: "geographic_ancestor" },
  { jurisdictionId: "west-africa-id", name: "West Africa", kind: "geographic", relation: "geographic_ancestor" },
] as const;
const documents = {
  selected: { resourceId: "resource-selected", versionId: "version-selected", documentName: "fileSearchStores/accra/documents/bylaw-v1", title: "Accra Bylaw", officialCitation: "AB 1", sourceUrl: "https://official.example/accra" },
  ghana: { resourceId: "resource-ghana", versionId: "version-ghana", documentName: "fileSearchStores/ghana/documents/act-v2", title: "Ghana Act", officialCitation: "Act 4", sourceUrl: "https://official.example/ghana" },
  westAfrica: { resourceId: "resource-west-africa", versionId: "version-west-africa", documentName: "fileSearchStores/west-africa/documents/treaty-v1", title: "West Africa Treaty", officialCitation: "Treaty 1", sourceUrl: "https://official.example/west-africa" },
};
const readyResolution = {
  selected: { jurisdictionId: "selected-id", status: "ready", storeName: "fileSearchStores/accra", documents: [documents.selected] },
  supplementary: [
    { jurisdictionId: "ghana-id", status: "ready", storeName: "fileSearchStores/ghana", documents: [documents.ghana] },
    { jurisdictionId: "west-africa-id", status: "ready", storeName: "fileSearchStores/west-africa", documents: [documents.westAfrica] },
  ],
};

function request(body: Record<string, unknown>, observation = false) {
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-forwarded-for": crypto.randomUUID(),
      ...(observation ? { "x-admin-e2e-provider-observation": "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function responseJson(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function providerSource(
  jurisdictionId: string,
  content: string,
  citations: Array<{ resourceId: string; versionId: string; documentName: string; pageNumber?: number }>,
) {
  return {
    jurisdictionId,
    spans: citations.map((citation) => ({ content, citation })),
  };
}

function enableObservation() {
  vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
  vi.stubEnv("ADMIN_E2E_TARGET_ENV", "test");
  vi.stubEnv("ADMIN_E2E_ISOLATED_TARGET_MARKER", "isolated-admin-e2e");
  vi.stubEnv("ADMIN_E2E_PROVIDER_STUB_MODE", "true");
  vi.stubEnv("ADMIN_E2E_CONVEX_URL", "http://127.0.0.1:3210");
  vi.stubEnv("ADMIN_E2E_CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("ADMIN_E2E_APPROVED_COMMIT_SHA", "a".repeat(40));
  vi.stubEnv("ADMIN_E2E_LOCAL_HEAD_SHA", "a".repeat(40));
  vi.stubEnv("ADMIN_E2E_PROVIDER_OBSERVATION_SECRET", "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", transport.fetch);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://law-test.convex.site");
  vi.stubEnv("SEARCH_JURISDICTION_SECRET", "route-search-secret-with-at-least-32-characters");
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "route-test-secret-with-at-least-32-characters");
  auth.isAuthenticated.mockResolvedValue(true);
  auth.fetchAuthMutation.mockResolvedValue(undefined);
  auth.fetchAuthQuery.mockImplementation(async (reference) => {
    const name = getFunctionName(reference);
    if (name === "jurisdictions:resolveResearchSelection") return selected;
    if (name === "jurisdictions:resolveResearchScope") return { selectedJurisdictionId: selected.id, items: plan };
    return true;
  });
  providers.topicGenerate.mockResolvedValue({ text: JSON.stringify({ geographicHints: ["Accra"], ancestorDepth: 3 }) });
  providers.initialize.mockResolvedValue(undefined);
  transport.fetch.mockImplementation(async (_url, init) => {
    const requestBody = (init as RequestInit).body;
    const body = JSON.parse(ArrayBuffer.isView(requestBody)
      ? new TextDecoder().decode(requestBody as ArrayBufferView<ArrayBuffer>)
      : String(requestBody));
    expect(JSON.stringify((init as RequestInit).headers)).not.toContain("route-search-secret");
    return responseJson(body.supplementaryJurisdictionIds.length === 0
      ? { selected: readyResolution.selected, supplementary: [] }
      : readyResolution);
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("POST /api/search Gemini File Search boundary", () => {
  it("preflights then queries selected-first stores once and authorizes citations from Convex", async () => {
    enableObservation();
    providers.search.mockResolvedValue({
      latencyMs: 23,
      sources: [
        providerSource("ghana-id", "National evidence", [
          { ...documents.ghana, pageNumber: 2 },
          { resourceId: "forged", versionId: "forged", documentName: documents.ghana.documentName, pageNumber: 9 },
        ]),
        providerSource("selected-id", "Local evidence", [
          { resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName, pageNumber: 1 },
          { resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName, pageNumber: 1 },
        ]),
      ],
    });

    const response = await POST(request({ query: "What rules apply?", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(200);
    expect(providers.topicGenerate).toHaveBeenCalledTimes(1);
    expect(providers.search).toHaveBeenCalledTimes(1);
    expect(providers.search).toHaveBeenCalledWith({
      query: "What rules apply?",
      stores: plan.map((item, index) => ({
        ...item,
        storeName: ["fileSearchStores/accra", "fileSearchStores/ghana", "fileSearchStores/west-africa"][index],
        documents: [[documents.selected], [documents.ghana], [documents.westAfrica]][index]
          .map(({ resourceId, versionId, documentName }) => ({ resourceId, versionId, documentName })),
      })),
    }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }));
    expect(providers.search.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
    expect(providers.search.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(10_000);
    const payload = await response.json();
    const context = JSON.parse(payload.result);
    expect(context.sources.map((source: { sourceRef: string; jurisdictionId: string }) => [source.sourceRef, source.jurisdictionId]))
      .toEqual([["J1", "selected-id"], ["J2", "ghana-id"]]);
    expect(context.sources[0].citations).toEqual([{ title: "Accra Bylaw", officialCitation: "AB 1", sourceUrl: "https://official.example/accra", pageNumber: 1 }]);
    expect(context.sources[1].citations).toEqual([{ title: "Ghana Act", officialCitation: "Act 4", sourceUrl: "https://official.example/ghana", pageNumber: 2 }]);
    expect(JSON.stringify(payload)).not.toMatch(/fileSearchStores|forged|evil\.invalid/);
    const encoded = response.headers.get("x-admin-e2e-retrieval-plan-v2");
    const observation = decodeRetrievalObservationV2(encoded!);
    expect(observation).toMatchObject({ version: 2, fileSearchCallCount: 1, fileSearchStoreCount: 3, fileSearchLatencyMs: 23, citationCount: 2, partialCoverage: true });
    const telemetry = auth.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase")?.[1];
    expect(telemetry).toMatchObject({ fileSearchCallCount: 1, fileSearchStoreCount: 3, fileSearchLatencyMs: 23, citationCount: 2, partialCoverage: true });
    expect(JSON.stringify(telemetry)).not.toMatch(/fileSearchStores|What rules|Local evidence|Accra Bylaw/);
    expect(transport.fetch).toHaveBeenCalledTimes(3);
    expect(transport.fetch.mock.calls.every(([, init]) => (init as RequestInit).signal instanceof AbortSignal)).toBe(true);
  });

  it("derives evidence metrics and partial coverage only from normalized governed sources", async () => {
    enableObservation();
    auth.fetchAuthQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:resolveResearchSelection") return selected;
      if (name === "jurisdictions:resolveResearchScope") return { selectedJurisdictionId: selected.id, items: plan.slice(0, 2) };
      return true;
    });
    transport.fetch.mockImplementation(async (_url, init) => {
      const requestBody = (init as RequestInit).body;
      const body = JSON.parse(ArrayBuffer.isView(requestBody)
        ? new TextDecoder().decode(requestBody as ArrayBufferView<ArrayBuffer>)
        : String(requestBody));
      return responseJson(body.supplementaryJurisdictionIds.length === 0
        ? { selected: readyResolution.selected, supplementary: [] }
        : { selected: readyResolution.selected, supplementary: [readyResolution.supplementary[0]] });
    });
    const duplicate = "Duplicated governed paragraph.";
    providers.search.mockResolvedValue({ latencyMs: 9, sources: [
      providerSource(selected.id, duplicate, [{ resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName }]),
      providerSource("ghana-id", duplicate, [{ resourceId: documents.ghana.resourceId, versionId: documents.ghana.versionId, documentName: documents.ghana.documentName }]),
    ] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const governed = JSON.parse(payload.result);
    expect(governed.sources).toEqual([expect.objectContaining({ jurisdictionId: selected.id, content: duplicate })]);
    expect(payload.partialCoverage).toEqual([{ jurisdictionId: "ghana-id", name: "Ghana", kind: "geographic", relation: "geographic_ancestor" }]);
    const observation = decodeRetrievalObservationV2(response.headers.get("x-admin-e2e-retrieval-plan-v2")!);
    expect(observation).toMatchObject({
      evidenceBytes: new TextEncoder().encode(duplicate).byteLength,
      citationCount: 1,
      partialCoverage: true,
      jurisdictions: [
        { ordinal: 0, relation: "selected", coverage: "evidence" },
        { ordinal: 1, relation: "geographic_ancestor", coverage: "no_evidence" },
      ],
    });
    const telemetry = auth.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase")?.[1];
    expect(telemetry).toMatchObject({ resultCount: 1, evidenceBytes: observation.evidenceBytes, citationCount: 1, partialCoverage: true });
  });

  it("records terminal no-evidence when governed normalization retains no sources", async () => {
    enableObservation();
    const oversizedName = "n".repeat(120_001);
    auth.fetchAuthQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "jurisdictions:resolveResearchSelection") return { ...selected, name: oversizedName };
      if (name === "jurisdictions:resolveResearchScope") return {
        selectedJurisdictionId: selected.id,
        items: [{ ...plan[0], name: oversizedName }],
      };
      return true;
    });
    providers.search.mockResolvedValue({ latencyMs: 6, sources: [providerSource(selected.id, "Retained before governance", [])] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(500);
    const observation = decodeRetrievalObservationV2(response.headers.get("x-admin-e2e-retrieval-plan-v2")!);
    expect(observation).toMatchObject({ evidenceBytes: 0, citationCount: 0, jurisdictions: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }] });
    const telemetry = auth.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase")?.[1];
    expect(telemetry).toMatchObject({ providerStatus: "failure", resultCount: 0, evidenceBytes: 0, citationCount: 0 });
  });

  it("bounds a stalled selected manifest preflight with the overall deadline", async () => {
    vi.useFakeTimers();
    try {
      transport.fetch.mockImplementation(async (_url, init) => await new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const pending = POST(request({ query: "Question", jurisdictionId: selected.id }));
      await vi.advanceTimersByTimeAsync(20_001);
      const response = await pending;
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "We couldn't find relevant legal information for your question." });
      expect(providers.createTopic).not.toHaveBeenCalled();
      expect(providers.createResearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["unconfigured", "Search is not set up for Accra."],
    ["provisioning", "Gemini search is being set up for Accra. You can leave this page; the status updates automatically."],
    ["needs_review", "Search is paused for Accra because its index needs review."],
  ])("returns the approved %s message with zero model calls", async (status, message) => {
    transport.fetch.mockResolvedValue(responseJson({ selected: { jurisdictionId: selected.id, status }, supplementary: [] }));
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(providers.topicGenerate).not.toHaveBeenCalled();
    expect(providers.initialize).not.toHaveBeenCalled();
    expect(providers.search).not.toHaveBeenCalled();
  });

  it("omits unavailable supplementary stores and marks partial coverage", async () => {
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson({
        selected: readyResolution.selected,
        supplementary: [{ jurisdictionId: "ghana-id", status: "needs_review" }, readyResolution.supplementary[1]],
      }));
    providers.search.mockResolvedValue({ latencyMs: 5, sources: [
      providerSource("selected-id", "Local", [{ resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName }]),
      providerSource("west-africa-id", "Regional", [{ resourceId: documents.westAfrica.resourceId, versionId: documents.westAfrica.versionId, documentName: documents.westAfrica.documentName }]),
    ] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(200);
    expect(providers.search.mock.calls[0][0].stores.map((store: { jurisdictionId: string }) => store.jurisdictionId))
      .toEqual(["selected-id", "west-africa-id"]);
    const payload = await response.json();
    expect(payload.partialCoverage).toEqual([{ jurisdictionId: "ghana-id", name: "Ghana", kind: "geographic", relation: "geographic_ancestor" }]);
  });

  it("rejects selected store drift during full preflight before File Search initialization", async () => {
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson({
        selected: { ...readyResolution.selected, storeName: "fileSearchStores/accra-replaced", documents: [] },
        supplementary: readyResolution.supplementary,
      }));
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "That jurisdiction is not available for research." });
    expect(providers.createResearch).not.toHaveBeenCalled();
    expect(providers.initialize).not.toHaveBeenCalled();
    expect(providers.search).not.toHaveBeenCalled();
  });

  it("requires selected-jurisdiction evidence from the one provider response", async () => {
    enableObservation();
    providers.search.mockResolvedValue({ latencyMs: 7, sources: [providerSource("ghana-id", "Only national", [])] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(500);
    expect(providers.search).toHaveBeenCalledTimes(1);
    expect(auth.fetchAuthMutation.mock.calls.some(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase")).toBe(true);
    const observation = decodeRetrievalObservationV2(response.headers.get("x-admin-e2e-retrieval-plan-v2")!);
    expect(observation).toMatchObject({ evidenceBytes: 0, citationCount: 0, fileSearchStoreCount: 3 });
    expect(observation.jurisdictions.every(({ coverage }) => coverage === "no_evidence")).toBe(true);
  });

  it("rejects quota after selected readiness and before topic or provider construction", async () => {
    auth.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "usage:recordQuestion") {
        throw new (await import("convex/values")).ConvexError({ code: "QUOTA_EXCEEDED", limit: 10, isPro: false });
      }
    });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(402);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(providers.createTopic).not.toHaveBeenCalled();
    expect(providers.createResearch).not.toHaveBeenCalled();
    expect(providers.topicGenerate).not.toHaveBeenCalled();
    expect(providers.initialize).not.toHaveBeenCalled();
    expect(providers.search).not.toHaveBeenCalled();
  });

  it("fails selected postflight store drift after one search and before synthesis", async () => {
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson(readyResolution))
      .mockResolvedValueOnce(responseJson({
        selected: { ...readyResolution.selected, storeName: "fileSearchStores/accra-replaced", documents: [] },
        supplementary: readyResolution.supplementary,
      }));
    providers.search.mockResolvedValue({ latencyMs: 3, sources: [providerSource(selected.id, "stale", [])] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "That jurisdiction is not available for research." });
    expect(providers.search).toHaveBeenCalledTimes(1);
  });

  it("drops a supplementary jurisdiction that drifts during retrieval while preserving historical store count", async () => {
    enableObservation();
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson(readyResolution))
      .mockResolvedValueOnce(responseJson({
        selected: readyResolution.selected,
        supplementary: [{ jurisdictionId: "ghana-id", status: "needs_review" }, readyResolution.supplementary[1]],
      }));
    providers.search.mockResolvedValue({ latencyMs: 4, sources: [
      providerSource(selected.id, "Local", [{ resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName }]),
      providerSource("ghana-id", "Stale national", [{ resourceId: documents.ghana.resourceId, versionId: documents.ghana.versionId, documentName: documents.ghana.documentName }]),
      providerSource("west-africa-id", "Regional", [{ resourceId: documents.westAfrica.resourceId, versionId: documents.westAfrica.versionId, documentName: documents.westAfrica.documentName }]),
    ] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }, true));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result).not.toContain("Stale national");
    expect(payload.partialCoverage).toEqual([{ jurisdictionId: "ghana-id", name: "Ghana", kind: "geographic", relation: "geographic_ancestor" }]);
    const observation = decodeRetrievalObservationV2(response.headers.get("x-admin-e2e-retrieval-plan-v2")!);
    expect(observation.fileSearchStoreCount).toBe(3);
    expect(observation.jurisdictions[1].coverage).toBe("unavailable");
  });

  it("rejects selected evidence when its active version changes during retrieval", async () => {
    const replacement = { ...documents.selected, versionId: "version-selected-v2", documentName: "fileSearchStores/accra/documents/bylaw-v2" };
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson(readyResolution))
      .mockResolvedValueOnce(responseJson({
        selected: { ...readyResolution.selected, documents: [replacement] },
        supplementary: readyResolution.supplementary,
      }));
    providers.search.mockResolvedValue({ latencyMs: 2, sources: [providerSource(
      selected.id,
      "Current law",
      [{ resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName }],
    )] });
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't find relevant legal information for your question.",
    });
  });

  it("keeps only spans authorized by the active manifest after retrieval", async () => {
    const replacement = { ...documents.selected, versionId: "version-selected-v2", documentName: "fileSearchStores/accra/documents/bylaw-v2" };
    transport.fetch
      .mockResolvedValueOnce(responseJson({ selected: readyResolution.selected, supplementary: [] }))
      .mockResolvedValueOnce(responseJson(readyResolution))
      .mockResolvedValueOnce(responseJson({
        selected: { ...readyResolution.selected, documents: [replacement] },
        supplementary: readyResolution.supplementary,
      }));
    providers.search.mockResolvedValue({ latencyMs: 2, sources: [{
      jurisdictionId: selected.id,
      spans: [
        { content: "Old unpublished candidate text", citation: { resourceId: documents.selected.resourceId, versionId: documents.selected.versionId, documentName: documents.selected.documentName } },
        { content: "Current active law", citation: { resourceId: replacement.resourceId, versionId: replacement.versionId, documentName: replacement.documentName } },
      ],
    }] });

    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(200);
    const result = (await response.json()).result as string;
    expect(result).toContain("Current active law");
    expect(result).not.toContain("Old unpublished candidate text");
  });

  it("records zero File Search calls when provider initialization fails before search", async () => {
    providers.initialize.mockRejectedValue(new Error("not configured"));
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id }));
    expect(response.status).toBe(500);
    expect(providers.search).not.toHaveBeenCalled();
    const telemetry = auth.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === "telemetry:recordSearchPhase")?.[1];
    expect(telemetry).toMatchObject({ fileSearchCallCount: 0, fileSearchStoreCount: 0, fileSearchLatencyMs: 0 });
  });

  it("rejects client-supplied provider identities before lookup or provider use", async () => {
    const response = await POST(request({ query: "Question", jurisdictionId: selected.id, storeName: "fileSearchStores/forged" }));
    expect(response.status).toBe(400);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(providers.search).not.toHaveBeenCalled();
  });
});
