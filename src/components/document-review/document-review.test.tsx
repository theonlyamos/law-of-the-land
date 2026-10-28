import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), data: undefined as unknown }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.mutate, useQuery: () => mocks.data }));
vi.mock("@/components/chat/citation-source-preview", () => ({
  CitationSourcePreview: ({ source }: { source: { label: string; originalUrl?: string } }) => <div role="dialog" aria-label="Source preview">{source.label} {source.originalUrl}</div>,
}));

import { DocumentReviewCard, documentTypePhrase, type DocumentReviewSummary } from "./document-review-card";
import { DocumentReviewWorkspace, askAboutFindingPrompt } from "./document-review-workspace";
import { buildDocumentReviewReport, escapeHtml } from "./document-review-report";
import { pickReviewAttachment } from "./review-mode-toggle";

afterEach(() => { cleanup(); mocks.mutate.mockReset(); mocks.data = undefined; });

function summary(overrides: Partial<DocumentReviewSummary> = {}): DocumentReviewSummary {
  return {
    id: "review-1" as DocumentReviewSummary["id"],
    userClientId: "user-1",
    attachmentId: "attachment-1" as DocumentReviewSummary["attachmentId"],
    filename: "Employment contract.pdf",
    question: "Can you check this contract before I sign it?",
    status: "awaiting_input",
    documentType: "Employment contract",
    title: "Contract of employment",
    summary: "A permanent role with a three-month probation.",
    roleOptions: [{ id: "employee", label: "I'm the employee" }, { id: "employer", label: "I'm the employer" }],
    focusOptions: [{ id: "termination", label: "Termination and notice" }, { id: "leave", label: "Leave" }],
    suggestedRoleId: "employee",
    suggestedFocusIds: ["leave"],
    isLegalDocument: true,
    focusLabels: [],
    startRequested: false,
    segmentCount: 18,
    checkedCount: 0,
    checkTotal: 0,
    preview: [],
    jurisdictionName: "Ghana",
    createdAt: 1,
    ...overrides,
  };
}

