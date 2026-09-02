import { describe, expect, it, vi } from "vitest";
import { executeGeminiJob, executionOptionsForJob, persistGeminiProviderResult } from "./geminiActions";
import { ProviderError } from "./integrations/geminiFileSearch";

function adapter() {
  return {
    createStore: vi.fn(async () => ({
      name: "fileSearchStores/ghana-test",
      embeddingModel: "models/gemini-embedding-2",
    })),
    uploadDocument: vi.fn(async () => ({ operationName: "fileSearchStores/ghana-test/upload/operations/index-1" })),
    getIndexOperation: vi.fn(async () => ({ done: false as const })),
    deleteDocument: vi.fn(async () => undefined),
    deleteStore: vi.fn(async () => undefined),
  };
}

describe("Gemini durable job executor", () => {
  it("requires an upload-size policy only for a fresh index execution", () => {
    const previous = process.env.ADMIN_MAX_DOCUMENT_BYTES;
    delete process.env.ADMIN_MAX_DOCUMENT_BYTES;
    expect(executionOptionsForJob({ type: "gemini_create_store" })).toEqual({});
    expect(executionOptionsForJob({ type: "gemini_index_document", providerOperationName: "fileSearchStores/ghana-test/upload/operations/index-1" })).toEqual({});
    expect(() => executionOptionsForJob({ type: "gemini_index_document" })).toThrow("Document upload limit is not configured");
    if (previous === undefined) delete process.env.ADMIN_MAX_DOCUMENT_BYTES;
    else process.env.ADMIN_MAX_DOCUMENT_BYTES = previous;
  });

  it("dispatches all four job types through server-resolved targets", async () => {
    const provider = adapter();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": "3", "content-type": "application/pdf" },
    }));

    await expect(executeGeminiJob(provider, {
      type: "gemini_create_store",
    }, {
      kind: "create_store",
      displayName: "law-of-the-land-test-ghana",
      embeddingModel: "models/gemini-embedding-2",
    }, { fetcher, maxDocumentBytes: 3 })).resolves.toEqual({
      kind: "store_created",
      storeName: "fileSearchStores/ghana-test",
      embeddingModel: "models/gemini-embedding-2",
    });

    await expect(executeGeminiJob(provider, {
      type: "gemini_index_document",
    }, {
      kind: "index_document",
      signedUrl: "https://storage.example.invalid/original",
      byteSize: 3,
      storeName: "fileSearchStores/ghana-test",
      mimeType: "application/pdf",
      displayName: "Act 1.pdf",
      customMetadata: [{ key: "jurisdictionId", stringValue: "jurisdiction-1" }],
    }, { fetcher, maxDocumentBytes: 3 })).resolves.toEqual({
      kind: "index_accepted",
      operationName: "fileSearchStores/ghana-test/upload/operations/index-1",
    });

    await expect(executeGeminiJob(provider, {
      type: "gemini_delete_document",
    }, {
      kind: "delete_document",
      documentName: "fileSearchStores/ghana-test/documents/act-1",
    }, { fetcher, maxDocumentBytes: 3 })).resolves.toEqual({ kind: "document_deleted" });

    await expect(executeGeminiJob(provider, {
      type: "gemini_delete_store",
    }, {
      kind: "delete_store",
      storeName: "fileSearchStores/ghana-test",
    }, { fetcher, maxDocumentBytes: 3 })).resolves.toEqual({
      kind: "store_deleted",
      storeName: "fileSearchStores/ghana-test",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(provider.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      storeName: "fileSearchStores/ghana-test",
      file: expect.any(Blob),
    }));
    expect(provider.deleteStore).toHaveBeenCalledWith("fileSearchStores/ghana-test");
  });

  it("polls an accepted upload without fetching or uploading the original again", async () => {
    const provider = adapter();
    const fetcher = vi.fn();

    await expect(executeGeminiJob(provider, {
      type: "gemini_index_document",
      providerOperationName: "fileSearchStores/ghana-test/upload/operations/index-1",
    }, {
      kind: "index_document",
      signedUrl: "https://storage.example.invalid/original",
      byteSize: 3,
      storeName: "fileSearchStores/ghana-test",
      mimeType: "application/pdf",
      displayName: "Act 1.pdf",
      customMetadata: [],
    }, { fetcher, maxDocumentBytes: 3 })).resolves.toEqual({ kind: "index_pending" });

    expect(provider.getIndexOperation).toHaveBeenCalledWith("fileSearchStores/ghana-test/upload/operations/index-1");
    expect(provider.uploadDocument).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an explicitly completed operation failure instead of treating it as a poll observation error", async () => {
    const provider = {
      ...adapter(),
      getIndexOperation: vi.fn(async () => ({
        done: true as const,
        error: { kind: "validation" as const, retryable: false, message: "Gemini rejected the indexed document" },
      })),
    };

    await expect(executeGeminiJob(provider, {
      type: "gemini_index_document",
      providerOperationName: "fileSearchStores/ghana-test/upload/operations/index-1",
    }, {
      kind: "index_document",
      byteSize: 3,
      storeName: "fileSearchStores/ghana-test",
      mimeType: "application/pdf",
      displayName: "Act 1.pdf",
      customMetadata: [],
    }, {})).resolves.toEqual({ kind: "index_failed", errorKind: "validation" });

    expect(provider.uploadDocument).not.toHaveBeenCalled();
  });

  it("enforces configured and response byte limits before constructing an upload Blob", async () => {
    const provider = adapter();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    const target = {
      kind: "index_document" as const,
      signedUrl: "https://storage.example.invalid/original",
      byteSize: 4,
      storeName: "fileSearchStores/ghana-test",
      mimeType: "application/pdf",
      displayName: "Act 1.pdf",
      customMetadata: [],
    };

    await expect(executeGeminiJob(provider, { type: "gemini_index_document" }, target, {
      fetcher,
      maxDocumentBytes: 3,
    })).rejects.toThrow("DOCUMENT_TOO_LARGE");
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.uploadDocument).not.toHaveBeenCalled();

    await expect(executeGeminiJob(provider, { type: "gemini_index_document" }, {
      ...target,
      byteSize: 3,
    }, { fetcher, maxDocumentBytes: 3 })).rejects.toThrow("DOCUMENT_TOO_LARGE");
    expect(provider.uploadDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["Act 1.pdf", "audio/mpeg"],
    ["Act 1.mp3", "audio/mpeg"],
    ["Act 1.pdf", "image/png"],
    ["Act 1.mp4", "video/mp4"],
  ])("rejects a disallowed display-name and MIME pair before fetching or uploading: %s / %s", async (displayName, mimeType) => {
    const provider = adapter();
    const fetcher = vi.fn();
    await expect(executeGeminiJob(provider, { type: "gemini_index_document" }, {
      kind: "index_document", signedUrl: "https://storage.example.invalid/original", byteSize: 3,
      storeName: "fileSearchStores/ghana-test", mimeType, displayName, customMetadata: [],
    }, { fetcher, maxDocumentBytes: 3 })).rejects.toThrow("Invalid Gemini durable job");
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.uploadDocument).not.toHaveBeenCalled();
  });

  it("treats an exact-target document delete not-found response as idempotent success", async () => {
    const provider = adapter();
    provider.deleteDocument.mockRejectedValueOnce(new ProviderError("not_found", false, 404, "missing"));
    await expect(executeGeminiJob(provider, { type: "gemini_delete_document" }, {
      kind: "delete_document", documentName: "fileSearchStores/ghana-test/documents/act-1",
    }, {})).resolves.toEqual({ kind: "document_deleted" });
  });

  it("quarantines a provider success whose durable result cannot be persisted", async () => {
    const provider = adapter();
    const result = await executeGeminiJob(provider, { type: "gemini_index_document" }, {
      kind: "index_document", signedUrl: "https://storage.example.invalid/original", byteSize: 3,
      storeName: "fileSearchStores/ghana-test", mimeType: "application/pdf", displayName: "Act 1.pdf", customMetadata: [],
    }, {
      fetcher: async () => new Response(new Uint8Array([1, 2, 3])), maxDocumentBytes: 3,
    });
    const persist = vi.fn(async () => { throw new Error("result write failed"); });
    const failure = vi.fn(async () => undefined);

    await expect(persistGeminiProviderResult({ result, persist, failure })).resolves.toBe("manual_review");
    expect(provider.uploadDocument).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith({
      kind: "invalid_response", retryable: false, sideEffectUncertain: true,
      providerOperationName: "fileSearchStores/ghana-test/upload/operations/index-1",
    });

    await expect(persistGeminiProviderResult({
      result: { kind: "store_deleted", storeName: "fileSearchStores/ghana-test" },
      persist,
      failure,
    })).resolves.toBe("manual_review");
    expect(failure).toHaveBeenLastCalledWith({
      kind: "invalid_response", retryable: false, sideEffectUncertain: true,
    });
  });
});
