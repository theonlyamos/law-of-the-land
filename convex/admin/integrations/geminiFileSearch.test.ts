import { describe, expect, it, vi } from "vitest";

import { GeminiFileSearchAdapter, ProviderError, type GeminiFileSearchSdk } from "./geminiFileSearch";
import { isGeminiDocumentName, isGeminiFileSearchStoreName } from "../../lib/geminiFileSearchNames";

const STORE = "fileSearchStores/ghana-law";
const DOCUMENT = `${STORE}/documents/constitution-2026`;
const OPERATION = `${STORE}/upload/operations/index-ghana-1`;

function sdk(): GeminiFileSearchSdk {
  return {
    fileSearchStores: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      uploadToFileSearchStore: vi.fn(),
      documents: { delete: vi.fn() },
    },
    operations: { get: vi.fn() },
  };
}

describe("GeminiFileSearchAdapter", () => {
  it("accepts bounded Gemini resource IDs and rejects overlong or mismatched names", () => {
    const maxId = "a".repeat(40);
    const store = `fileSearchStores/${maxId}`;
    expect(isGeminiFileSearchStoreName(store)).toBe(true);
    expect(isGeminiDocumentName(`${store}/documents/${maxId}`)).toBe(true);
    expect(isGeminiFileSearchStoreName(`fileSearchStores/${"a".repeat(41)}`)).toBe(false);
    expect(isGeminiDocumentName(`${store}/documents/${"a".repeat(41)}`)).toBe(false);
  });
  it("creates a store and preserves the required embedding model", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.create).mockResolvedValue({
      name: STORE,
      embeddingModel: "models/gemini-embedding-2",
    });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.createStore({
      displayName: "Development Ghana legal research",
      embeddingModel: "models/gemini-embedding-2",
    })).resolves.toEqual({ name: STORE, embeddingModel: "models/gemini-embedding-2" });
    expect(client.fileSearchStores.create).toHaveBeenCalledWith({
      config: {
        displayName: "Development Ghana legal research",
        embeddingModel: "models/gemini-embedding-2",
      },
    });
  });

  it("returns a validated upload operation and polls pending, complete, and failed states", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.uploadToFileSearchStore).mockResolvedValue({ name: OPERATION });
    vi.mocked(client.operations.get)
      .mockResolvedValueOnce({ name: OPERATION })
      .mockResolvedValueOnce({ name: OPERATION, done: true, response: { documentName: DOCUMENT } })
      .mockResolvedValueOnce({ name: OPERATION, done: true, error: { code: 8, message: "Quota exhausted" } });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.uploadDocument({
      storeName: STORE,
      file: new Blob(["law"], { type: "text/plain" }),
      mimeType: "text/plain",
      displayName: "Constitution",
      customMetadata: [
        { key: "jurisdiction_id", stringValue: "ghana" },
        { key: "version_number", numericValue: 1 },
      ],
    })).resolves.toEqual({ operationName: OPERATION });
    await expect(adapter.getIndexOperation(OPERATION)).resolves.toEqual({ done: false });
    expect(client.operations.get).toHaveBeenCalledWith({
      operation: expect.objectContaining({
        name: OPERATION,
        _fromAPIResponse: expect.any(Function),
      }),
    });
    await expect(adapter.getIndexOperation(OPERATION)).resolves.toEqual({
      done: true,
      documentName: DOCUMENT,
    });
    await expect(adapter.getIndexOperation(OPERATION)).resolves.toEqual({
      done: true,
      error: { kind: "rate_limit", retryable: true, message: "Gemini operation was rate limited" },
    });
  });

  it("deletes only validated document and store resource names", async () => {
    const client = sdk();
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await adapter.deleteDocument(DOCUMENT);
    await adapter.deleteStore(STORE);
    expect(client.fileSearchStores.documents.delete).toHaveBeenCalledWith({ name: DOCUMENT, config: { force: true } });
    expect(client.fileSearchStores.delete).toHaveBeenCalledWith({ name: STORE, config: { force: true } });

    await expect(adapter.deleteDocument(`${STORE}/documents/../../other`))
      .rejects.toMatchObject({ kind: "invalid_request" });
    await expect(adapter.deleteStore("fileSearchStores/UPPERCASE"))
      .rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("retains the full denied Gemini response with its endpoint and status", async () => {
    const client = sdk();
    const rawResponse = "Permission denied for key test-key and store fileSearchStores/ghana-law";
    vi.mocked(client.fileSearchStores.uploadToFileSearchStore).mockRejectedValue({
      status: 403,
      message: rawResponse,
    });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.uploadDocument({
      storeName: STORE,
      file: new Blob(["law"], { type: "text/plain" }),
      mimeType: "text/plain",
      displayName: "Constitution",
      customMetadata: [],
    })).rejects.toMatchObject({
      kind: "authentication",
      retryable: false,
      status: 403,
      operation: "document_upload",
      message: "Gemini authentication failed",
      rawResponse,
    } satisfies Partial<ProviderError>);
  });

  it("marks an initial mutating 5xx as retryable but side-effect uncertain", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.create).mockRejectedValue({ status: 503 });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.createStore({
      displayName: "Development Ghana legal research",
      embeddingModel: "models/gemini-embedding-2",
    })).rejects.toMatchObject({ kind: "provider", retryable: true, sideEffectUncertain: true });
  });

  it.each([
    [400, "validation", false],
    [401, "authentication", false],
    [403, "authentication", false],
    [429, "rate_limit", true],
  ] as const)("treats explicit mutating HTTP %i rejections as definitive", async (status, kind, retryable) => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.create).mockRejectedValue({ status });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.createStore({
      displayName: "Development Ghana legal research",
      embeddingModel: "models/gemini-embedding-2",
    })).rejects.toMatchObject({ kind, retryable, sideEffectUncertain: false });
  });

  it("rejects stores that do not confirm the required embedding model", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.create).mockResolvedValue({
      name: STORE,
      embeddingModel: "models/gemini-embedding-001",
    });
    vi.mocked(client.fileSearchStores.get).mockResolvedValue({
      name: STORE,
      embeddingModel: "models/gemini-embedding-001",
    });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.createStore({
      displayName: "Development Ghana legal research",
      embeddingModel: "models/gemini-embedding-2",
    })).rejects.toMatchObject({ kind: "invalid_response", sideEffectUncertain: true });
    await expect(adapter.getStore(STORE))
      .rejects.toMatchObject({ kind: "invalid_response", sideEffectUncertain: false });
  });

  it("rejects malformed and mismatched operation poll responses", async () => {
    const client = sdk();
    const contradictoryPendingResponse = {
      name: OPERATION,
      done: false,
      response: { documentName: DOCUMENT },
    };
    vi.mocked(client.operations.get)
      .mockResolvedValueOnce({ name: "operations/other", done: false })
      .mockResolvedValueOnce(contradictoryPendingResponse);
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.getIndexOperation(OPERATION)).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(adapter.getIndexOperation(OPERATION)).rejects.toMatchObject({
      kind: "invalid_response",
      operation: "operation_poll",
      rawResponse: JSON.stringify(contradictoryPendingResponse),
    });
  });

  it.each([
    null,
    {},
    { code: 8 },
    { code: "8", message: "Quota exhausted" },
    { code: 8.5, message: "Quota exhausted" },
    { code: 17, message: "Quota exhausted" },
    { code: 8, message: "" },
    { code: 8, message: "x".repeat(1_025) },
    { code: 8, message: "Quota exhausted", details: [] },
    { code: 8, message: "Quota exhausted", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo" }] },
    { code: 8, message: "Quota exhausted", details: "unsupported" },
    { code: 8, message: "Quota exhausted", details: Array.from({ length: 21 }, () => ({ "@type": "unsupported" })) },
    { code: 8, message: "Quota exhausted", details: [{ nested: { value: { too: "deep" } } }] },
    { code: 8, message: "Quota exhausted", unexpected: true },
  ])("rejects a malformed completed-operation error as observation uncertainty: %j", async (error) => {
    const client = sdk();
    vi.mocked(client.operations.get).mockResolvedValue({ name: OPERATION, done: true, error });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.getIndexOperation(OPERATION)).rejects.toMatchObject({
      kind: "invalid_response",
      sideEffectUncertain: false,
    });
  });

  it("rejects a completed operation that contains both error and response", async () => {
    const client = sdk();
    vi.mocked(client.operations.get).mockResolvedValue({
      name: OPERATION,
      done: true,
      error: { code: 8, message: "Quota exhausted" },
      response: { documentName: DOCUMENT },
    });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.getIndexOperation(OPERATION)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects a different valid store returned by Gemini", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.get).mockResolvedValue({ name: "fileSearchStores/other-law" });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.getStore(STORE)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects an accepted upload operation from a different store", async () => {
    const client = sdk();
    vi.mocked(client.fileSearchStores.uploadToFileSearchStore).mockResolvedValue({
      name: "fileSearchStores/other-law/upload/operations/index-1",
    });
    const adapter = new GeminiFileSearchAdapter({ apiKey: "test-key", sdk: client });

    await expect(adapter.uploadDocument({
      storeName: STORE,
      file: new Blob(["law"]),
      mimeType: "text/plain",
      displayName: "Constitution",
      customMetadata: [],
    })).rejects.toMatchObject({ kind: "invalid_response", sideEffectUncertain: true });
  });
});
