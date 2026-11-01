import { expect, it, vi } from "vitest";
import { verifyCompletedGeminiDocument, observeFailedGeminiDocument } from "./geminiFailedDocumentObservation";
import { verifyActiveGeminiDocument } from "./geminiActiveDocument";
import { verifyFailedGeminiDocumentCoverage } from "./geminiFailedDocumentCoverage";
import { inspectGeminiProvider, type DiagnosticTarget, type GeminiDiagnosticClient } from "./geminiDiagnostic";

const storeName = "fileSearchStores/capacity-proof", operationName = `${storeName}/upload/operations/retained`;
const metadata = (index: number) => ({ environment: "test", jurisdiction_id: "ghana", resource_id: `resource-${index}`,
  version_id: `version-${index}`, version_number: "1", sha256: "a".repeat(64) });
function inventory(count: number, failed = false, completed = false) {
  const target: DiagnosticTarget = { storeName, operationName, metadata: metadata(count - 1) };
  const rows = Array.from({ length: count }, (_, index) => ({ name: `${storeName}/documents/doc${index}`,
    state: failed && index === count - 1 ? "STATE_FAILED" : "STATE_ACTIVE",
    customMetadata: Object.entries(metadata(index)).map(([key, stringValue]) => ({ key, stringValue })) }));
  const pages = Array.from({ length: Math.ceil(count / 20) }, (_, index) => rows.slice(index * 20, index * 20 + 20));
  const sdk = {
    operations: { get: vi.fn(async () => completed ? { name: operationName, done: true, response: { documentName: rows[count - 1].name } } : { name: operationName, done: false }) },
    fileSearchStores: { documents: {
      list: vi.fn(async () => { let index = 0; return { get page() { return pages[index]; },
        hasNextPage: () => index + 1 < pages.length, nextPage: vi.fn(async () => pages[++index]) }; }),
      get: vi.fn(async ({ name }: { name: string }) => rows.find(row => row.name === name)),
    } },
  } satisfies GeminiDiagnosticClient;
  return { target, rows, pages, sdk, coverage: { target, published: rows.slice(0, -1).map((row, index) => ({ documentName: row.name, metadata: metadata(index) })), excluded: [] } };
}

it.each([401, 900])("proves a completed upload after scanning all %i documents", async count => {
  const f = inventory(count, false, true);
  await expect(verifyCompletedGeminiDocument(f.target, f.rows[count - 1].name, "test-key", f.sdk)).resolves.toBeUndefined();
  expect(f.sdk.fileSearchStores.documents.get).toHaveBeenCalledTimes(1);
  expect(f.sdk.operations.get).toHaveBeenCalledTimes(2);
});
it.each([401, 900])("proves a pending-operation active target after all %i documents", async count => {
  const f = inventory(count);
  await expect(verifyActiveGeminiDocument(f.target, "test-key", f.sdk)).resolves.toBeDefined();
});
it.each([401, 900])("observes a failed target after all %i documents without publishing it", async count => {
  const f = inventory(count, true);
  expect(await observeFailedGeminiDocument(f.target, "test-key", f.sdk)).not.toBeNull();
});
it.each([401, 900])("proves complete failed-document coverage twice for %i documents", async count => {
  const f = inventory(count, true);
  expect(await verifyFailedGeminiDocumentCoverage(f.coverage, "test-key", f.sdk)).toMatchObject({ publishedCount: count - 1 });
  expect(f.sdk.fileSearchStores.documents.list).toHaveBeenCalledTimes(2);
  expect(f.sdk.fileSearchStores.documents.get).toHaveBeenCalledTimes(count * 2);
});
it.each([401, 900])("diagnoses the complete %i-document inventory", async count => {
  const f = inventory(count, true);
  expect((await inspectGeminiProvider(f.target, "test-key", f.sdk)).documents).toMatchObject({
    scanComplete: true, pagesScanned: Math.ceil(count / 20), documentsScanned: count, matchingCount: 1, duplicateMatches: false,
  });
});

