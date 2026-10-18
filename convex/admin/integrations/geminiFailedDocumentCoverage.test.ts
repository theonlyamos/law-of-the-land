import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyFailedGeminiDocumentCoverage, type FailedDocumentCoverageInput } from "./geminiFailedDocumentCoverage";
import type { GeminiDiagnosticClient } from "./geminiDiagnostic";

const STORE = "fileSearchStores/coverage-test";
const OPERATION = `${STORE}/upload/operations/failed`;
const FAILED = `${STORE}/documents/failed`;
const ACTIVE = `${STORE}/documents/published`;
const SECRET = "synthetic-provider-secret";
const metadata = (version: string) => ({ environment: "test", jurisdiction_id: "jurisdiction", resource_id: `resource-${version}`,
  version_id: version, version_number: "1", sha256: (version === "failed" ? "a" : "b").repeat(64) });
const input: FailedDocumentCoverageInput = {
  target: { storeName: STORE, operationName: OPERATION, metadata: metadata("failed") },
  published: [{ documentName: ACTIVE, metadata: metadata("published") }], excluded: [],
};
const row = (name: string, state: string, value = metadata(name === FAILED ? "failed" : "published")) =>
  ({ name, state, customMetadata: Object.entries(value).map(([key, stringValue]) => ({ key, stringValue })) });
function client(scans: unknown[][][] = [[[row(FAILED, "STATE_FAILED"), row(ACTIVE, "STATE_ACTIVE")]]]) {
  let scan = 0;
  const sdk = {
    operations: { get: vi.fn(async () => ({ name: OPERATION, done: false })) },
    fileSearchStores: { documents: {
      list: vi.fn(async () => {
        const pages = scans[Math.min(scan++, scans.length - 1)]; let page = 0;
        return { get page() { return pages[page]; }, hasNextPage: () => page + 1 < pages.length,
          nextPage: async () => pages[++page] };
      }),
      get: vi.fn(async ({ name }: { name: string }) => row(name, name === FAILED ? "STATE_FAILED" : "STATE_ACTIVE")),
    } },
  } satisfies GeminiDiagnosticClient;
  return sdk;
}
afterEach(() => vi.restoreAllMocks());
describe("failed document and published coverage proof", () => {
  it("confirms failed exclusion twice without trusting operation completion", async () => {
    const sdk = client(); const before = Date.now();
    const proof = await verifyFailedGeminiDocumentCoverage(input, SECRET, sdk);
    expect(proof).toMatchObject({ documentReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      operationReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), publishedCount: 1 });
    expect(proof.firstObservedAt).toBeGreaterThanOrEqual(before);
    expect(proof.confirmedAt).toBeGreaterThanOrEqual(proof.firstObservedAt);
    expect(proof.coverageVerifiedAt).toBe(proof.confirmedAt);
    expect(sdk.fileSearchStores.documents.list).toHaveBeenCalledTimes(2);
    expect(sdk.fileSearchStores.documents.get).toHaveBeenCalledTimes(4);
    expect(sdk.operations.get).toHaveBeenCalledTimes(3);
  });
  it.each(["STATE_ACTIVE", "STATE_PENDING", "STATE_UNSPECIFIED", "unknown"])("refuses failed target observed as %s", async state => {
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, client([[[row(FAILED, state), row(ACTIVE, "STATE_ACTIVE")]]])))
      .rejects.toThrow("GEMINI_FAILED_DOCUMENT_PROOF_FAILED");
  });
  it.each(["missing", "duplicate", "extra active", "extra failed", "foreign", "pending"])("refuses incomplete or unsafe inventory: %s", async kind => {
    const rows: unknown[] = [row(FAILED, "STATE_FAILED"), row(ACTIVE, "STATE_ACTIVE")];
    if (kind === "missing") rows.pop();
    if (kind === "duplicate") rows.push(row(ACTIVE, "STATE_ACTIVE"));
    if (kind.startsWith("extra")) rows.push(row(`${STORE}/documents/extra`, kind === "extra active" ? "STATE_ACTIVE" : "STATE_FAILED", metadata("extra")));
    if (kind === "foreign") rows.push(row("fileSearchStores/other/documents/foreign", "STATE_ACTIVE"));
    if (kind === "pending") rows[1] = row(ACTIVE, "STATE_PENDING");
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, client([[rows]]))).rejects.toThrow("GEMINI_FAILED_DOCUMENT_PROOF_FAILED");
  });
  it("requires the same document identities in both complete scans", async () => {
    const sdk = client([[[row(FAILED, "STATE_FAILED"), row(ACTIVE, "STATE_ACTIVE")]],
      [[row(`${STORE}/documents/replaced`, "STATE_FAILED", metadata("failed")), row(ACTIVE, "STATE_ACTIVE")]]]);
    sdk.fileSearchStores.documents.get.mockImplementation(async ({ name }) => row(name, name === ACTIVE ? "STATE_ACTIVE" : "STATE_FAILED", metadata(name === ACTIVE ? "published" : "failed")));
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, sdk)).rejects.toThrow("GEMINI_FAILED_DOCUMENT_PROOF_FAILED");
  });
  it("rechecks published state and metadata by direct GET", async () => {
    const sdk = client(); sdk.fileSearchStores.documents.get.mockImplementation(async ({ name }) => row(name, "STATE_FAILED"));
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, sdk)).rejects.toThrow("GEMINI_FAILED_DOCUMENT_PROOF_FAILED");
  });
  it("refuses a target that becomes active on confirmation", async () => {
    const sdk = client(); let reads = 0;
    sdk.fileSearchStores.documents.get.mockImplementation(async ({ name }) => row(name, name === ACTIVE ? "STATE_ACTIVE" : ++reads === 1 ? "STATE_FAILED" : "STATE_ACTIVE"));
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, sdk)).rejects.toThrow("GEMINI_FAILED_DOCUMENT_PROOF_FAILED");
  });
  it("rejects an incomplete twenty-page inventory", async () => {
    await expect(verifyFailedGeminiDocumentCoverage(input, SECRET, client([Array.from({ length: 21 }, (_, i) => i ? [] : [row(FAILED, "STATE_FAILED"), row(ACTIVE, "STATE_ACTIVE")])]))).rejects.toThrow();
  });
  it("permits only explicitly bound failed extras", async () => {
    const extra = `${STORE}/documents/excluded`; const sdk = client([[[row(FAILED, "STATE_FAILED"), row(ACTIVE, "STATE_ACTIVE"), row(extra, "STATE_FAILED", metadata("extra"))]]]);
    sdk.fileSearchStores.documents.get.mockImplementation(async ({ name }) => row(name, name === ACTIVE ? "STATE_ACTIVE" : "STATE_FAILED", metadata(name === ACTIVE ? "published" : name === FAILED ? "failed" : "extra")));
    expect((await verifyFailedGeminiDocumentCoverage({ ...input, excluded: [{ metadata: metadata("extra") }] }, SECRET, sdk)).publishedCount).toBe(1);
  });
  it("never retains provider exceptions or credentials", async () => {
    const sdk = client(); sdk.operations.get.mockRejectedValueOnce(new Error(`Authorization ${SECRET}`));
    try { await verifyFailedGeminiDocumentCoverage(input, SECRET, sdk); expect.unreachable(); }
    catch (error) { expect(String(error)).toBe("Error: GEMINI_FAILED_DOCUMENT_PROOF_FAILED"); expect(Object.keys(error as object)).toEqual([]); }
  });
});
