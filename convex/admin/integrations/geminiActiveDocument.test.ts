import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyActiveGeminiDocument } from "./geminiActiveDocument";
import type { DiagnosticTarget, GeminiDiagnosticClient } from "./geminiDiagnostic";

const STORE = "fileSearchStores/ohada-law";
const OPERATION = `${STORE}/upload/operations/retained-1`;
const DOCUMENT = `${STORE}/documents/insolvency-2015`;
const SECRET = "synthetic-active-document-provider-secret";
const FAILURE = "GEMINI_ACTIVE_DOCUMENT_PROOF_FAILED";
const target: DiagnosticTarget = {
  storeName: STORE, operationName: OPERATION,
  metadata: { environment: "production", jurisdiction_id: "jurisdiction-1", resource_id: "resource-1", version_id: "version-1", version_number: "1", sha256: "a".repeat(64) },
};

function metadata(overrides: Partial<DiagnosticTarget["metadata"]> = {}) {
  return Object.entries({ ...target.metadata, ...overrides }).map(([key, stringValue]) => ({ key, stringValue }));
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: DOCUMENT, state: "STATE_ACTIVE", customMetadata: metadata(), ...overrides };
}

function client(pages: unknown[][] = [[document()]]) {
  const calls: string[] = [];
  let pageIndex = 0;
  const pager = {
    get page() { return pages[pageIndex]; },
    hasNextPage: () => pageIndex + 1 < pages.length,
    nextPage: vi.fn(async () => { calls.push("nextPage"); return pages[++pageIndex]; }),
  };
  const sdk = {
    operations: { get: vi.fn(async (): Promise<unknown> => { calls.push("operation"); return { name: OPERATION, done: false }; }) },
    fileSearchStores: { documents: {
      list: vi.fn(async () => { calls.push("list"); return pager; }),
      get: vi.fn(async (): Promise<unknown> => { calls.push("document"); return document(); }),
    } },
  } satisfies GeminiDiagnosticClient;
  return { sdk, pager, calls };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("active Gemini document proof", () => {
  it("proves one exact active document between initial and final pending operation reads", async () => {
    const { sdk, calls } = client();
    const before = Date.now();
    const result = await verifyActiveGeminiDocument(target, SECRET, sdk);
    expect(result).toEqual({ documentName: DOCUMENT, verifiedAt: expect.any(Number) });
    expect(result.verifiedAt).toBeGreaterThanOrEqual(before);
    expect(result.verifiedAt).toBeLessThanOrEqual(Date.now());
    expect(calls).toEqual(["operation", "list", "document", "operation"]);
    expect(sdk.fileSearchStores.documents.get).toHaveBeenCalledWith({ name: DOCUMENT });
  });

  it("allows omitted done for a pending operation and timestamps after its final read", async () => {
    const { sdk } = client();
    let finalReadFinished = false;
    sdk.operations.get.mockResolvedValueOnce({ name: OPERATION }).mockImplementationOnce(async () => { finalReadFinished = true; return { name: OPERATION }; });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      expect(finalReadFinished).toBe(true);
      return 1_800_000_000_000;
    });
    expect(await verifyActiveGeminiDocument(target, SECRET, sdk)).toEqual({ documentName: DOCUMENT, verifiedAt: 1_800_000_000_000 });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("completes a multi-page scan including valid unrelated documents", async () => {
    const unrelated = document({ name: `${STORE}/documents/unrelated`, customMetadata: metadata({ version_id: "other-version" }) });
    const legacy = document({ name: `${STORE}/documents/legacy`, customMetadata: undefined });
    const { sdk, calls } = client([[unrelated], [], [legacy, document()]]);
    expect((await verifyActiveGeminiDocument(target, SECRET, sdk)).documentName).toBe(DOCUMENT);
    expect(calls).toEqual(["operation", "list", "nextPage", "nextPage", "document", "operation"]);
  });

  it.each(["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const)("requires exact list metadata for %s", async (key) => {
    const { sdk } = client([[document({ customMetadata: metadata({ [key]: "mismatch" }) })]]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it.each(["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const)("rechecks exact direct-get metadata for %s", async (key) => {
    const { sdk } = client();
    sdk.fileSearchStores.documents.get.mockResolvedValue(document({ customMetadata: metadata({ [key]: "mismatch" }) }));
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.operations.get).toHaveBeenCalledTimes(1);
  });

  it.each(["list", "get"] as const)("rejects duplicate exact metadata keys from %s", async (source) => {
    const invalid = document({ customMetadata: [...metadata(), { key: "version_id", stringValue: target.metadata.version_id }] });
    const { sdk } = client(source === "list" ? [[invalid]] : undefined);
    if (source === "get") sdk.fileSearchStores.documents.get.mockResolvedValue(invalid);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
  });

  it("rejects conflicting metadata value types", async () => {
    const { sdk } = client([[document({ customMetadata: metadata().map((entry) => ({ ...entry, ...(entry.key === "version_number" ? { numericValue: 1 } : {}) })) })]]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
  });

  it.each([DOCUMENT, `${STORE}/documents/second-match`])("rejects duplicate matching document rows (%s)", async (name) => {
    const { sdk } = client([[document()], [document({ name })]]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it("fails closed after twenty pages when more pages remain", async () => {
    const { sdk, pager } = client(Array.from({ length: 21 }, (_, index) => index === 0 ? [document()] : []));
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(pager.nextPage).toHaveBeenCalledTimes(19);
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it("accepts a complete twentieth page", async () => {
    const { sdk, pager } = client(Array.from({ length: 20 }, (_, index) => index === 19 ? [document()] : []));
    expect((await verifyActiveGeminiDocument(target, SECRET, sdk)).documentName).toBe(DOCUMENT);
    expect(pager.nextPage).toHaveBeenCalledTimes(19);
  });

  it("rejects oversized pages", async () => {
    const { sdk } = client([Array.from({ length: 21 }, () => document())]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
  });

  it.each([null, 42, {}, { name: "bad-name" }, { name: "fileSearchStores/foreign/documents/foreign" }])("rejects malformed or foreign list rows %j", async (row) => {
    const { sdk } = client([[document(), row]]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it.each(["STATE_PENDING", "STATE_FAILED", "STATE_UNSPECIFIED", "unknown", undefined])("rejects direct document state %s", async (state) => {
    const { sdk } = client();
    sdk.fileSearchStores.documents.get.mockResolvedValue(document({ state }));
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
  });

  it.each(["STATE_FAILED", "STATE_PENDING", "STATE_UNSPECIFIED", undefined])("rejects matching list state %s even if direct GET would be active", async (state) => {
    const { sdk } = client([[document({ state })]]);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it.each([null, {}, { name: `${STORE}/documents/another`, state: "STATE_ACTIVE", customMetadata: metadata() }, { name: "fileSearchStores/foreign/documents/foreign", state: "STATE_ACTIVE", customMetadata: metadata() }])("rejects malformed or wrong-identity direct document %j", async (value) => {
    const { sdk } = client();
    sdk.fileSearchStores.documents.get.mockResolvedValue(value);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
  });

  const invalidOperations = [
    null, {}, { name: `${STORE}/upload/operations/another`, done: false },
    { name: OPERATION, done: "false" }, { name: OPERATION, done: null },
    { name: OPERATION, done: true }, { name: OPERATION, done: false, error: null },
    { name: OPERATION, done: false, error: { code: 13, message: SECRET } },
    { name: OPERATION, done: false, response: {} },
  ];
  it.each(invalidOperations)("rejects malformed or nonpending initial operation %j before scanning", async (operation) => {
    const { sdk } = client();
    sdk.operations.get.mockResolvedValueOnce(operation);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.list).not.toHaveBeenCalled();
  });

  it.each(invalidOperations)("rejects changed or malformed final operation %j", async (operation) => {
    const { sdk } = client();
    sdk.operations.get.mockResolvedValueOnce({ name: OPERATION, done: false }).mockResolvedValueOnce(operation);
    await expect(verifyActiveGeminiDocument(target, SECRET, sdk)).rejects.toThrow(FAILURE);
    expect(sdk.fileSearchStores.documents.get).toHaveBeenCalledTimes(1);
  });

  it.each(["operation", "list", "nextPage", "get", "finalOperation"] as const)("returns only a fixed error when %s throws provider secrets", async (source) => {
    const { sdk, pager } = client([[document()], []]);
    const error = new Error(`Authorization: ${SECRET}; signed-url-secret; provider body`);
    if (source === "operation") sdk.operations.get.mockRejectedValueOnce(error);
    if (source === "list") sdk.fileSearchStores.documents.list.mockRejectedValueOnce(error);
    if (source === "nextPage") pager.nextPage.mockRejectedValueOnce(error);
    if (source === "get") sdk.fileSearchStores.documents.get.mockRejectedValueOnce(error);
    if (source === "finalOperation") sdk.operations.get.mockResolvedValueOnce({ name: OPERATION, done: false }).mockRejectedValueOnce(error);
    try {
      await verifyActiveGeminiDocument(target, SECRET, sdk);
      expect.unreachable("Provider error must reject the proof");
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(FAILURE);
      expect((caught as Error).cause).toBeUndefined();
      expect(String(caught)).not.toContain(SECRET);
    }
  });

  it("rejects invalid target scope and empty credentials before provider calls", async () => {
    const { sdk } = client();
    await expect(verifyActiveGeminiDocument({ ...target, operationName: "fileSearchStores/foreign/upload/operations/foreign" }, SECRET, sdk)).rejects.toThrow(FAILURE);
    await expect(verifyActiveGeminiDocument(target, " ", sdk)).rejects.toThrow(FAILURE);
    expect(sdk.operations.get).not.toHaveBeenCalled();
  });

  it("uses only GETs with the default SDK for the full proof", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, method: init?.method ?? (input instanceof Request ? input.method : "GET") });
      const response = url.includes("/upload/operations/") ? { name: OPERATION, done: false }
        : url.includes("/documents/") ? document() : { documents: [document()] };
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    }));
    expect((await verifyActiveGeminiDocument(target, SECRET)).documentName).toBe(DOCUMENT);
    expect(requests).toHaveLength(4);
    expect(requests.every(({ method, url }) => method === "GET" && url.startsWith("https://generativelanguage.googleapis.com/"))).toBe(true);
  });

  it("does not retry provider errors with the default SDK", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 503, message: SECRET } }), { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(verifyActiveGeminiDocument(target, SECRET)).rejects.toThrow(FAILURE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
