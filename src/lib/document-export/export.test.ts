// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx";
import { clauseHeadingLine, clauseParagraphs, numberClauses, textRuns, type ExportDocument } from "./model";
import { buildPdf } from "./pdf";

function sample(overrides: Partial<ExportDocument["options"]> = {}): ExportDocument {
  return {
    title: "Tenancy Agreement",
    documentType: "Residential tenancy agreement",
    jurisdictionName: "Ghana",
    sideLabel: "Landlord",
    audience: "personal",
    version: 2,
    preparedAt: Date.UTC(2026, 9, 28),
    clauses: [
      { kind: "opening", heading: "Parties", text: "This agreement is made between [Landlord name] and [Tenant name].", basisLabel: "No law cited", why: "Names the parties.", lawSummary: "", sources: [] },
      { kind: "clause", heading: "Rent", text: "The rent is GH₵ [amount] each month.\n(a) Rent is paid on the first day.\n(b) Advance rent is limited to six months.", basisLabel: "Required by law", why: "Caps advance rent.", lawSummary: "Advance rent is capped.", sources: ["Rent Act 1963 (Act 220), s. 25"] },
      { kind: "clause", heading: "Repairs & <upkeep>", text: "The landlord keeps the structure in repair.", basisLabel: "Backed by law", why: "", lawSummary: "", sources: [] },
      { kind: "schedule", heading: "Inventory", text: "Two chairs.", basisLabel: "No law cited", why: "", lawSummary: "", sources: [] },
      { kind: "signatures", heading: "Signatures", text: "Signed: ____________", basisLabel: "No law cited", why: "", lawSummary: "", sources: [] },
    ],
    formalities: [{ title: "Stamp the agreement", detail: "Take it to the stamp office.", required: true, sources: ["Stamp Duty Act 2005 (Act 689)"] }],
    options: { includeCover: true, includeNotes: true, style: "modern", paper: "a4", watermark: false, ...overrides },
  };
}

async function fonts(style: "Sans" | "Serif") {
  const directory = path.resolve(__dirname, "../../../public/fonts/export");
  return {
    regular: new Uint8Array(await readFile(path.join(directory, `Liberation${style}-Regular.ttf`))),
    bold: new Uint8Array(await readFile(path.join(directory, `Liberation${style}-Bold.ttf`))),
  };
}

async function pdfText(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const content = await (await pdf.getPage(index)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages;
}

describe("export model", () => {
  it("numbers clauses and schedules and leaves the opening and signatures unnumbered", () => {
    const lines = numberClauses(sample().clauses).map(clauseHeadingLine);
    expect(lines).toEqual(["Parties", "1. Rent", "2. Repairs & <upkeep>", "Schedule 1: Inventory", "Signatures"]);
  });

  it("splits placeholders into their own runs and indents sub-clauses", () => {
    expect(textRuns("Pay [amount] to [name].")).toEqual([
      { text: "Pay ", placeholder: false },
      { text: "[amount]", placeholder: true },
      { text: " to ", placeholder: false },
      { text: "[name]", placeholder: true },
      { text: ".", placeholder: false },
    ]);
    expect(clauseParagraphs("Intro.\n(a) First.\n\n(ii) Second.").map((part) => part.indent)).toEqual([false, true, true]);
  });
});

describe("Word export", () => {
  it("writes a valid package with escaped text and highlighted blanks", () => {
    const files = unzipSync(buildDocx(sample()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/footer1.xml"]));
    const body = strFromU8(files["word/document.xml"]!);
    expect(body).toContain("Repairs &amp; &lt;upkeep&gt;");
    expect(body).toContain('<w:highlight w:val="yellow"/>');
    expect(body).toContain("Drafting notes");
    expect(body).toContain("GH₵");
  });

  it("leaves out the cover and notes when asked", () => {
    const body = strFromU8(unzipSync(buildDocx(sample({ includeCover: false, includeNotes: false })))["word/document.xml"]!);
    expect(body).not.toContain("COVER PAGE");
    expect(body).not.toContain("Drafting notes");
  });
});

describe("PDF export", () => {
  it("renders the cover, the clauses, the cedi sign and page footers", async () => {
    const pages = await pdfText(await buildPdf(sample(), await fonts("Sans")));
    const all = pages.join("\n");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[0]).toContain("Before you sign");
    expect(all).toContain("1. Rent");
    expect(all).toContain("GH₵");
    expect(all).toContain("Schedule 1: Inventory");
    expect(pages.at(-1)).toContain(`Page ${pages.length} of ${pages.length}`);
    expect(all).not.toContain("DRAFT");
  });

  it("adds the draft mark and works with the classic font on Letter paper", async () => {
    const pages = await pdfText(await buildPdf(sample({ watermark: true, style: "classic", paper: "letter", includeCover: false, includeNotes: false }), await fonts("Serif")));
    expect(pages[0]).toContain("DRAFT");
    expect(pages[0]).toContain("TENANCY AGREEMENT");
    expect(pages.join(" ")).not.toContain("Drafting notes");
  });
});
