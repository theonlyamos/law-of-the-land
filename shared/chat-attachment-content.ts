import { Unzip, UnzipInflate, Unzlib } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { PDFArray, PDFCatalog, PDFDict, PDFName, PDFNumber, PDFObjectStreamParser, PDFPageLeaf, PDFPageTree, PDFParser, PDFRawStream, type PDFObject, type PDFStream } from "pdf-lib";
import {
  chatAttachmentFormat, MAX_CHAT_DOCUMENT_PAGES, MAX_CHAT_TEXT_CHARACTERS,
  validateChatAttachmentSelection, type ChatAttachmentKind,
} from "./chat-attachments";

export type ValidatedChatAttachment = {
  mimeType: string;
  kind: ChatAttachmentKind;
  extractedText?: string;
  pageCount?: number;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8192;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_PDF_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_PDF_METADATA_ENTRIES = 20_000;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function chunkCrc(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let offset = start; offset < end; offset++) value = CRC_TABLE[(value ^ bytes[offset]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function invalid(message = "This file is damaged or does not match its file type."): never {
  throw new Error(message);
}

class PdfObjectStreamPreflight extends PDFObjectStreamParser {
  private depth = 0;

  constructor(stream: PDFRawStream, private readonly reject: () => never, private readonly countNode: () => void) { super(stream); }

  override parseObject(): PDFObject {
    this.countNode();
    if (++this.depth > 64) this.reject();
    try { return super.parseObject(); } finally { this.depth--; }
  }

  checkSpans(first: number, offsets: number[], length: number): void {
    for (const [index, offset] of offsets.entries()) {
      this.bytes.moveTo(first + offset);
      this.parseObject();
      if (this.bytes.offset() > first + (offsets[index + 1] ?? length - first)) this.reject();
    }
  }
}

/** Intercept the only streams pdf-lib decodes during parsing, before allocation.
 * This is per-document state; ordinary page/image streams remain compressed. */
class BoundedPdfParser extends PDFParser {
  validationError?: Error;
  private decodedBytes = 0;
  private metadataEntries = 0;
  private parsedNodes = 0;
  private depth = 0;

  private reject(message = "This PDF's structure is too complex. Export a simpler PDF and try again."): never {
    this.validationError = new Error(message);
    throw this.validationError;
  }

  private integer(value: unknown, maximum: number): number {
    const number = value instanceof PDFNumber ? value.asNumber() : NaN;
    if (!Number.isSafeInteger(number) || number < 0 || number > maximum) this.reject();
    return number;
  }

  private countNode(): void {
    if (++this.parsedNodes > 100_000) this.reject();
  }

  override parseObject(): PDFObject {
    this.countNode();
    if (++this.depth > 64) this.reject();
    try { return super.parseObject(); } finally { this.depth--; }
  }

  protected override parseDictOrStream(): PDFDict | PDFStream {
    const value = super.parseDictOrStream();
    if (!(value instanceof PDFRawStream)) return value;
    const type = value.dict.lookup(PDFName.of("Type"));
    if (type !== PDFName.of("ObjStm") && type !== PDFName.of("XRef")) return value;
    const field = (name: string) => value.dict.lookup(PDFName.of(name));
    let entries: number;
    let minimumBytes = 0;
    let first = 0;
    if (type === PDFName.of("ObjStm")) {
      entries = this.integer(field("N"), MAX_PDF_METADATA_ENTRIES);
      first = this.integer(field("First"), MAX_PDF_METADATA_BYTES);
    } else {
      const size = this.integer(field("Size"), MAX_PDF_METADATA_ENTRIES);
      const widths = field("W");
      if (!(widths instanceof PDFArray) || widths.size() !== 3) this.reject();
      const entryBytes = [0, 1, 2].reduce((sum, index) => sum + this.integer(widths.lookup(index), 8), 0);
      if (entryBytes === 0) this.reject();
      const index = field("Index");
      entries = size;
      if (index !== undefined) {
        if (!(index instanceof PDFArray) || index.size() % 2 || index.size() > MAX_PDF_METADATA_ENTRIES * 2) this.reject();
        entries = 0;
        for (let offset = 0; offset < index.size(); offset += 2) {
          const start = this.integer(index.lookup(offset), size);
          const count = this.integer(index.lookup(offset + 1), size);
          if (start + count > size) this.reject();
          entries += count;
        }
      }
      minimumBytes = entries * entryBytes;
    }
    this.metadataEntries += entries;
    if (this.metadataEntries > MAX_PDF_METADATA_ENTRIES) this.reject();

    let filter = field("Filter");
    if (filter instanceof PDFArray && filter.size() === 1) filter = filter.lookup(0);
    let decoded = value.contents;
    const consume = (length: number) => {
      this.decodedBytes += length;
      if (this.decodedBytes > MAX_PDF_METADATA_BYTES) this.reject("This PDF's expanded structure is too large. Export a simpler PDF and try again.");
    };
    if (filter === PDFName.of("FlateDecode")) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      const inflate = new Unzlib(chunk => { consume(chunk.length); length += chunk.length; chunks.push(chunk); });
      // Limit each expansion step instead of trusting /Length or decoding at once.
      for (let offset = 0; offset < decoded.length; offset += 1024) {
        inflate.push(decoded.subarray(offset, offset + 1024), offset + 1024 >= decoded.length);
      }
      decoded = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.length; }
    } else if (filter === undefined) consume(decoded.length);
    else this.reject("This PDF uses unsupported structural compression. Export it again as a PDF.");
    if (first > decoded.length || minimumBytes > decoded.length) this.reject();
    const dict = value.dict.clone();
    dict.delete(PDFName.of("Filter"));
    dict.delete(PDFName.of("DecodeParms"));
    dict.set(PDFName.of("Length"), PDFNumber.of(decoded.length));
    const stream = PDFRawStream.of(dict, decoded);
    if (type === PDFName.of("ObjStm")) {
      const header = decoder.decode(decoded.subarray(0, first)).replace(/%[^\r\n]*/gu, " ");
      const values: string[] = [];
      for (const match of header.matchAll(/[^\x00\t\n\f\r ]+/gu)) {
        if (values.length >= entries * 2 || !/^\d+$/u.test(match[0])) this.reject();
        values.push(match[0]);
      }
      if (values.length !== entries * 2) this.reject();
      const ids = new Set<number>();
      const offsets: number[] = [];
      for (let index = 0; index < entries; index++) {
        const id = Number(values[index * 2]);
        const offset = Number(values[index * 2 + 1]);
        if (!Number.isSafeInteger(id) || id < 1 || ids.has(id) || !Number.isSafeInteger(offset)
          || offset < 0 || first + offset >= decoded.length || (index > 0 && offset <= offsets[index - 1])) this.reject();
        ids.add(id); offsets.push(offset);
      }
      // Unique offsets alone do not prevent a large object overlapping later entries.
      // Check actual parser boundaries before pdf-lib allocates/retains each object.
      new PdfObjectStreamPreflight(stream, () => this.reject(), () => this.countNode()).checkSpans(first, offsets, decoded.length);
    }
    return stream;
  }
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const parser = new BoundedPdfParser(bytes, 100, true);
  const context = await parser.parseDocument().catch(error => { throw parser.validationError ?? error; });
  if (context.trailerInfo.Encrypt !== undefined) invalid("This PDF is password protected. Remove its protection and try again.");
  const catalog = context.lookup(context.trailerInfo.Root);
  if (!(catalog instanceof PDFCatalog)) invalid();
  const pending: Array<{ node: PDFPageTree | PDFPageLeaf; depth: number }> = [{ node: catalog.Pages(), depth: 0 }];
  const visited = new Set<PDFDict>();
  let pages = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (visited.has(node) || depth > 64 || visited.size >= 2048) invalid("This PDF's page structure is too complex or damaged.");
    visited.add(node);
    if (node instanceof PDFPageLeaf) {
      if (++pages > MAX_CHAT_DOCUMENT_PAGES) invalid("Use a PDF with 1 to 100 pages.");
      continue;
    }
    if (!(node instanceof PDFPageTree)) invalid();
    const children = node.Kids();
    if (children.size() + pending.length + visited.size > 2048) invalid("This PDF's page structure is too complex or damaged.");
    for (let index = 0; index < children.size(); index++) {
      const child = context.lookup(children.get(index));
      if (!(child instanceof PDFPageTree) && !(child instanceof PDFPageLeaf)) invalid();
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  return pages;
}

function readableText(text: string): string {
  if (text.length > MAX_CHAT_TEXT_CHARACTERS) invalid("Use a document with 100,000 characters or fewer.");
  if (!text.trim()) invalid("This file contains no readable text. Try a PDF or image instead.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) invalid("This is not a supported UTF-8 text file.");
  return text;
}

function extractDocx(bytes: Uint8Array): string {
  const parts = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;
  let failure: Error | null = null;
  const archive = new Unzip(file => {
    if (++entryCount > 512 || seen.has(file.name)) invalid("The document archive is too complex or damaged.");
    seen.add(file.name);
    const wanted = file.name === "[Content_Types].xml"
      || /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/u.test(file.name);
    if (!wanted) return;
    if (file.originalSize !== undefined && file.originalSize > MAX_XML_BYTES) invalid("The document's expanded content is too large.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) { failure = error; file.terminate(); return; }
      size += data.byteLength;
      totalBytes += data.byteLength;
      if (size > MAX_XML_BYTES || totalBytes > MAX_DOCUMENT_XML_BYTES) {
        file.terminate();
        invalid("The document's expanded content is too large.");
      }
      chunks.push(data);
      if (final) {
        const combined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
        parts.set(file.name, combined);
      }
    };
    file.start();
  });
  archive.register(UnzipInflate);
  // Small input chunks cap how much a hostile compressed stream can expand before
  // the ondata size guard runs. Never trust only the ZIP's declared originalSize.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    archive.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    if (failure) invalid();
  }
  const main = parts.get("word/document.xml");
  const contentTypes = parts.get("[Content_Types].xml");
  if (!main || !contentTypes) invalid("This file is not a readable DOCX document.");
  const types = decoder.decode(contentTypes);
  if (!types.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
    || /<!DOCTYPE|<!ENTITY/iu.test(types) || XMLValidator.validate(types) !== true) invalid();

  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true, trimValues: false, parseTagValue: false, processEntities: true });
  const output: string[] = [];
  let characters = 0;
  const append = (value: string) => {
    characters += value.length;
    if (characters > MAX_CHAT_TEXT_CHARACTERS) invalid("Use a document with 100,000 characters or fewer.");
    output.push(value);
  };
  const walk = (nodes: unknown, insideText = false) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      for (const [name, value] of Object.entries(node)) {
        if (name === "#text" && insideText && typeof value === "string") append(value);
        else if (name === "t") walk(value, true);
        else if (name === "tab") append("\t");
        else if (name === "br" || name === "cr") append("\n");
        else if (name !== "del" && name !== "delText" && name !== ":@") {
          walk(value, insideText);
          if (name === "p" || name === "tr") append("\n");
          else if (name === "tc") append("\t");
        }
      }
    }
  };
  const orderedParts = [main, ...[...parts].filter(([name]) => name !== "word/document.xml" && name !== "[Content_Types].xml").sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)];
  for (const part of orderedParts) {
    const xml = decoder.decode(part);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) invalid("The DOCX document contains invalid or unsupported XML.");
    walk(parser.parse(xml));
    append("\n");
  }
  return readableText(output.join("").replace(/\n{3,}/gu, "\n\n").trim());
}