describe("document review card", () => {
  it("names the document type naturally", () => {
    expect(documentTypePhrase("Employment contract")).toBe("an employment contract");
    expect(documentTypePhrase("Lease")).toBe("a lease");
    expect(documentTypePhrase("NDA")).toBe("an NDA");
    expect(documentTypePhrase(undefined)).toBe("a document");
  });

  it("asks which side the person is on and what to focus on, then starts the review", async () => {
    mocks.mutate.mockResolvedValue(null);
    render(<DocumentReviewCard review={summary()} onOpen={vi.fn()} onSummarise={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "This looks like an employment contract" })).toBeVisible();
    const sides = screen.getByRole("group", { name: "Which side are you on?" });
    expect(within(sides).getByRole("radio", { name: "I'm the employee" })).toBeChecked();
    expect(within(sides).getByRole("radio", { name: "Neither / not sure" })).not.toBeChecked();
    fireEvent.click(within(sides).getByRole("radio", { name: "I'm the employer" }));
    expect(screen.getByRole("checkbox", { name: "Leave" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Termination and notice" }));
    fireEvent.click(screen.getByRole("button", { name: "Review document" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ reviewId: "review-1", roleId: "employer", focusIds: ["leave", "termination"] }));
  });

  it("hides the side question when the document has no sides and explains a non-legal document", () => {
    render(<DocumentReviewCard review={summary({ roleOptions: [], isLegalDocument: false })} onOpen={vi.fn()} onSummarise={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Which side are you on?" })).toBeNull();
    expect(screen.getByRole("heading", { name: "This may not be a legal document" })).toBeVisible();
  });

  it("stops the review and asks for a summary instead", async () => {
    mocks.mutate.mockResolvedValue(null);
    const onSummarise = vi.fn();
    render(<DocumentReviewCard review={summary()} onOpen={vi.fn()} onSummarise={onSummarise} />);
    fireEvent.click(screen.getByRole("button", { name: "Just summarise it" }));
    await waitFor(() => expect(onSummarise).toHaveBeenCalledOnce());
    expect(mocks.mutate).toHaveBeenCalledWith({ reviewId: "review-1" });
  });

  it("shows a calm message when the library is unavailable", async () => {
    const { ConvexError } = await import("convex/values");
    mocks.mutate.mockRejectedValue(new ConvexError("DOCUMENT_REVIEW_RESEARCH_UNAVAILABLE"));
    render(<DocumentReviewCard review={summary()} onOpen={vi.fn()} onSummarise={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The law library for this jurisdiction isn't available right now.");
  });

  it("shows progress with the latest findings", () => {
    render(<DocumentReviewCard onOpen={vi.fn()} onSummarise={vi.fn()} review={summary({
      status: "checking", roleLabel: "I'm the employee", focusLabels: ["Leave"], checkedCount: 7, checkTotal: 12,
      preview: [{ ref: "7.1", title: "Annual leave", status: "attention" }],
    })} />);
    expect(screen.getByRole("heading", { name: "Reviewing your employment contract" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Parts checked" })).toHaveAttribute("aria-valuenow", "7");
    expect(screen.getByText("Checking against the law · 7 of 12")).toBeVisible();
    expect(screen.getByText("Found 18 parts, 12 to check")).toBeVisible();
    const latest = screen.getByRole("list", { name: "Latest findings" });
    expect(within(latest).getByText("Annual leave")).toBeVisible();
    expect(within(latest).getByText("Needs attention")).toBeVisible();
  });

  it("summarises a finished review and opens the full view", () => {
    const onOpen = vi.fn();
    render(<DocumentReviewCard onSummarise={vi.fn()} onOpen={onOpen} review={summary({
      status: "completed", headline: "Two clauses give you less than the law requires.",
      counts: { attention: 2, check: 1, fine: 5, unconfirmed: 0 },
      preview: [{ ref: "9.2", title: "Termination without notice", status: "attention" }],
    })} />);
    expect(screen.getByRole("heading", { name: "Two clauses give you less than the law requires." })).toBeVisible();
    const counts = screen.getByRole("list", { name: "Findings by status" });
    expect(within(counts).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Open full review" }));
    expect(onOpen).toHaveBeenCalledWith("review-1");
  });

  it("offers a retry after a failure", async () => {
    mocks.mutate.mockResolvedValue(null);
    render(<DocumentReviewCard onSummarise={vi.fn()} onOpen={vi.fn()} review={summary({ status: "failed", failure: "unreadable" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't read this document.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ reviewId: "review-1" }));
  });
});

const REVIEW_DATA = {
  review: summary({ status: "completed", roleLabel: "I'm the employee", focusLabels: ["Leave"], checkTotal: 3, headline: "One clause needs attention.", completedAt: 10 }),
  overview: "Clause 7.1 gives fewer leave days than the Act.",
  nextSteps: ["Ask for at least the legal minimum leave."],
  parties: [],
  partialCoverage: false,
  segments: [
    { ordinal: 0, ref: "7.1", heading: "7. Leave", text: "The Employee shall be entitled to seven (7) working days of paid leave.", page: 7, excerpt: false, checked: true },
    { ordinal: 1, ref: "8.1", text: "The Employee shall keep information confidential.", page: 7, excerpt: false, checked: true },
    { ordinal: 2, ref: "9.1", text: "Either party may end this agreement with one month's notice.", page: 8, excerpt: false, checked: true },
  ],
  findings: [
    { id: "f-fine", ordinal: 0, segmentOrdinal: 1, kind: "passage", status: "fine", title: "Confidentiality", meaning: "A normal duty.", lawSummary: "Allowed.", recommendation: "Nothing to change.", citations: [] },
    {
      id: "f-leave", ordinal: 1, segmentOrdinal: 0, kind: "passage", status: "attention", title: "Annual leave",
      meaning: "Fewer paid leave days than the minimum.", lawSummary: "The Act sets a minimum of 15 working days.", recommendation: "Ask for at least 15 days.",
      suggestedWording: "The Employee shall be entitled to fifteen (15) working days of paid leave.",
      citations: [{ label: "Labour Act, 2003 (Act 651)", provision: "Section 20", jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected", pageNumber: 12, previewable: true }],
    },
    { id: "f-gap", ordinal: 2, kind: "missing", status: "check", title: "No sick leave terms", meaning: "Sick leave isn't covered.", lawSummary: "The Act provides for sick leave.", recommendation: "Ask how sick leave works.", citations: [] },
  ],
};

describe("side-by-side review", () => {
  it("shows the document with highlighted parts and opens the most serious finding first", async () => {
    mocks.data = REVIEW_DATA;
    render(<DocumentReviewWorkspace reviewId={"review-1" as never} onClose={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Employment contract.pdf" })).toBeVisible();
    expect(screen.getByText("Reviewed for: I'm the employee · Ghana · 3 parts checked")).toBeVisible();
    const detail = screen.getByRole("article", { name: "Finding: Annual leave" });
    expect(within(detail).getByText("The Act sets a minimum of 15 working days.")).toBeVisible();
    fireEvent.click(within(detail).getByRole("button", { name: "Preview source: Labour Act, 2003 (Act 651), Section 20" }));
    expect(screen.getByRole("dialog", { name: "Source preview" })).toHaveTextContent("/api/document-reviews/review-1/sources/f-leave/0#page=12");

    const documentPane = screen.getByRole("region", { name: "Your document" });
    fireEvent.click(within(documentPane).getByRole("button", { name: /Looks fine: Confidentiality/u }));
    expect(screen.getByRole("article", { name: "Finding: Confidentiality" })).toBeVisible();
    // The clause with no finding stays plain text.
    expect(within(documentPane).getByText("Either party may end this agreement with one month's notice.").closest("button")).toBeNull();
  });

  it("filters findings and lists what is missing separately", () => {
    mocks.data = REVIEW_DATA;
    render(<DocumentReviewWorkspace reviewId={"review-1" as never} onClose={vi.fn()} onAsk={vi.fn()} />);
    const filters = screen.getByRole("navigation", { name: "Filter findings" });
    expect(within(filters).getByRole("button", { name: /Couldn't confirm/u })).toBeDisabled();
    fireEvent.click(within(filters).getByRole("button", { name: /Worth checking/u }));
    expect(screen.getByRole("article", { name: "Finding: No sick leave terms" })).toBeVisible();
    expect(screen.getByRole("region", { name: /Missing from the document/u })).toBeVisible();
    expect(screen.queryByRole("region", { name: /In the document/u })).toBeNull();
  });

  it("moves between findings and hands a follow-up question to the chat", () => {
    mocks.data = REVIEW_DATA;
    const onAsk = vi.fn();
    render(<DocumentReviewWorkspace reviewId={"review-1" as never} onClose={vi.fn()} onAsk={onAsk} />);
    expect(screen.getByText("1 of 3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Next/u }));
    expect(screen.getByRole("article", { name: "Finding: Confidentiality" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(onAsk).toHaveBeenCalledWith('Can you explain part 8.1 ("Confidentiality") in Employment contract.pdf, and what I can do about it?');
  });

  it("explains when a review can't be opened", () => {
    mocks.data = null;
    render(<DocumentReviewWorkspace reviewId={"review-1" as never} onClose={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "This review isn't available" })).toBeVisible();
  });
});

describe("review helpers", () => {
  it("builds an escaped, printable report", () => {
    const html = buildDocumentReviewReport({
      filename: "<b>contract</b>.pdf", focusLabels: [], jurisdictionName: "Ghana", nextSteps: [], partialCoverage: false,
      segments: REVIEW_DATA.segments, findings: REVIEW_DATA.findings as never, headline: "One clause needs attention.",
    });
    expect(html).toContain("&lt;b&gt;contract&lt;/b&gt;.pdf");
    expect(html).not.toContain("<b>contract</b>");
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("Looks fine"));
    expect(html).toContain("Labour Act, 2003 (Act 651), Section 20 (page 12)");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });

  it("reviews the first document, then text, then image", () => {
    const file = (id: string, kind: "document" | "text" | "image") => ({ id, kind, filename: id, mimeType: "x", byteSize: 1 });
    expect(pickReviewAttachment([file("photo", "image"), file("notes", "text"), file("lease", "document")])?.id).toBe("lease");
    expect(pickReviewAttachment([file("photo", "image"), file("notes", "text")])?.id).toBe("notes");
    expect(pickReviewAttachment([])).toBeNull();
  });

  it("asks about a missing term in plain words", () => {
    expect(askAboutFindingPrompt({ kind: "missing", title: "Sick leave" }, undefined, "contract.pdf"))
      .toBe('My contract.pdf doesn\'t seem to cover "Sick leave". What does the law say, and what should I ask for?');
  });
});
