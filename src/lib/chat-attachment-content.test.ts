// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { PDFDocument, PDFName, PDFPageTree } from "pdf-lib";
import { strToU8, zipSync } from "fflate";
import { validateChatAttachment } from "../../shared/chat-attachment-content";
import { MAX_CHAT_FILE_BYTES, validateChatAttachmentSelection } from "../../shared/chat-attachments";

const docx = (xml: string, extra: Record<string, Uint8Array> = {}) => zipSync({
  "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  "word/document.xml": strToU8(xml), ...extra,
});
const documentXml = (content: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`;
async function pdfWithMetadata(padding: number[], arrayFilter = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.addPage();
  for (const [index, size] of padding.entries()) {
    const header = `${500 + index} 0 `;
    const stream = pdf.context.flateStream(strToU8(`${header}${" ".repeat(size)}<< /Synthetic true >>`), {
      Type: "ObjStm", N: 1, First: header.length,
    });
    if (arrayFilter) stream.dict.set(PDFName.of("Filter"), pdf.context.obj(["FlateDecode"]));
    pdf.context.register(stream);
  }
  return pdf.save({ useObjectStreams: false });
}
const pngFixture = () => Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
const jpegFixture = () => Uint8Array.from(Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z", "base64"));
const webpFixture = () => Uint8Array.from(Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=", "base64"));

describe("chat attachment content", () => {
  it("normalizes missing browser MIME and preserves UTF-8 text", async () => {
    await expect(validateChatAttachment(strToU8("Rent: GH₵ 900\nQuestion: repairs?"), "notes.TXT", "")).resolves.toMatchObject({
      kind: "text", mimeType: "text/plain", extractedText: "Rent: GH₵ 900\nQuestion: repairs?",
    });
    expect(validateChatAttachmentSelection({ name: "receipt.jpeg", type: "image/jpeg", size: 20 })).toBeNull();
    expect(validateChatAttachmentSelection({ name: "notes.md", type: "text/plain", size: 20 })).toBeNull();
  });

  it("rejects spoofed types, binary text, empty files and oversized files", async () => {
    await expect(validateChatAttachment(strToU8("not a PDF"), "law.pdf", "application/pdf")).rejects.toThrow();
    await expect(validateChatAttachment(new Uint8Array([0, 255, 2]), "notes.txt", "text/plain")).rejects.toThrow();
    await expect(validateChatAttachment(new Uint8Array(), "notes.txt", "text/plain")).rejects.toThrow();
    expect(validateChatAttachmentSelection({ name: "notes.txt", type: "image/png", size: 20 })).toMatch(/Choose/);
    expect(validateChatAttachmentSelection({ name: "notes.txt", type: "text/plain", size: MAX_CHAT_FILE_BYTES + 1 })).toMatch(/10 MB/);
  });

  it("extracts paragraphs and table cells from DOCX without running markup", async () => {
    const bytes = docx(documentXml('<w:p><w:r><w:t>Rent &amp; repairs</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Deposit</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>900</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
    const result = await validateChatAttachment(bytes, "agreement.docx", "application/octet-stream");
    expect(result).toMatchObject({ kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(result.extractedText).toContain("Rent & repairs");
    expect(result.extractedText).toContain("Deposit");
    expect(result.extractedText).toContain("900");
    expect(result.extractedText).not.toContain("<w:");
  });

  it("rejects non-DOCX archives, entity declarations and malformed XML", async () => {
    await expect(validateChatAttachment(zipSync({ "notes.txt": strToU8("hello") }), "fake.docx", "")).rejects.toThrow();
    await expect(validateChatAttachment(docx('<!DOCTYPE foo [<!ENTITY bad SYSTEM "file:///etc/passwd">]>' + documentXml('<w:p><w:r><w:t>&bad;</w:t></w:r></w:p>')), "bad.docx", "")).rejects.toThrow();
    await expect(validateChatAttachment(docx(documentXml("<w:p><w:t>broken</w:p>")), "bad.docx", "")).rejects.toThrow();
  });

  it("rejects oversized expanded document text rather than truncating it", async () => {
    await expect(validateChatAttachment(docx(documentXml(`<w:p><w:r><w:t>${"x".repeat(100_001)}</w:t></w:r></w:p>`)), "large.docx", "")).rejects.toThrow(/100,000/);
    await expect(validateChatAttachment(strToU8("x".repeat(100_001)), "large.txt", "text/plain")).rejects.toThrow(/100,000/);
    await expect(validateChatAttachment(docx(documentXml(`<w:p><w:r><w:t>${"x".repeat(2_100_000)}</w:t></w:r></w:p>`)), "bomb.docx", "")).rejects.toThrow();
  });

  it("loads real PDFs and rejects excessive pages and corrupt PDFs", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = await pdf.save();
    await expect(validateChatAttachment(bytes, "agreement.pdf", "application/pdf")).resolves.toMatchObject({ kind: "document", pageCount: 1 });
    for (let count = 1; count < 101; count++) pdf.addPage();
    await expect(validateChatAttachment(await pdf.save(), "long.pdf", "")).rejects.toThrow(/100 pages/);
    await expect(validateChatAttachment(strToU8("%PDF-1.7\ninvalid"), "broken.pdf", "")).rejects.toThrow();
  });

  it("bounds expanded PDF metadata before pdf-lib can allocate an unbounded object stream", async () => {
    const bytes = await pdfWithMetadata([9 * 1024 * 1024]);
    expect(bytes.length).toBeLessThan(20_000);
    await expect(validateChatAttachment(bytes, "expanded.pdf", "application/pdf")).rejects.toThrow(/expanded|complex/);
  });

  it("applies the PDF expansion budget across streams, including array filter syntax", async () => {
    const bytes = await pdfWithMetadata([5 * 1024 * 1024, 5 * 1024 * 1024], true);
    await expect(validateChatAttachment(bytes, "cumulative.pdf", "application/pdf")).rejects.toThrow(/expanded|complex/);
  });

  it("accepts ordinary compressed PDFs and keeps concurrent document budgets independent", async () => {
    const bytes = await pdfWithMetadata([5 * 1024 * 1024], true);
    await expect(Promise.all([1, 2].map(() => validateChatAttachment(bytes, "compressed.pdf", "application/pdf"))))
      .resolves.toEqual([{ kind: "document", mimeType: "application/pdf", pageCount: 1 }, { kind: "document", mimeType: "application/pdf", pageCount: 1 }]);
  });

  it.each([
    { Type: "ObjStm", N: 20_001, First: 0 },
    { Type: "ObjStm", N: 1, First: 9 * 1024 * 1024 },
    { Type: "XRef", Size: 20_001, W: [1, 4, 2] },
    { Type: "XRef", Size: 1, W: [1_000_000, 0, 0] },
    { Type: "XRef", Size: 1, W: [1, 1] },
    { Type: "XRef", Size: 1, W: [1, 4, 2], Index: [0, 20_001] },
    { Type: "XRef", Size: 10_000, W: [1, 1, 1], Index: [0, 10_000, 0, 10_000, 0, 10_000] },
    { Type: "XRef", Size: 10, W: [1, 4, 2] },
  ])("rejects count-driven PDF metadata work before parsing entries (%#)", async metadata => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.context.register(pdf.context.flateStream(strToU8("x"), metadata));
    await expect(validateChatAttachment(await pdf.save({ useObjectStreams: false }), "counts.pdf", "application/pdf")).rejects.toThrow(/complex/);
  });

  it.each([
    ["500 0 501 0 ", "(Repeated payload)", 2],
    ["500 0 500 10 ", "(First)    (Second)", 2],
    ["500 0 501 1 ", "(Overlapping payload)", 2],
    ["0 ".repeat(100_000), "(Tiny declared object count)", 1],
    ["500 0 ", `${"[".repeat(70)}0${"]".repeat(70)}`, 1],
    ["500 0 ", `[${"0 ".repeat(100_001)}]`, 1],
  ] as const)("rejects aliased, overlapping, or excessively nested compressed PDF objects (%#)", async (header, content, count) => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.context.register(pdf.context.flateStream(strToU8(header + content), { Type: "ObjStm", N: count, First: header.length }));
    await expect(validateChatAttachment(await pdf.save({ useObjectStreams: false }), "objects.pdf", "application/pdf")).rejects.toThrow(/complex/);
  });

  it("validates escaped PDF structural names and rejects unsupported metadata filters clearly", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.context.register(pdf.context.flateStream(strToU8("x"), { Type: "ObjStm", N: 20_001, First: 0 }));
    const escaped = Buffer.from(await pdf.save({ useObjectStreams: false })).toString("latin1").replace("/ObjStm", "/Obj#53tm");
    await expect(validateChatAttachment(Buffer.from(escaped, "latin1"), "escaped.pdf", "application/pdf")).rejects.toThrow(/complex/);
    const unsupported = await PDFDocument.create(); unsupported.addPage();
    unsupported.context.register(unsupported.context.stream(strToU8("abc"), { Type: "ObjStm", N: 0, First: 0, Filter: "LZWDecode" }));
    await expect(validateChatAttachment(await unsupported.save({ useObjectStreams: false }), "rare.pdf", "application/pdf")).rejects.toThrow(/unsupported structural compression/);
  });

  it("bounds parsed objects across compressed streams and ordinary PDF objects", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    for (let index = 0; index < 3; index++) {
      const header = `${500 + index} 0 `;
      pdf.context.register(pdf.context.flateStream(strToU8(`${header}[${"0 ".repeat(40_000)}]`), { Type: "ObjStm", N: 1, First: header.length }));
    }
    const bytes = await pdf.save({ useObjectStreams: false });
    expect(bytes.length).toBeLessThan(10_000);
    await expect(validateChatAttachment(bytes, "many-objects.pdf", "application/pdf")).rejects.toThrow(/complex/);
    const plain = await PDFDocument.create(); plain.addPage();
    plain.context.register(plain.context.obj(Array.from({ length: 100_001 }, () => 0)));
    await expect(validateChatAttachment(await plain.save({ useObjectStreams: false }), "plain-objects.pdf", "application/pdf")).rejects.toThrow(/complex/);
  });

  it("rejects cyclic and excessively deep PDF page trees", async () => {
    const cyclic = await PDFDocument.create(); cyclic.addPage();
    cyclic.catalog.Pages().Kids().push(cyclic.catalog.get(PDFName.of("Pages"))!);
    await expect(validateChatAttachment(await cyclic.save({ useObjectStreams: false }), "cycle.pdf", "application/pdf")).rejects.toThrow(/page structure/);
    const deep = await PDFDocument.create(); deep.addPage();
    let parent = deep.catalog.Pages();
    for (let index = 0; index < 66; index++) {
      const child = PDFPageTree.withContext(deep.context);
      parent.Kids().push(deep.context.register(child)); parent = child;
    }
    await expect(validateChatAttachment(await deep.save({ useObjectStreams: false }), "deep.pdf", "application/pdf")).rejects.toThrow(/page structure/);
  });

  it("continues to reject encrypted PDF attachments", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: "Standard", V: 1 }));
    await expect(validateChatAttachment(await pdf.save({ useObjectStreams: false }), "protected.pdf", "application/pdf")).rejects.toThrow(/password/);
  });

  it("accepts a PNG and rejects truncated or mismatched image content", async () => {
    const png = pngFixture();
    await expect(validateChatAttachment(png, "receipt.png", "image/png")).resolves.toMatchObject({ kind: "image", mimeType: "image/png" });
    await expect(validateChatAttachment(png.subarray(0, 26), "receipt.png", "image/png")).rejects.toThrow();
    await expect(validateChatAttachment(png, "receipt.jpg", "image/jpeg")).rejects.toThrow();
  });

  it("rejects corrupted PNG chunks before marking the attachment ready", async () => {
    const png = pngFixture();
    png[64] ^= 255; // Corrupt the IDAT payload while retaining dimensions and chunk lengths.
    await expect(validateChatAttachment(png, "corrupt.png", "image/png")).rejects.toThrow(/damaged/);
  });

  it("requires actual JPEG scan data after a valid frame header", async () => {
    const jpeg = jpegFixture();
    await expect(validateChatAttachment(jpeg, "photo.jpg", "image/jpeg")).resolves.toMatchObject({ kind: "image" });
    const scan = jpeg.findIndex((value, index) => value === 255 && jpeg[index + 1] === 218);
    const missingScan = new Uint8Array(scan + 2);
    missingScan.set(jpeg.subarray(0, scan));
    missingScan.set([255, 217], scan);
    await expect(validateChatAttachment(missingScan, "empty.jpg", "image/jpeg")).rejects.toThrow(/damaged/);
  });

  it("requires WebP image payload in addition to a RIFF or extended header", async () => {
    await expect(validateChatAttachment(webpFixture(), "photo.webp", "image/webp")).resolves.toMatchObject({ kind: "image" });
    const headerOnly = new Uint8Array(30);
    headerOnly.set(strToU8("RIFF"));
    new DataView(headerOnly.buffer).setUint32(4, 22, true);
    headerOnly.set(strToU8("WEBPVP8X"), 8);
    new DataView(headerOnly.buffer).setUint32(16, 10, true);
    await expect(validateChatAttachment(headerOnly, "empty.webp", "image/webp")).rejects.toThrow(/damaged/);
  });
});
