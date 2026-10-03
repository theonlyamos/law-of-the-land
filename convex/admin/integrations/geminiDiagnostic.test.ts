import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectGeminiProvider, type DiagnosticTarget, type GeminiDiagnosticClient } from "./geminiDiagnostic";

const STORE = "fileSearchStores/ohada-law";
const OPERATION = `${STORE}/upload/operations/retained-1`;
const DOCUMENT = `${STORE}/documents/insolvency-2015`;
const SECRET = "AIza-test-secret-must-never-be-returned";
const target: DiagnosticTarget = {
  storeName: STORE,
  operationName: OPERATION,
  metadata: {
    environment: "production", jurisdiction_id: "jurisdiction-1", resource_id: "resource-1",
    version_id: "version-1", version_number: "2", sha256: "a".repeat(64),
  },
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    name: DOCUMENT, state: "STATE_FAILED", sizeBytes: "20786130", mimeType: "application/pdf",
    createTime: "2026-10-02T10:00:00Z", updateTime: "2026-10-02T10:05:00Z",
    customMetadata: Object.entries(target.metadata).map(([key, stringValue]) => ({ key, stringValue })),
    ...overrides,
  };
}

function client(pages: unknown[][] = [[document()]], operation: unknown = { name: OPERATION, done: false }) {
  let index = 0;
  const pager = {
    get page() { return pages[index]; },
    hasNextPage: () => index + 1 < pages.length,
    nextPage: vi.fn(async () => pages[++index]),
  };
  const sdk = {
    operations: { get: vi.fn(async () => operation) },
    fileSearchStores: { documents: {
      list: vi.fn(async () => pager),
      get: vi.fn(async () => document()),
    } },
  } satisfies GeminiDiagnosticClient;
  return { sdk, pager };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("read-only Gemini diagnostic", () => {
  it("reports a failed exact document even when its retained operation is pending", async () => {
    const { sdk } = client();
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation).toMatchObject({ status: "ok", done: false, error: null, response: null, requestError: null });
    expect(result.documents).toMatchObject({
      scanComplete: true, pagesScanned: 1, documentsScanned: 1, matchingCount: 1,
      duplicateMatches: false, stateCounts: { pending: 0, active: 0, failed: 1, unspecified: 0, unknown: 0 },
      matches: [{ state: "STATE_FAILED", sizeBytes: "20786130", metadata: target.metadata }],
    });
    expect(result.operation.reference).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.documents.matches[0].reference).toMatch(/^sha256:[a-f0-9]{64}$/);
    const output = JSON.stringify(result);
    expect(output).not.toContain(OPERATION);
    expect(output).not.toContain(DOCUMENT);
    expect(output).not.toContain(SECRET);
  });

  it("scans beyond the first page and keeps unrelated metadata out of the result", async () => {
    const other = document({ name: `${STORE}/documents/another`, state: "STATE_ACTIVE", customMetadata: [{ key: "version_id", stringValue: "private-other-version" }] });
    const { sdk } = client([[other], [], [document()]]);
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents).toMatchObject({ scanComplete: true, pagesScanned: 3, documentsScanned: 2, matchingCount: 1 });
    expect(result.documents.stateCounts.active).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-other-version");
  });

  it("stops after twenty pages and explicitly reports an incomplete scan", async () => {
    const { sdk, pager } = client(Array.from({ length: 21 }, () => Array.from({ length: 20 }, () => document({ customMetadata: [] }))));
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents).toMatchObject({ scanComplete: false, pagesScanned: 20, documentsScanned: 400, matchingCount: 0 });
    expect(pager.nextPage).toHaveBeenCalledTimes(19);
  });

  it("reports distinct exact matches as ambiguous and ignores repeated names", async () => {
    const { sdk } = client([[document(), document()], [document({ name: `${STORE}/documents/duplicate` })]]);
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents).toMatchObject({ scanComplete: true, matchingCount: 2, duplicateMatches: true });
    expect(result.documents.matches).toHaveLength(2);
  });

  it.each(["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const)("requires exact %s metadata", async (key) => {
    const customMetadata = Object.entries(target.metadata).map(([entry, stringValue]) => ({ key: entry, stringValue: entry === key ? "mismatch" : stringValue }));
    const { sdk } = client([[document({ customMetadata })]]);
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents.matchingCount).toBe(0);
  });

  it.each([
    { key: "version_id", stringValue: "version-1" },
    { key: "version_id", stringValue: "conflicting" },
  ])("rejects duplicate metadata keys even when one value matches", async (duplicate) => {
    const customMetadata = [...document().customMetadata, duplicate];
    const { sdk } = client([[document({ customMetadata })]]);
    expect((await inspectGeminiProvider(target, SECRET, sdk)).documents.matchingCount).toBe(0);
  });

  it("rejects metadata with multiple value types", async () => {
    const customMetadata = document().customMetadata.map((entry) => ({ ...entry, ...(entry.key === "version_number" ? { numericValue: 2 } : {}) }));
    const { sdk } = client([[document({ customMetadata })]]);
    expect((await inspectGeminiProvider(target, SECRET, sdk)).documents.matchingCount).toBe(0);
  });

  it("independently gets a same-store operation document and verifies its metadata", async () => {
    const { sdk } = client([[]], { name: OPERATION, done: true, response: { documentName: DOCUMENT } });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation.response).toMatchObject({ documentInExpectedStore: true, metadataMatched: true, document: { state: "STATE_FAILED", metadata: target.metadata }, requestError: null });
    expect(result.documents.matchingCount).toBe(0);
    expect(sdk.fileSearchStores.documents.get).toHaveBeenCalledWith({ name: DOCUMENT });
  });

  it("does not get a cross-store operation response document", async () => {
    const foreign = "fileSearchStores/foreign/documents/foreign";
    const { sdk } = client([[]], { name: OPERATION, done: true, response: { documentName: foreign } });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation.response).toMatchObject({ documentInExpectedStore: false, metadataMatched: null, document: null });
    expect(result.operation).toMatchObject({ status: "error", requestError: { kind: "invalid_response", status: null } });
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(foreign);
  });

  it.each([{}, { documentName: "not-a-document-name" }, null, "invalid-response"])("classifies malformed terminal response %j as invalid without hiding document observations", async (response) => {
    const { sdk } = client([[document()]], { name: OPERATION, done: true, response });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation).toMatchObject({ status: "error", done: true, requestError: { kind: "invalid_response", status: null } });
    expect(result.operation.response?.document).toBeNull();
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
    expect(result.documents).toMatchObject({ scanComplete: true, matchingCount: 1 });
  });

  it.each(["invalid-error", null, {}, { code: 0 }, { code: 17 }, { code: 3.5 }, { code: "13" }])("classifies malformed terminal error %j as invalid without exposing it", async (error) => {
    const { sdk } = client([[document()]], { name: OPERATION, done: true, error });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation).toMatchObject({ status: "error", done: true, error: { code: null, messagePresent: false }, requestError: { kind: "invalid_response", status: null } });
    expect(result.documents).toMatchObject({ scanComplete: true, matchingCount: 1 });
  });

  it("rejects mismatched operation/get identities and foreign list documents", async () => {
    const foreign = "fileSearchStores/foreign/documents/foreign";
    const { sdk } = client([[document({ name: foreign })]], { name: `${STORE}/upload/operations/another`, done: false });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation.requestError?.kind).toBe("invalid_response");
    expect(result.documents.matchingCount).toBe(0);
    const second = client([[]], { name: OPERATION, done: true, response: { documentName: DOCUMENT } });
    second.sdk.fileSearchStores.documents.get.mockResolvedValue(document({ name: foreign }));
    const secondResult = await inspectGeminiProvider(target, SECRET, second.sdk);
    expect(secondResult.operation.response?.requestError?.kind).toBe("invalid_response");
    expect(secondResult.operation.response?.document).toBeNull();
  });

  it("retains no provider messages, bodies, headers, credentials, or unrecognized fields", async () => {
    const { sdk } = client([[document({ displayName: SECRET, arbitrary: SECRET })]], {
      name: OPERATION, done: true, error: { code: 13, message: SECRET, details: { authorization: SECRET } }, sdkHttpResponse: { headers: { authorization: SECRET } },
    });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation.error).toEqual({ code: 13, messagePresent: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("still scans documents when operation get fails and sanitizes independent request errors", async () => {
    const { sdk } = client();
    sdk.operations.get.mockRejectedValue({ status: 404, message: SECRET, response: SECRET });
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.operation).toMatchObject({ status: "error", requestError: { kind: "provider", status: 404 } });
    expect(result.documents.matchingCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    sdk.fileSearchStores.documents.list.mockRejectedValue({ status: 403, message: SECRET });
    const failed = await inspectGeminiProvider(target, SECRET, sdk);
    expect(failed.documents).toMatchObject({ scanComplete: false, requestError: { kind: "provider", status: 403 } });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  it("preserves partial results when a later page fails", async () => {
    const { sdk, pager } = client([[document()], []]);
    pager.nextPage.mockRejectedValue(new Error(SECRET));
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents).toMatchObject({ scanComplete: false, pagesScanned: 1, documentsScanned: 1, matchingCount: 1, requestError: { kind: "provider", status: null } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("flags malformed or foreign-store list rows while preserving valid document observations", async () => {
    const { sdk } = client([[null, 13, document({ name: "fileSearchStores/foreign/documents/foreign" }), document()]]);
    const result = await inspectGeminiProvider(target, SECRET, sdk);
    expect(result.documents).toMatchObject({
      scanComplete: false, pagesScanned: 1, documentsScanned: 4, matchingCount: 1,
      stateCounts: { failed: 1, unknown: 3 }, requestError: { kind: "invalid_response", status: null },
    });
    expect(result.documents.matches[0].metadata).toEqual(target.metadata);
  });

  it("rejects invalid target bindings before contacting the provider", async () => {
    const { sdk } = client();
    await expect(inspectGeminiProvider({ ...target, operationName: "fileSearchStores/foreign/upload/operations/foreign" }, SECRET, sdk)).rejects.toThrow("GEMINI_DIAGNOSTIC_TARGET_INVALID");
    expect(sdk.operations.get).not.toHaveBeenCalled();
    expect(sdk.fileSearchStores.documents.list).not.toHaveBeenCalled();
  });

  it("uses only GET requests in the default SDK client", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      requests.push({ url, method });
      if (url.includes("/upload/operations/")) return new Response(JSON.stringify({ name: OPERATION, done: true, response: { documentName: DOCUMENT } }), { headers: { "content-type": "application/json" } });
      if (url.includes("/documents/")) return new Response(JSON.stringify(document()), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ documents: [document()] }), { headers: { "content-type": "application/json" } });
    }));
    const result = await inspectGeminiProvider(target, SECRET);
    expect(result.documents.matchingCount).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.every(({ url }) => url.startsWith("https://generativelanguage.googleapis.com/"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
