import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintFile, normalizeBatchIdentity, parseBatchManifest } from "./batch-import";

const entry = {
  filename: "judgment.pdf", title: "Mensah v Mensah", issuer: "Supreme Court of Ghana",
  officialCitation: "[2012] GHASC 1", sourceUrl: "https://law-firm.example/judgment.pdf",
  topics: ["marital property"], effectiveDate: "2012-02-22",
  sourceProvenance: "Court-text reproduction hosted by a law firm; authentication evidence remains for human review.",
  caseAliases: ["Civil Appeal J4/20/2011"],
};
const manifest = (documents: unknown[] = [entry]) => JSON.stringify({ version: 1, jurisdictionId: "ghana-id", documents });

afterEach(() => vi.unstubAllGlobals());

describe("batch manifests", () => {
  it("preserves actual source provenance without deriving approval assertions", () => {
    expect(parseBatchManifest(manifest()).documents[0]).toEqual(entry);
    expect(parseBatchManifest(manifest([{ ...entry, caseAliases: undefined }])).documents[0].caseAliases).toEqual([]);
  });

  it("requires complete metadata and rejects unsupported review or unknown fields", () => {
    for (const invalid of [
      { ...entry, sourceProvenance: "  " }, { ...entry, title: "" },
      { ...entry, filename: "../judgment.pdf" }, { ...entry, filename: "judgment.docx" },
      { ...entry, sourceUrl: "http://court.example/judgment.pdf" },
      { ...entry, sourceUrl: "https://user:password@court.example/judgment.pdf" },
      { ...entry, effectiveDate: "2025-02-29" }, { ...entry, effectiveDate: "2024-13-01" },
      { ...entry, reviewed: true }, { ...entry, officialCitation: "..." },
    ]) expect(() => parseBatchManifest(manifest([invalid]))).toThrow();
    expect(() => parseBatchManifest("not json")).toThrow("valid JSON");
  });

  it("accepts leap days and enforces document, field and topic bounds", () => {
    expect(parseBatchManifest(manifest([{ ...entry, effectiveDate: "2024-02-29" }])).documents).toHaveLength(1);
    expect(() => parseBatchManifest(manifest([]))).toThrow();
    expect(() => parseBatchManifest(manifest(Array(101).fill(entry)))).toThrow();
    expect(() => parseBatchManifest(manifest([{ ...entry, title: "a".repeat(301) }]))).toThrow();
    expect(() => parseBatchManifest(manifest([{ ...entry, topics: Array(9).fill("tax") }]))).toThrow();
    expect(() => parseBatchManifest(manifest([{ ...entry, topics: ["x".repeat(81)] }]))).toThrow();
  });

  it("fails closed on duplicate filenames and citation aliases across documents", () => {
    expect(normalizeBatchIdentity("  ［２０１２］ GHASC-1 ")).toBe("2012ghasc1");
    expect(normalizeBatchIdentity("Mensah versus Mensah")).toBe(normalizeBatchIdentity("Mensah v. Mensah"));
    const other = { ...entry, filename: "other.pdf", officialCitation: "[2013] GHASC 2", caseAliases: [] };
    expect(() => parseBatchManifest(manifest([entry, { ...other, filename: "JUDGMENT.PDF" }]))).toThrow("Duplicate PDF filename");
    expect(() => parseBatchManifest(manifest([entry, { ...other, officialCitation: "2012-GHASC-1" }]))).toThrow("overlaps document 1");
    expect(() => parseBatchManifest(manifest([entry, { ...other, caseAliases: ["civil appeal j4 20 2011"] }]))).toThrow("overlaps document 1");
    expect(parseBatchManifest(manifest([entry, other])).documents).toHaveLength(2);
  });
});

describe("PDF fingerprints", () => {
  it("hashes exact original bytes and permits browsers without a PDF MIME", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const file = new File(["%PDF-1.7\noriginal court text"], "judgment.pdf");
    const result = await fingerprintFile(file, 1000);
    expect(result.byteSize).toBe(file.size);
    const digest = await webcrypto.subtle.digest("SHA-256", await file.arrayBuffer());
    expect(result.sha256).toBe(Buffer.from(digest).toString("hex"));
  });

  it("rejects empty, oversize, disguised, mismatched MIME and invalid-policy files", async () => {
    const pdf = new File(["%PDF-1.7"], "judgment.pdf", { type: "application/pdf" });
    await expect(fingerprintFile(pdf, 0)).rejects.toThrow("not configured");
    await expect(fingerprintFile(pdf, 2)).rejects.toThrow("smaller");
    await expect(fingerprintFile(new File([], "empty.pdf"), 100)).rejects.toThrow("empty");
    await expect(fingerprintFile(new File(["<html>"], "fake.pdf"), 100)).rejects.toThrow("PDF header");
    await expect(fingerprintFile(new File(["%PDF-1.7"], "fake.pdf", { type: "text/html" }), 100)).rejects.toThrow("supported");
  });
});
