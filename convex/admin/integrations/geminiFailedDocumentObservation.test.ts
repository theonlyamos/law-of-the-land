import { describe, expect, it, vi } from "vitest";
import { observeFailedGeminiDocument, verifyCompletedGeminiDocument } from "./geminiFailedDocumentObservation";
import type { DiagnosticTarget, GeminiDiagnosticClient } from "./geminiDiagnostic";

const STORE = "fileSearchStores/ohada-failed";
const OPERATION = `${STORE}/upload/operations/retained-1`;
const DOCUMENT = `${STORE}/documents/failed-1`;
const SECRET = "synthetic-provider-secret";
const target: DiagnosticTarget = {
  storeName: STORE, operationName: OPERATION,
  metadata: { environment: "production", jurisdiction_id: "jurisdiction-1", resource_id: "resource-1", version_id: "version-1", version_number: "1", sha256: "a".repeat(64) },
};
function metadata(overrides: Partial<DiagnosticTarget["metadata"]> = {}) {
  return Object.entries({ ...target.metadata, ...overrides }).map(([key, stringValue]) => ({ key, stringValue }));
}
function document(overrides: Record<string, unknown> = {}) {
  return { name: DOCUMENT, state: "STATE_FAILED", customMetadata: metadata(), ...overrides };
}
function client(pages: unknown[][] = [[document()]]) {
  const calls: string[] = [];
  let pageIndex = 0;
  const pager = {
    get page() { return pages[pageIndex]; },
    hasNextPage: vi.fn(() => pageIndex + 1 < pages.length),
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

describe("failed Gemini document observation", () => {
  it("records a unique exact failed document between two pending operation reads without exposing names", async () => {
    const { sdk, calls } = client();
    const before = Date.now();
    const result = await observeFailedGeminiDocument(target, SECRET, sdk);
    expect(result).toEqual({ documentReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), operationReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), observedAt: expect.any(Number) });
    expect(result!.observedAt).toBeGreaterThanOrEqual(before);
    expect(result!.observedAt).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(result)).not.toContain(DOCUMENT);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(calls).toEqual(["operation", "list", "document", "operation"]);
  });

  it.each(["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const)("requires exact %s in list and direct GET", async key => {
    for (const direct of [false, true]) {
      const { sdk } = client(direct ? undefined : [[document({ customMetadata: metadata({ [key]: "wrong" }) })]]);
      if (direct) sdk.fileSearchStores.documents.get.mockResolvedValue(document({ customMetadata: metadata({ [key]: "wrong" }) }));
      expect(await observeFailedGeminiDocument(target, SECRET, sdk)).toBeNull();
    }
  });

  it.each(["STATE_PENDING", "STATE_ACTIVE", "STATE_UNSPECIFIED", undefined, "unknown"])("does not infer failure from %s in either response", async state => {
    for (const direct of [false, true]) {
      const { sdk } = client(direct ? undefined : [[document({ state })]]);
      if (direct) sdk.fileSearchStores.documents.get.mockResolvedValue(document({ state }));
      expect(await observeFailedGeminiDocument(target, SECRET, sdk)).toBeNull();
    }
  });

  it.each([DOCUMENT, `${STORE}/documents/second-match`])("rejects duplicate matching rows (%s)", async name => {
    const { sdk } = client([[document()], [document({ name })]]);
    expect(await observeFailedGeminiDocument(target, SECRET, sdk)).toBeNull();
    expect(sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it("rejects malformed metadata and incomplete scans", async () => {
    const duplicate = client([[document({ customMetadata: [...metadata(), { key: "version_id", stringValue: target.metadata.version_id }] })]]);
    expect(await observeFailedGeminiDocument(target, SECRET, duplicate.sdk)).toBeNull();
    const incomplete = client(Array.from({ length: 21 }, (_, index) => index === 0 ? [document()] : []));
    expect(await observeFailedGeminiDocument(target, SECRET, incomplete.sdk)).toBeNull();
    expect(incomplete.pager.nextPage).toHaveBeenCalledTimes(19);
    expect(incomplete.sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
  });

  it.each([null, {}, { name: OPERATION, done: true }, { name: OPERATION, done: false, error: { code: 13 } }, { name: OPERATION, response: {} }, { name: OPERATION, done: "false" }])("rejects nonpending or malformed operation %j", async operation => {
    for (const finalRead of [false, true]) {
      const { sdk } = client();
      if (finalRead) sdk.operations.get.mockResolvedValueOnce({ name: OPERATION, done: false });
      sdk.operations.get.mockResolvedValueOnce(operation);
      expect(await observeFailedGeminiDocument(target, SECRET, sdk)).toBeNull();
    }
  });

  it("fails closed without leaking thrown credentials", async () => {
    const { sdk } = client();
    sdk.fileSearchStores.documents.get.mockRejectedValue(new Error(SECRET));
    expect(await observeFailedGeminiDocument(target, SECRET, sdk)).toBeNull();
  });

  it("accepts omitted operation done as the pending default", async () => {
    const { sdk } = client();
    sdk.operations.get.mockResolvedValue({ name: OPERATION });
    expect(await observeFailedGeminiDocument(target, SECRET, sdk)).not.toBeNull();
  });
});

describe("completed Gemini document proof", () => {
  it("requires an active unique document and the exact completed operation on both sides", async () => {
    const { sdk, calls } = client([[document({ state: "STATE_ACTIVE" })]]);
    sdk.fileSearchStores.documents.get.mockImplementation(async () => { calls.push("document"); return document({ state: "STATE_ACTIVE" }); });
    sdk.operations.get.mockImplementation(async () => { calls.push("operation"); return { name: OPERATION, done: true, response: { documentName: DOCUMENT } }; });
    await expect(verifyCompletedGeminiDocument(target, DOCUMENT, SECRET, sdk)).resolves.toBeUndefined();
    expect(calls).toEqual(["operation", "list", "document", "operation"]);
  });

  it.each(["STATE_FAILED", "STATE_PENDING", undefined])("does not publish a terminal operation's %s document", async state => {
    const { sdk } = client([[document({ state })]]);
    sdk.fileSearchStores.documents.get.mockResolvedValue(document({ state }));
    sdk.operations.get.mockResolvedValue({ name: OPERATION, done: true, response: { documentName: DOCUMENT } });
    await expect(verifyCompletedGeminiDocument(target, DOCUMENT, SECRET, sdk)).rejects.toThrow("GEMINI_COMPLETED_DOCUMENT_PROOF_FAILED");
  });
});