function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  if (mimeType === "image/png") {
    if (bytes.length < 45 || bytes[0] !== 137 || text(1, 7) !== "PNG\r\n\x1a\n" || view.getUint32(8) !== 13 || text(12, 4) !== "IHDR") invalid();
    const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!allowedDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) invalid();
    let offset = 8;
    let imageDataBytes = 0;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset);
      const chunk = text(offset + 4, 4);
      if (offset + size + 12 > bytes.length) invalid();
      if (chunkCrc(bytes, offset + 4, offset + 8 + size) !== view.getUint32(offset + 8 + size)) invalid();
      if (chunk === "IHDR" && offset !== 8) invalid();
      if (chunk === "IDAT") imageDataBytes += size;
      if (chunk === "IEND") { ended = size === 0 && offset + 12 === bytes.length; break; }
      offset += size + 12;
    }
    if (imageDataBytes < 7 || !ended) invalid();
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/jpeg") {
    if (bytes.length < 14 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) invalid();
    let offset = 2;
    let dimensions: { width: number; height: number } | undefined;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (marker === 218) {
        const components = bytes[offset + 2];
        if (!dimensions || length < 6 || components < 1 || components > 4
          || length !== 6 + 2 * components || offset + length >= bytes.length - 2) invalid();
        return dimensions;
      }
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) invalid();
        dimensions = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    invalid();
  }
  if (bytes.length < 25 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  let canvas: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const chunk = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const end = data + size;
    const next = end + (size % 2);
    if (next > bytes.length || (size % 2 && bytes[end] !== 0)) invalid();
    if (chunk === "ANIM" || chunk === "ANMF") invalid("Use a still image instead of an animated WebP.");
    if (chunk === "VP8X") {
      if (offset !== 12 || size !== 10) invalid();
      if ((bytes[data] & 2) !== 0) invalid("Use a still image instead of an animated WebP.");
      canvas = { width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16), height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16) };
    } else if (chunk === "VP8L") {
      if (dimensions || size <= 5 || bytes[data] !== 47) invalid();
      const bits = view.getUint32(data + 1, true);
      if ((bits >>> 29) !== 0) invalid();
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (chunk === "VP8 ") {
      if (dimensions || size <= 10 || (bytes[data] & 1) !== 0 || text(data + 3, 3) !== "\x9d\x01\x2a") invalid();
      const partitionSize = (view.getUint32(data, true) & 0xffffff) >>> 5;
      if (partitionSize === 0 || partitionSize > size - 10) invalid();
      dimensions = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
    }
    offset = next;
  }
  if (offset !== bytes.length || !dimensions || (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height))) invalid();
  return dimensions;
}

