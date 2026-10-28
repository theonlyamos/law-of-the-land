import { describe, expect, it } from "vitest";
import {
  attachPooledCitations,
  fallbackSummary,
  interactionOutput,
  parseCheckOutput,
  parseJsonObject,
  parseReading,
  parseSummary,
  READING_SCHEMA,
  selectSegmentsToCheck,
  type ModelCitation,
} from "./documentReviewModel";
import {
  documentReviewSourceUrl,
  isDocumentReviewRequest,
  optionId,
  sortFindings,
} from "../../shared/document-review";

describe("document review requests", () => {
  it.each([
    "Can you check this contract before I sign it?",
    "review this lease",
    "Please look over my tenancy agreement",
    "Is this eviction notice legal?",
    "is the termination letter valid",
    "Are there any red flags in this?",
    "What should I watch out for?",
    "Does this policy comply with the Data Protection Act?",
    "what are my rights under this agreement",
    "Review",
    "Can you go through the will my father left?",
  ])("treats %j as a review", (query) => {
    expect(isDocumentReviewRequest(query)).toBe(true);
  });

  it.each([
    "Summarise this document",
    "Can you translate this letter?",
    "Extract the dates from this file",
    "What is the minimum wage in Ghana?",
    "How many days of annual leave do I get?",
    "",
  ])("keeps %j on the ordinary answer path", (query) => {
    expect(isDocumentReviewRequest(query)).toBe(false);
  });
});

describe("shared helpers", () => {
  it("makes stable option ids", () => {
    expect(optionId("I'm the tenant")).toBe("i-m-the-tenant");
    expect(optionId("  ")).toBe("option");
  });

  it("orders findings by severity or by position in the document", () => {
    const findings = [
      { ordinal: 0, segmentOrdinal: 4, status: "fine" as const },
      { ordinal: 1, segmentOrdinal: 1, status: "check" as const },
      { ordinal: 2, status: "attention" as const },
      { ordinal: 3, segmentOrdinal: 2, status: "attention" as const },
    ];
    expect(sortFindings(findings).map((finding) => finding.ordinal)).toEqual([3, 2, 1, 0]);
    expect(sortFindings(findings, "document").map((finding) => finding.ordinal)).toEqual([1, 3, 0, 2]);
  });

  it("builds source links the preview accepts", () => {
    expect(documentReviewSourceUrl("rev1", "find1", 2, 7)).toBe("/api/document-reviews/rev1/sources/find1/2#page=7");
    expect(documentReviewSourceUrl("rev1", "find1", 0)).toBe("/api/document-reviews/rev1/sources/find1/0");
  });
});

describe("reading", () => {
  it("keeps array limits out of the response schema so the provider accepts it", () => {
    expect(JSON.stringify(READING_SCHEMA)).not.toContain("maxItems");
  });

  it("enforces the passage limit while parsing", () => {
    const segments = Array.from({ length: 120 }, (_, index) => ({ ref: String(index + 1), heading: "", text: `Clause ${index + 1}.`, page: 1, excerpt: false, priority: "standard", topics: [] }));
    const reading = parseReading(JSON.stringify({ document_type: "Contract", segments, focus_options: [], role_options: [] }));
    expect(reading?.segments).toHaveLength(80);
  });

  it("parses a reading, keeping only known focus topics and a valid suggested side", () => {
    const reading = parseReading("```json\n" + JSON.stringify({
      document_type: "Notice to quit",
      title: "Notice to vacate",
      summary: "A landlord's notice asking the tenant to leave.",
      is_legal_document: true,
      parties: [{ role: "Landlord", name: "K. Owusu" }, { role: "" }],
      role_options: ["I'm the tenant", "I'm the landlord"],
      suggested_role: "I'm the tenant",
      focus_options: ["Notice period", "Grounds"],
      suggested_focus: ["Notice period", "Unknown"],
      user_goal: "Check whether the notice is valid.",
      scope: "targeted",
      segments: [
        { ref: "1", text: "You must leave within 7 days.", priority: "key", topics: ["Notice period", "Other"], page: 1 },
        { text: "   " },
        { heading: "Signature", text: "Signed by the landlord", priority: "boilerplate", topics: [] },
      ],
    }) + "\n```");
    expect(reading).toMatchObject({
      documentType: "Notice to quit",
      roleOptions: [{ id: "i-m-the-tenant", label: "I'm the tenant" }, { id: "i-m-the-landlord", label: "I'm the landlord" }],
      suggestedRoleId: "i-m-the-tenant",
      suggestedFocusIds: ["notice-period"],
      scope: "targeted",
      parties: [{ role: "Landlord", name: "K. Owusu" }],
    });
    expect(reading!.segments).toEqual([
      { ref: "1", text: "You must leave within 7 days.", page: 1, excerpt: false, priority: "key", topics: ["notice-period"] },
      { heading: "Signature", text: "Signed by the landlord", excerpt: false, priority: "boilerplate", topics: [] },
    ]);
  });

  it("rejects a reading without a document type or any passages", () => {
    expect(parseReading(JSON.stringify({ document_type: "Letter", segments: [] }))).toBeNull();
    expect(parseReading("not json")).toBeNull();
    expect(parseJsonObject("Here you go: {\"a\": 1} thanks")).toEqual({ a: 1 });
  });
});

