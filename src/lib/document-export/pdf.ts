import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  COVER_EYEBROW,
  clauseHeadingLine,
  clauseParagraphs,
  coverNotice,
  footerLine,
  metaLine,
  numberClauses,
  textRuns,
  type ExportDocument,
  type ExportStyle,
} from "./model";

export type ExportFontBytes = { regular: Uint8Array; bold: Uint8Array };

const FONT_FILES: Record<ExportStyle, { regular: string; bold: string }> = {
  modern: { regular: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" },
  classic: { regular: "LiberationSerif-Regular.ttf", bold: "LiberationSerif-Bold.ttf" },
};

const fontCache = new Map<ExportStyle, Promise<ExportFontBytes>>();

/** Loads the embeddable fonts for a style from /fonts/export, once per page load. */
export function loadExportFonts(style: ExportStyle): Promise<ExportFontBytes> {
  const cached = fontCache.get(style);
  if (cached) return cached;
  const load = async (file: string) => {
    const response = await fetch(`/fonts/export/${file}`);
    if (!response.ok) throw new Error(`Could not load ${file}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const files = FONT_FILES[style];
  const promise = Promise.all([load(files.regular), load(files.bold)]).then(([regular, bold]) => ({ regular, bold }));
  promise.catch(() => fontCache.delete(style));
  fontCache.set(style, promise);
  return promise;
}

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MARGIN = 72;
const FOOTER_GAP = 36;
const INK = rgb(0.07, 0.09, 0.13);
const MUTED = rgb(0.29, 0.33, 0.39);
const SOFT = rgb(0.42, 0.45, 0.5);
const MARK = rgb(1, 0.95, 0.6);

type Style = { bold?: boolean; size: number; color?: RGB; placeholder?: boolean };
type Word = { text: string; style: Style; space: boolean };

/** Lays text out on pages: a cursor that wraps words and starts a new page when it runs out of room. */
class Layout {
  readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly supported: Set<number>[];

  constructor(private readonly pdf: PDFDocument, paper: readonly [number, number], private readonly fonts: { regular: PDFFont; bold: PDFFont }) {
    [this.width, this.height] = paper;
    this.supported = [new Set(fonts.regular.getCharacterSet()), new Set(fonts.bold.getCharacterSet())];
    this.newPage();
  }

  get contentWidth() { return this.width - MARGIN * 2; }

  newPage() {
    this.page = this.pdf.addPage([this.width, this.height]);
    this.pages.push(this.page);
    this.y = this.height - MARGIN;
  }

  font(style: Style) { return style.bold ? this.fonts.bold : this.fonts.regular; }

  /** Swaps characters the font cannot draw for close equivalents, so export never fails on one odd character. */
  clean(text: string, bold = false): string {
    const set = this.supported[bold ? 1 : 0]!;
    return Array.from(text.replace(/\t/gu, " ").replace(/[☐☑☒]/gu, "")).map((character) => {
      const code = character.codePointAt(0)!;
      if (set.has(code)) return character;
      if (/[‘’]/u.test(character)) return "'";
      if (/[“”]/u.test(character)) return '"';
      if (/[–—]/u.test(character)) return "-";
      return "?";
    }).join("");
  }

  gap(points: number) {
    this.y -= points;
  }

  ensure(points: number) {
    if (this.y - points < MARGIN + FOOTER_GAP) this.newPage();
  }

  /** Draws wrapped text from runs. Returns nothing; the cursor moves below the paragraph. */
  paragraph(runs: { text: string; style: Style }[], options: { indent?: number; lineHeight?: number; after?: number; keepWith?: number } = {}) {
    const indent = options.indent ?? 0;
    const maxWidth = this.contentWidth - indent;
    const size = Math.max(...runs.map((entry) => entry.style.size), 1);
    const lineHeight = options.lineHeight ?? size * 1.45;
    const words: Word[] = [];
    let pendingSpace = false;
    for (const entry of runs) {
      for (const part of this.clean(entry.text, entry.style.bold).split(/(\s+)/u)) {
        if (!part) continue;
        if (/^\s+$/u.test(part)) { pendingSpace = true; continue; }
        words.push({ text: part, style: entry.style, space: pendingSpace });
        pendingSpace = false;
      }
    }

    const lines: { word: Word; x: number; width: number }[][] = [];
    let line: { word: Word; x: number; width: number }[] = [];
    let x = 0;
    for (const word of words) {
      const font = this.font(word.style);
      const spaceWidth = word.space && line.length ? font.widthOfTextAtSize(" ", word.style.size) : 0;
      let width = font.widthOfTextAtSize(word.text, word.style.size);
      if (line.length && x + spaceWidth + width > maxWidth) {
        lines.push(line);
        line = [];
        x = 0;
      }
      let text = word.text;
      // A single word wider than the line, such as a long reference, is cut to fit.
      while (width > maxWidth && text.length > 1) {
        let cut = text.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(text.slice(0, cut), word.style.size) > maxWidth) cut -= 1;
        lines.push([{ word: { ...word, text: text.slice(0, cut) }, x: 0, width: font.widthOfTextAtSize(text.slice(0, cut), word.style.size) }]);
        text = text.slice(cut);
        width = font.widthOfTextAtSize(text, word.style.size);
      }
      const start = line.length ? x + (word.space ? font.widthOfTextAtSize(" ", word.style.size) : 0) : 0;
      line.push({ word: { ...word, text }, x: start, width });
      x = start + width;
    }
    if (line.length) lines.push(line);

    this.ensure(lineHeight * Math.min(lines.length, 2) + (options.keepWith ?? 0));
    for (const current of lines) {
      this.ensure(lineHeight);
      const baseline = this.y - size;
      for (const item of current) {
        if (!item.word.text) continue;
        if (item.word.style.placeholder) {
          this.page.drawRectangle({ x: MARGIN + indent + item.x - 1, y: baseline - item.word.style.size * 0.25, width: item.width + 2, height: item.word.style.size * 1.2, color: MARK });
        }
        this.page.drawText(item.word.text, {
          x: MARGIN + indent + item.x,
          y: baseline,
          size: item.word.style.size,
          font: this.font(item.word.style),
          color: item.word.style.color ?? INK,
        });
      }
      this.y -= lineHeight;
    }
    this.y -= options.after ?? 0;
  }

  checkbox(size: number) {
    this.page.drawRectangle({ x: MARGIN, y: this.y - size - 1, width: size * 0.8, height: size * 0.8, borderColor: MUTED, borderWidth: 0.8 });
  }

  rule() {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: this.width - MARGIN, y: this.y }, thickness: 0.5, color: rgb(0.85, 0.86, 0.88) });
  }

  footers(left: string, watermark: boolean) {
    const font = this.fonts.regular;
    const size = 8.5;
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      if (watermark) {
        const text = "DRAFT";
        const markSize = 110;
        const width = this.fonts.bold.widthOfTextAtSize(text, markSize);
        page.drawText(text, {
          x: this.width / 2 - (width / 2) * Math.cos(Math.PI / 4) + (markSize / 3) * Math.sin(Math.PI / 4),
          y: this.height / 2 - (width / 2) * Math.sin(Math.PI / 4) - (markSize / 3) * Math.cos(Math.PI / 4),
          size: markSize,
          font: this.fonts.bold,
          color: rgb(0.6, 0.6, 0.6),
          opacity: 0.12,
          rotate: degrees(45),
        });
      }
      const right = `Page ${index + 1} of ${total}`;
      page.drawText(this.clean(left), { x: MARGIN, y: MARGIN - 8, size, font, color: SOFT });
      page.drawText(right, { x: this.width - MARGIN - font.widthOfTextAtSize(right, size), y: MARGIN - 8, size, font, color: SOFT });
    });
  }
}

function bodyRuns(text: string, size: number) {
  return textRuns(text).map((part) => ({ text: part.text, style: { size, placeholder: part.placeholder } }));
}

/** Builds the PDF file for a draft. Fonts are passed in so this also runs in tests and on the server. */
export async function buildPdf(document: ExportDocument, fontBytes: ExportFontBytes): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(document.title);
  pdf.setSubject(document.documentType);
  pdf.setProducer("Law of the Land");
  pdf.setCreator("Law of the Land");
  pdf.setCreationDate(new Date(document.preparedAt));
  const fonts = {
    regular: await pdf.embedFont(fontBytes.regular, { subset: true }),
    bold: await pdf.embedFont(fontBytes.bold, { subset: true }),
  };
  const layout = new Layout(pdf, PAPER[document.options.paper], fonts);
  const body = document.options.style === "classic" ? 11.5 : 10.5;

  if (document.options.includeCover) {
    layout.paragraph([{ text: "Law of the Land", style: { size: 10, bold: true } }], { after: 28 });
    layout.paragraph([{ text: COVER_EYEBROW, style: { size: 7.5, bold: true, color: SOFT } }], { after: 8 });
    layout.paragraph([{ text: document.title, style: { size: 22, bold: true } }], { lineHeight: 28, after: 6 });
    layout.paragraph([{ text: metaLine(document), style: { size: 9, color: MUTED } }], { after: 26 });
    layout.paragraph([{ text: "About this document", style: { size: 10.5, bold: true } }], { after: 4, keepWith: 30 });
    layout.paragraph([{ text: coverNotice(document), style: { size: 10, color: MUTED } }], { after: 22 });
    if (document.formalities.length) {
      layout.paragraph([{ text: "Before you sign", style: { size: 10.5, bold: true } }], { after: 6, keepWith: 30 });
      for (const item of document.formalities) {
        layout.ensure(30);
        layout.checkbox(10);
        layout.paragraph([
          { text: item.title, style: { size: 10, bold: true } },
          { text: ` ${item.detail}`, style: { size: 10 } },
          ...(item.sources.length ? [{ text: ` (${item.sources.join("; ")})`, style: { size: 10, color: SOFT } }] : []),
        ], { indent: 16, after: 6 });
      }
    }
    layout.newPage();
  }

  layout.paragraph([{ text: document.title.toUpperCase(), style: { size: 15, bold: true } }], { lineHeight: 21, after: 18 });
  const clauses = numberClauses(document.clauses);
  let firstSchedule = true;
  for (const clause of clauses) {
    if (clause.kind === "schedule" && firstSchedule) {
      firstSchedule = false;
      layout.newPage();
    }
    const heading = clauseHeadingLine(clause);
    if (heading) layout.paragraph([{ text: heading, style: { size: body + 0.5, bold: true } }], { after: 4, keepWith: body * 3 });
    for (const part of clauseParagraphs(clause.text)) {
      layout.paragraph(bodyRuns(part.text, body), { indent: part.indent ? 22 : 0, after: 5 });
    }
    layout.gap(clause.kind === "signatures" ? 4 : 8);
  }

  if (document.options.includeNotes) {
    layout.newPage();
    layout.paragraph([{ text: "Drafting notes", style: { size: 14, bold: true } }], { after: 6 });
    layout.paragraph([{ text: "Why each part is in the document and the law it rests on. Remove these notes before the document is signed or sent.", style: { size: 9.5, color: MUTED } }], { after: 14 });
    for (const clause of clauses) {
      layout.paragraph([
        { text: clauseHeadingLine(clause) || "Untitled part", style: { size: 10, bold: true } },
        { text: `   ${clause.basisLabel}`, style: { size: 8.5, color: SOFT } },
      ], { after: 3, keepWith: 24 });
      if (clause.why) layout.paragraph([{ text: clause.why, style: { size: 9.5 } }], { after: 3 });
      if (clause.lawSummary) layout.paragraph([{ text: "The law: ", style: { size: 9.5, bold: true } }, { text: clause.lawSummary, style: { size: 9.5 } }], { after: 3 });
      if (clause.sources.length) layout.paragraph([{ text: `Sources: ${clause.sources.join("; ")}`, style: { size: 8.5, color: SOFT } }], { after: 3 });
      layout.gap(6);
      layout.rule();
      layout.gap(8);
    }
  }

  layout.footers(footerLine(document), document.options.watermark);
  return pdf.save();
}

export const PDF_MIME = "application/pdf";

/** Saves bytes as a file in the browser. */
export function downloadFile(bytes: Uint8Array, fileName: string, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