const proofModes = ["completed", "active", "failed", "coverage"] as const;
type ProofMode = typeof proofModes[number];
function proofFixture(count: number, mode: ProofMode) { return inventory(count, mode === "failed" || mode === "coverage", mode === "completed"); }
async function prove(f: ReturnType<typeof inventory>, mode: ProofMode) {
  if (mode === "completed") return verifyCompletedGeminiDocument(f.target, f.rows[f.rows.length - 1]!.name, "test-key", f.sdk);
  if (mode === "active") return verifyActiveGeminiDocument(f.target, "test-key", f.sdk);
  if (mode === "coverage") return verifyFailedGeminiDocumentCoverage(f.coverage, "test-key", f.sdk);
  if (await observeFailedGeminiDocument(f.target, "test-key", f.sdk) === null) throw new Error("FAILED_OBSERVATION_NOT_PROVED");
}
it.each(proofModes)("retains exact 2048-document bound for %s proof", async mode => {
  const f = proofFixture(2048, mode);
  await expect(prove(f, mode)).resolves.not.toThrow();
});
it.each(proofModes)("rejects a 2049-document inventory rather than truncating %s proof", async mode => {
  const f = proofFixture(2049, mode);
  await expect(prove(f, mode)).rejects.toThrow();
});
it.each(proofModes.flatMap(mode => ["late duplicate identity", "late duplicate name", "late wrong hash", "late wrong state", "later page failure", "endless empty pages"]
  .map(fault => ({ mode, fault }))))("fails closed for $fault in large $mode inventory", async ({ mode, fault }) => {
  const f = proofFixture(900, mode);
  if (fault === "late duplicate identity") f.rows[800].customMetadata = f.rows[899].customMetadata;
  if (fault === "late duplicate name") f.rows[800].name = f.rows[799].name;
  if (fault === "late wrong hash") f.rows[899].customMetadata = f.rows[899].customMetadata.map(entry => entry.key === "sha256" ? { ...entry, stringValue: "b".repeat(64) } : entry);
  if (fault === "late wrong state") f.rows[899].state = "STATE_PENDING";
  if (fault === "later page failure") {
    f.sdk.fileSearchStores.documents.list.mockImplementation(async () => { let page = 0; return {
      get page() { return f.pages[page]; }, hasNextPage: () => true,
      nextPage: vi.fn(async () => { if (++page === 30) throw new Error("synthetic-private-provider-error"); return f.pages[page]; }),
    }; });
  }
  if (fault === "endless empty pages") f.sdk.fileSearchStores.documents.list.mockImplementation(async () => ({
    page: [], hasNextPage: () => true, nextPage: vi.fn(async () => []),
  }));
  await expect(prove(f, mode)).rejects.toThrow();
});
it("does not accept an early target when another exact match appears after page20", async () => {
  const f = inventory(900, false, true);
  f.rows[0].customMetadata = f.rows[899].customMetadata;
  await expect(prove(f, "completed")).rejects.toThrow();
  expect(f.sdk.fileSearchStores.documents.get).not.toHaveBeenCalled();
});
it("reports incomplete diagnostics at the document budget without scanning unbounded rows", async () => {
  const f = inventory(2049, true);
  expect((await inspectGeminiProvider(f.target, "test-key", f.sdk)).documents).toMatchObject({ scanComplete: false, documentsScanned: 2048, scanLimit: "documents" });
});
it("reports a second matching identity appearing after page20 without treating it as authority", async () => {
  const f = inventory(900, true);
  f.rows[800].customMetadata = f.rows[899].customMetadata;
  expect((await inspectGeminiProvider(f.target, "test-key", f.sdk)).documents).toMatchObject({ scanComplete: true, documentsScanned: 900, matchingCount: 2, duplicateMatches: true });
});
it.each(proofModes)("rejects oversized provider pages in %s proof", async mode => {
  const f = proofFixture(21, mode);
  f.pages.splice(0, f.pages.length, f.rows);
  await expect(prove(f, mode)).rejects.toThrow();
});
it("does not misreport completeness for malformed provider continuation flags", async () => {
  const f = inventory(1, true);
  f.sdk.fileSearchStores.documents.list.mockImplementation(async () => ({ page: f.rows,
    hasNextPage: () => "false" as unknown as boolean, nextPage: vi.fn(async () => []),
  }));
  expect((await inspectGeminiProvider(f.target, "test-key", f.sdk)).documents.scanComplete).toBe(false);
});
