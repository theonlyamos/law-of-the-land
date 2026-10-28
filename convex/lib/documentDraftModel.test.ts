import { describe, expect, it } from "vitest";
import { draftPrompt, parseDraftOutput, parseFormalities, parsePlan, placeholderClause, sectionId } from "./documentDraftModel";
import {
  countBases,
  countPlaceholders,
  documentDraftSourceUrl,
  draftFileName,
  isDocumentDraftRequest,
  placeholdersIn,
} from "../../shared/document-draft";

describe("document draft requests", () => {
  it.each([
    "Draft a tenancy agreement for my flat in Accra",
    "Can you write an employment contract for a driver?",
    "Please prepare a power of attorney",
    "I need a non-disclosure agreement for a supplier",
    "draw up a shareholders' agreement for three founders",
    "Generate a privacy policy for my online store",
    "Write a notice to quit for a tenant who owes rent",
    "Prepare a statement of claim for unpaid invoices",
    "Create a board resolution to open a bank account",
    "template for a loan agreement",
  ])("treats %j as a drafting request", (query) => {
    expect(isDocumentDraftRequest(query)).toBe(true);
  });

  it.each([
    "What are my rights as a tenant?",
    "Review this contract",
    "Summarise this agreement",
    "Is this notice to quit valid?",
    "Explain what a power of attorney is",
    "",
  ])("does not treat %j as a drafting request", (query) => {
    expect(isDocumentDraftRequest(query)).toBe(false);
  });

  it("finds blanks, counts bases and builds file names and source links", () => {
    expect(placeholdersIn("Between [Landlord's name] and [Tenant's name], rent [x] [ ]")).toEqual(["[Landlord's name]", "[Tenant's name]"]);
    expect(countPlaceholders(["[a1] and [b2]", "none", "[date of signing]"])).toBe(3);
    expect(countBases([{ basis: "required" }, { basis: "common" }, { basis: "required" }])).toEqual({ required: 2, protects: 0, common: 1, choice: 0 });
    expect(draftFileName("Lease: Flat 2/B?", "pdf")).toBe("Lease Flat 2 B.pdf");
    expect(draftFileName("  ", "docx")).toBe("Document.docx");
    expect(documentDraftSourceUrl("d1", "c 2", 1, 4)).toBe("/api/document-drafts/d1/sources/c%202/1#page=4");
  });
});

describe("planning", () => {
  it("reads a plan and keeps only well-formed parts", () => {
    const plan = parsePlan(JSON.stringify({
      document_type: "Tenancy agreement",
      title: "Tenancy Agreement for Flat 2",
      summary: "A one-year residential tenancy.",
      is_legal_document: true,
      role_options: ["Landlord", "Tenant", "landlord", "Neutral"],
      suggested_role: "Tenant",
      suggested_audience: "professional",
      questions: [
        { id: "rent", label: "monthly rent", kind: "number", suggested: "GH₵ 2,000" },
        { label: "Who pays for water?", kind: "choice", options: ["Landlord", "Tenant", "Tenant"] },
        { label: "Start date", kind: "choice", options: ["Only one"] },
        { label: "" },
      ],
      sections: [
        { heading: "Parties", purpose: "Name the parties.", kind: "opening" },
        { heading: "Rent", purpose: "Rent and advance.", kind: "clause" },
        { heading: "", purpose: "dropped" },
        { heading: "Signatures", purpose: "Execution blocks.", kind: "signatures" },
      ],
      source_notes: "",
    }));
    expect(plan).toMatchObject({
      documentType: "Tenancy agreement",
      suggestedRoleId: "tenant",
      suggestedAudience: "professional",
      roleOptions: [{ id: "landlord", label: "Landlord" }, { id: "tenant", label: "Tenant" }],
    });
    expect(plan!.questions).toMatchObject([
      { id: "rent", label: "Monthly rent", kind: "number", suggested: "GH₵ 2,000" },
      { kind: "choice", options: ["Landlord", "Tenant"] },
      { label: "Start date", kind: "text", options: [] },
    ]);
    expect(plan!.sections.map((section) => section.kind)).toEqual(["opening", "clause", "signatures"]);
  });

  it("rejects a plan without a document type or sections", () => {
    expect(parsePlan(JSON.stringify({ document_type: "Will", sections: [] }))).toBeNull();
    expect(parsePlan("not json")).toBeNull();
  });
});