/** V8-safe validation shared by the authenticated Convex HTTP upload and tests. */
export async function validateChatAttachment(bytes: Uint8Array, filename: string, declaredMimeType: string): Promise<ValidatedChatAttachment> {
  const selectionError = validateChatAttachmentSelection({ name: filename, type: declaredMimeType, size: bytes.byteLength });
  if (selectionError) invalid(selectionError);
  const format = chatAttachmentFormat(filename, declaredMimeType)!;
  try {
    if (format.kind === "text") return { ...format, extractedText: readableText(decoder.decode(bytes).replace(/^\uFEFF/u, "")) };
    if (format.kind === "image") {
      const { width, height } = imageDimensions(bytes, format.mimeType);
      if (width < 1 || height < 1 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) invalid("Use an image at most 8192 pixels per side and 32 megapixels.");
      return format;
    }
    if (format.mimeType === "application/pdf") {
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") invalid();
      const pageCount = await pdfPageCount(bytes);
      if (pageCount < 1 || pageCount > MAX_CHAT_DOCUMENT_PAGES) invalid("Use a PDF with 1 to 100 pages.");
      return { ...format, pageCount };
    }
    return { ...format, extractedText: extractDocx(bytes) };
  } catch (error) {
    if (error instanceof Error && /^(Use |Choose |Each |This |The document|The DOCX)/u.test(error.message)) throw error;
    invalid(format.mimeType === "application/pdf" ? "This PDF could not be read. Remove password protection or export it again." : undefined);
  }
}
