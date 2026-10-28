import { strToU8, zipSync } from "fflate";
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
} from "./model";

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Escapes text for XML and drops characters XML 1.0 cannot carry. */
export function xmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/gu, "")
    .replace(/[&<>"']/gu, (character) => XML_ESCAPES[character]!);
}

const PAPER = { a4: { width: 11906, height: 16838 }, letter: { width: 12240, height: 15840 } } as const;
const FONTS = { modern: "Arial", classic: "Times New Roman" } as const;

type RunStyle = { bold?: boolean; italic?: boolean; size?: number; color?: string; highlight?: boolean; caps?: boolean };

function run(text: string, style: RunStyle = {}): string {
  const properties = [
    style.bold ? "<w:b/>" : "",
    style.italic ? "<w:i/>" : "",
    style.caps ? "<w:caps/>" : "",
    style.color ? `<w:color w:val="${style.color}"/>` : "",
    style.size ? `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>` : "",
    style.highlight ? `<w:highlight w:val="yellow"/>` : "",
  ].join("");
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

function paragraph(runs: string, options: { style?: string; align?: "center" | "left"; indent?: number; spacingAfter?: number; keepNext?: boolean; pageBreakBefore?: boolean } = {}): string {
  const properties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.keepNext ? "<w:keepNext/>" : "",
    options.pageBreakBefore ? "<w:pageBreakBefore/>" : "",
    options.spacingAfter === undefined ? "" : `<w:spacing w:after="${options.spacingAfter}"/>`,
    options.indent ? `<w:ind w:left="${options.indent}"/>` : "",
    options.align ? `<w:jc w:val="${options.align}"/>` : "",
  ].join("");
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${runs}</w:p>`;
}

function bodyRuns(text: string): string {
  return textRuns(text).map((part) => run(part.text, part.placeholder ? { highlight: true } : {})).join("");
}

function coverPage(document: ExportDocument): string {
  const items = document.formalities.map((item) => paragraph(
    run("☐  ", {}) + run(item.title, { bold: true }) + run(` ${item.detail}`) + (item.sources.length ? run(` (${item.sources.join("; ")})`, { color: "4B5563" }) : ""),
    { spacingAfter: 120, indent: 0 },
  )).join("");
  return [
    paragraph(run("Law of the Land", { bold: true, size: 20 }), { spacingAfter: 480 }),
    paragraph(run(COVER_EYEBROW, { size: 16, color: "6B7280", bold: true }), { spacingAfter: 120 }),
    paragraph(run(document.title, { bold: true, size: 40 }), { spacingAfter: 120 }),
    paragraph(run(metaLine(document), { size: 18, color: "4B5563" }), { spacingAfter: 480 }),
    paragraph(run("About this document", { bold: true }), { spacingAfter: 80, keepNext: true }),
    paragraph(run(coverNotice(document), { color: "374151" }), { spacingAfter: 360 }),
    ...(document.formalities.length ? [paragraph(run("Before you sign", { bold: true }), { spacingAfter: 80, keepNext: true }), items] : []),
  ].join("");
}

function notesSection(document: ExportDocument): string {
  const clauses = numberClauses(document.clauses);
  return [
    paragraph(run("Drafting notes", { bold: true, size: 28 }), { pageBreakBefore: true, spacingAfter: 120 }),
    paragraph(run("Why each part is in the document and the law it rests on. Remove these notes before the document is signed or sent.", { color: "4B5563" }), { spacingAfter: 240 }),
    ...clauses.map((clause) => [
      paragraph(run(clauseHeadingLine(clause), { bold: true }) + run(`  ${clause.basisLabel}`, { color: "6B7280", size: 18 }), { keepNext: true, spacingAfter: 60 }),
      clause.why ? paragraph(run(clause.why), { spacingAfter: 60 }) : "",
      clause.lawSummary ? paragraph(run("The law: ", { bold: true }) + run(clause.lawSummary), { spacingAfter: 60 }) : "",
      clause.sources.length ? paragraph(run(`Sources: ${clause.sources.join("; ")}`, { color: "4B5563", size: 18 }), { spacingAfter: 200 }) : paragraph("", { spacingAfter: 140 }),
    ].join("")),
  ].join("");
}

function documentBody(document: ExportDocument): string {
  const clauses = numberClauses(document.clauses);
  const parts: string[] = [];
  parts.push(paragraph(run(document.title, { bold: true, size: 32, caps: true }), { align: "center", spacingAfter: 360, pageBreakBefore: document.options.includeCover }));
  for (const clause of clauses) {
    const heading = clauseHeadingLine(clause);
    if (clause.kind !== "opening" && heading) {
      parts.push(paragraph(run(heading, { bold: true }), { style: "ClauseHeading", keepNext: true, pageBreakBefore: clause.kind === "schedule" }));
    }
    for (const line of clauseParagraphs(clause.text)) {
      parts.push(paragraph(bodyRuns(line.text), { indent: line.indent ? 567 : undefined }));
    }
  }
  return parts.join("");
}

function documentXml(document: ExportDocument): string {
  const paper = PAPER[document.options.paper];
  const body = [
    document.options.includeCover ? coverPage(document) : "",
    documentBody(document),
    document.options.includeNotes ? notesSection(document) : "",
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${paper.width}" w:h="${paper.height}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

function stylesXml(document: ExportDocument): string {
  const font = FONTS[document.options.style];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="ClauseHeading"><w:name w:val="Clause heading"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
</w:styles>`;
}

function footerXml(document: ExportDocument): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="9026"/></w:tabs></w:pPr>${run(footerLine(document))}<w:r><w:tab/></w:r>${run("Page ")}<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>${run(" of ")}<w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>
</w:ftr>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

function coreXml(document: ExportDocument): string {
  const created = new Date(document.preparedAt).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlText(document.title)}</dc:title><dc:creator>Law of the Land</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`;
}

/** An editable Word file of the draft. */
export function buildDocx(document: ExportDocument): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "docProps/core.xml": strToU8(coreXml(document)),
    "word/document.xml": strToU8(documentXml(document)),
    "word/styles.xml": strToU8(stylesXml(document)),
    "word/footer1.xml": strToU8(footerXml(document)),
    "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
  }, { level: 6 });
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
