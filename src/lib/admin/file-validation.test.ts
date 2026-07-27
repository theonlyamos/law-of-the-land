import { describe, expect, it } from "vitest";
import {
  ADMIN_DOCUMENT_DEFAULT_MAX_BYTES,
  computeFileSha256,
  validateDocumentFile,
} from "./file-validation";

describe("document file validation", () => {
  it("rejects an extension and MIME pair that GroundX does not support", () => {
    expect(
      validateDocumentFile({
        name: "law.exe",
        type: "application/octet-stream",
        size: 10,
      }),
    ).toEqual({ ok: false, reason: "Unsupported file type" });
  });

  it("rejects a supported file larger than the configured limit", () => {
    expect(
      validateDocumentFile(
        { name: "law.pdf", type: "application/pdf", size: 101 },
        100,
      ),
    ).toEqual({ ok: false, reason: "File is too large" });
  });

  it("accepts the GroundX SDK file types only when extension and MIME agree", () => {
    const validFiles = [
      ["law.txt", "text/plain"],
      ["law.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["law.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["law.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["law.pdf", "application/pdf"],
      ["law.png", "image/png"],
      ["law.jpg", "image/jpeg"],
      ["law.csv", "text/csv"],
      ["law.tsv", "text/tab-separated-values"],
      ["law.json", "application/json"],
    ] as const;

    for (const [name, type] of validFiles) {
      expect(validateDocumentFile({ name, type, size: 1 })).toEqual({ ok: true });
    }
    expect(
      validateDocumentFile({ name: "law.pdf", type: "image/png", size: 1 }),
    ).toEqual({ ok: false, reason: "Unsupported file type" });
    expect(
      validateDocumentFile({
        name: "law.pdf",
        type: "application/pdf",
        size: ADMIN_DOCUMENT_DEFAULT_MAX_BYTES + 1,
      }),
    ).toEqual({ ok: false, reason: "File is too large" });
  });

  it("computes a lowercase Web Crypto SHA-256 digest of the file bytes", async () => {
    const file = new File(["abc"], "law.txt", { type: "text/plain" });
    await expect(computeFileSha256(file)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