describe("drafting output", () => {
  const citation = (resourceId: string) => ({ jurisdictionId: "j", resourceId, versionId: "v", providerStoreName: "fileSearchStores/ghana" });

  it("anchors each source to the section whose JSON object it falls in", () => {
    const text = JSON.stringify({ sections: [
      { section_id: "S2", heading: "Rent", text: "The rent is [amount] a month.", basis: "required", why: "Caps advance rent.", law: "Advance rent is limited to six months.", provisions: ["Section 25, Rent Act"] },
      { section_id: "S3", heading: "Repairs", text: "The landlord repairs the structure.", basis: "protects", why: "Repairs.", law: "The landlord keeps the premises fit.", provisions: [] },
    ] });
    const encoder = new TextEncoder();
    const at = (needle: string) => encoder.encode(text.slice(0, text.indexOf(needle))).byteLength;
    const parsed = parseDraftOutput({ text, annotations: [
      { start: at("Advance rent"), citation: citation("rent") },
      { start: at("The landlord keeps"), citation: citation("repairs") },
    ] }, [1, 2]);
    expect(parsed!.clauses).toMatchObject([
      { sectionOrdinal: 1, basis: "required", citations: [{ resourceId: "rent", provision: "Section 25, Rent Act" }] },
      { sectionOrdinal: 2, basis: "protects", citations: [{ resourceId: "repairs" }] },
    ]);
    expect(parsed!.pool.map((entry) => entry.resourceId)).toEqual(["rent", "repairs"]);
  });

  it("drops sections outside the batch and downgrades legal claims without a stated law", () => {
    const text = JSON.stringify({ sections: [
      { section_id: "S9", heading: "Other", text: "Not asked for.", basis: "common" },
      { section_id: "S1", heading: "Notice", text: "Either party may end this with notice.", basis: "required", law: "", provisions: ["Section 1"] },
      { section_id: "S1", heading: "Again", text: "Duplicate.", basis: "common" },
      { section_id: "S2", heading: "Empty", text: "", basis: "choice" },
    ] });
    const parsed = parseDraftOutput({ text, annotations: [] }, [0, 1]);
    expect(parsed!.clauses).toEqual([expect.objectContaining({ sectionOrdinal: 0, basis: "common", lawSummary: "", provisions: [], citations: [] })]);
  });

  it("keeps section ids and prompts stable, and writes a placeholder when a section fails", () => {
    expect(sectionId(0)).toBe("S1");
    const prompt = JSON.parse(draftPrompt({
      jurisdictionName: "Ghana", request: "Draft a lease", documentType: "Lease", title: "Lease", summary: "", side: "Tenant",
      audience: "personal", answers: [{ label: "Rent", value: "2000" }], instructions: "", outline: ["1. Parties"],
    }, [{ ordinal: 0, heading: "Parties", purpose: "Name them", kind: "opening" }]));
    expect(prompt.sectionsToDraft).toEqual([{ section_id: "S1", heading: "Parties", kind: "opening", mustCover: "Name them" }]);
    expect(prompt.untrustedAnswers).toEqual([{ question: "Rent", answer: "2000" }]);
    expect(placeholderClause({ ordinal: 3, heading: "Deposit", purpose: "Deposit terms" })).toMatchObject({ sectionOrdinal: 3, basis: "common", citations: [] });
  });
});

describe("formalities", () => {
  it("keeps requirements only when the law is stated", () => {
    const text = JSON.stringify({ items: [
      { item_id: "F1", title: "Stamp the agreement", detail: "Pay stamp duty within two months.", basis: "required", law: "Instruments must be stamped.", provisions: ["Section 2, Stamp Duty Act"] },
      { item_id: "F2", title: "Sign before two witnesses", detail: "Have it witnessed.", basis: "required", law: "" },
      { item_id: "F3", title: "", detail: "No title." },
    ] });
    const parsed = parseFormalities({ text, annotations: [] });
    expect(parsed!.items).toMatchObject([
      { title: "Stamp the agreement", basis: "required", provisions: ["Section 2, Stamp Duty Act"] },
      { title: "Sign before two witnesses", basis: "common", lawSummary: "" },
    ]);
  });
});