describe("choosing passages to check", () => {
  const segments = [
    { priority: "boilerplate" as const, topics: [] },
    { priority: "key" as const, topics: ["rent"] },
    { priority: "standard" as const, topics: ["entry"] },
    { priority: "key" as const, topics: [] },
  ];

  it("checks key and standard passages in document order, focus first when capped", () => {
    expect(selectSegmentsToCheck(segments, { focusIds: [], scope: "full" })).toEqual([1, 2, 3]);
    expect(selectSegmentsToCheck(segments, { focusIds: ["entry"], scope: "full", maximum: 2 })).toEqual([1, 2]);
  });

  it("checks only the chosen topics for a targeted question", () => {
    expect(selectSegmentsToCheck(segments, { focusIds: ["entry"], scope: "targeted" })).toEqual([2]);
  });

  it("falls back to every passage when nothing stands out", () => {
    expect(selectSegmentsToCheck([{ priority: "boilerplate", topics: [] }], { focusIds: [], scope: "full" })).toEqual([0]);
  });
});

describe("checking output", () => {
  const stores = [{ jurisdictionId: "jur1", storeName: "fileSearchStores/ghana" }];
  const metadata = (resource: string) => [
    { key: "jurisdiction_id", string_value: "jur1" }, { key: "resource_id", string_value: resource }, { key: "version_id", string_value: `${resource}-v1` },
  ];

  it("ties each citation to the finding whose text it annotates", () => {
    const first = `{"findings":[{"passage_id":"P1","status":"attention","title":"Short notice","meaning":"Seven days is too short.","law":"The Act requires longer notice.","provisions":["Section 17, Rent Act"],"recommendation":"Ask for the legal notice period.","suggested_wording":"Give three months' notice."},`;
    const second = `{"passage_id":"P2","status":"fine","title":"Signature","meaning":"Signed properly.","law":"Signing is required.","provisions":["Section 3"],"recommendation":"Nothing to do."}]}`;
    const text = first + second;
    const lawIndex = new TextEncoder().encode(first.slice(0, first.indexOf("The Act"))).byteLength;
    const secondIndex = new TextEncoder().encode(first).byteLength + 60;
    const response = {
      status: "completed",
      steps: [
        { type: "file_search_call" },
        { type: "model_output", content: [{ type: "text", text, annotations: [
          { type: "file_citation", custom_metadata: metadata("rentAct"), document_uri: "fileSearchStores/ghana/documents/rent", page_number: 4, start_index: lawIndex, end_index: lawIndex + 10 },
          { type: "file_citation", custom_metadata: metadata("signing"), start_index: secondIndex, end_index: secondIndex + 5 },
          { type: "file_citation", custom_metadata: [{ key: "jurisdiction_id", string_value: "elsewhere" }, { key: "resource_id", string_value: "x" }, { key: "version_id", string_value: "y" }] },
        ] }] },
      ],
    };
    const output = interactionOutput(response, stores);
    expect(output?.searches).toBe(1);
    expect(output?.annotations).toHaveLength(2);
    const parsed = parseCheckOutput(output!, { kind: "passage", passageOrdinals: [0, 1] });
    expect(parsed!.findings).toHaveLength(2);
    expect(parsed!.findings[0]).toMatchObject({
      segmentOrdinal: 0, status: "attention", suggestedWording: "Give three months' notice.",
      citations: [{ resourceId: "rentAct", providerDocumentName: "fileSearchStores/ghana/documents/rent", pageNumber: 4, provision: "Section 17, Rent Act" }],
    });
    expect(parsed!.findings[1]).toMatchObject({ segmentOrdinal: 1, status: "fine", citations: [{ resourceId: "signing" }] });
    expect(parsed!.findings[1].suggestedWording).toBeUndefined();
    expect(parsed!.pool.map((citation) => citation.resourceId)).toEqual(["rentAct", "signing"]);
  });

  it("drops findings for passages outside the batch and downgrades conclusions without a legal basis", () => {
    const text = JSON.stringify({ findings: [
      { passage_id: "P9", status: "attention", title: "Other", meaning: "Not in this batch.", law: "x" },
      { passage_id: "P1", status: "check", title: "Vague", meaning: "Unclear wording.", law: "", recommendation: "Ask." },
      { passage_id: "P1", status: "fine", title: "Duplicate", meaning: "Second answer for the same passage." },
    ] });
    const parsed = parseCheckOutput({ text, annotations: [] }, { kind: "passage", passageOrdinals: [0] });
    expect(parsed!.findings).toEqual([expect.objectContaining({ segmentOrdinal: 0, status: "unconfirmed", title: "Vague", citations: [] })]);
  });

  it("keeps only real gaps when checking for missing terms", () => {
    const text = JSON.stringify({ findings: [
      { status: "attention", title: "No deposit terms", meaning: "The lease doesn't say how the deposit is handled.", law: "The Act limits advance rent.", provisions: [] },
      { status: "fine", title: "Fine", meaning: "Nothing missing." },
    ] });
    const parsed = parseCheckOutput({ text, annotations: [] }, { kind: "missing", passageOrdinals: [] });
    expect(parsed!.findings).toEqual([expect.objectContaining({ kind: "missing", title: "No deposit terms" })]);
    expect(parsed!.findings[0].segmentOrdinal).toBeUndefined();
  });

  it("matches unanchored sources by the Act the finding names", () => {
    const pool = [
      { jurisdictionId: "j", resourceId: "labour", versionId: "v", providerStoreName: "s", title: "Labour Act, 2003 (Act 651)" },
      { jurisdictionId: "j", resourceId: "rent", versionId: "v", providerStoreName: "s", title: "Rent Act, 1963 (Act 220)" },
    ];
    const matched = attachPooledCitations({ status: "attention", lawSummary: "Under the Labour Act an employee gets 15 days.", provisions: [], citations: [] as ModelCitation[] }, pool);
    expect(matched.map((citation) => citation.resourceId)).toEqual(["labour"]);
    expect(matched[0]).not.toHaveProperty("title");
    expect(attachPooledCitations({ status: "unconfirmed", lawSummary: "Labour Act", provisions: [], citations: [] as ModelCitation[] }, pool)).toEqual([]);
  });

  it("matches pooled sources when the model writes the title with different punctuation", () => {
    const pool = [{ jurisdictionId: "j", resourceId: "contracts", versionId: "v", providerStoreName: "s", title: "Contracts Act 1960 (Act 25)" }];
    const matched = attachPooledCitations({ status: "check", lawSummary: "Under the Contracts Act, 1960, a penalty clause may not be enforced.", provisions: [], citations: [] as ModelCitation[] }, pool);
    expect(matched.map((citation) => citation.resourceId)).toEqual(["contracts"]);
  });

  it("ignores incomplete interactions", () => {
    expect(interactionOutput({ status: "in_progress", steps: [] }, stores)).toBeNull();
    expect(interactionOutput(null, stores)).toBeNull();
  });
});

describe("summary", () => {
  it("parses the model summary and caps next steps", () => {
    expect(parseSummary(JSON.stringify({ headline: "Two parts need attention.", overview: "Clause 9.2 conflicts with the Act.", next_steps: ["a", "b", "c", "d", "e"] })))
      .toEqual({ headline: "Two parts need attention.", overview: "Clause 9.2 conflicts with the Act.", nextSteps: ["a", "b", "c", "d"] });
    expect(parseSummary(JSON.stringify({ headline: "", overview: "x" }))).toBeNull();
  });

  it("writes a calm fallback from the counts", () => {
    expect(fallbackSummary({ attention: 1, check: 2, fine: 3, unconfirmed: 0 }, "Lease").headline).toBe("1 part of this lease needs attention.");
    expect(fallbackSummary({ attention: 0, check: 2, fine: 0, unconfirmed: 1 }, "Lease").headline).toBe("No direct conflicts found, but 2 parts are worth checking.");
    expect(fallbackSummary({ attention: 0, check: 0, fine: 0, unconfirmed: 0 }, "Will").overview).toBe("No passages could be checked.");
  });
});
