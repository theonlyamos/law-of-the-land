import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), data: undefined as unknown, usage: null as unknown }));
vi.mock("convex/react", () => ({
  useMutation: () => mocks.mutate,
  useQuery: (_query: unknown, args: unknown) => (args && typeof args === "object" && "draftId" in args ? mocks.data : mocks.usage),
}));
vi.mock("@/components/chat/citation-source-preview", () => ({
  CitationSourcePreview: ({ source }: { source: { label: string; originalUrl?: string } }) => <div role="dialog" aria-label="Source preview">{source.label} {source.originalUrl}</div>,
}));
const exportMock = vi.hoisted(() => ({ exportDraft: vi.fn() }));
vi.mock("./draft-export", async (original) => ({ ...(await original<typeof import("./draft-export")>()), exportDraft: exportMock.exportDraft }));

import { DocumentDraftCard, type DocumentDraftSummary } from "./document-draft-card";
import { DocumentDraftWorkspace, askAboutClausePrompt } from "./document-draft-workspace";
import { toExportDocument, type DraftData } from "./draft-export";

afterEach(() => { cleanup(); mocks.mutate.mockReset(); exportMock.exportDraft.mockReset(); mocks.data = undefined; mocks.usage = null; });

function summary(overrides: Partial<DocumentDraftSummary> = {}): DocumentDraftSummary {
  return {
    id: "draft-1" as DocumentDraftSummary["id"],
    userClientId: "user-1",
    request: "Draft a tenancy agreement",
    status: "awaiting_input",
    documentType: "Tenancy agreement",
    title: "Tenancy Agreement",
    summary: "A one-year tenancy for a flat.",
    isLegalDocument: true,
    roleOptions: [{ id: "landlord", label: "Landlord" }, { id: "tenant", label: "Tenant" }],
    suggestedRoleId: "tenant",
    suggestedAudience: "personal",
    questions: [
      { id: "rent", label: "Monthly rent", kind: "number", options: [], suggested: "GH₵ 2,000" },
      { id: "water", label: "Who pays for water?", kind: "choice", options: ["Landlord", "Tenant"] },
    ],
    sectionCount: 12,
    startRequested: false,
    draftedCount: 0,
    draftTotal: 0,
    placeholderCount: 0,
    preview: [],
    jurisdictionName: "Ghana",
    version: 1,
    createdAt: 1,
    ...overrides,
  };
}

function draftData(): DraftData {
  return {
    draft: summary({ status: "completed", audience: "professional", roleLabel: "Landlord", counts: { required: 1, protects: 0, common: 1, choice: 1 }, placeholderCount: 1, version: 2 }),
    answers: [],
    formalities: [{ title: "Stamp the agreement", detail: "Pay stamp duty.", basis: "required", citations: [{ label: "Stamp Duty Act", provision: "s. 2" }] }],
    partialCoverage: false,
    clauses: [
      { id: "c0", ordinal: 0, kind: "opening", heading: "Parties", text: "Between [Landlord's name] and the tenant.", basis: "choice", why: "Names the parties.", lawSummary: "", citations: [], edited: false, revising: false, revisionFailed: false },
      { id: "c1", ordinal: 1, kind: "clause", heading: "Rent", text: "Rent is GH₵ 2,000.\n(a) Paid monthly.", basis: "required", why: "Caps advance rent.", lawSummary: "Advance rent is limited.",
        citations: [{ label: "Rent Act", provision: "s. 25", jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected", pageNumber: 4, previewable: true }], edited: false, revising: false, revisionFailed: false },
    ] as unknown as DraftData["clauses"],
  };
}

describe("document draft card", () => {
  it("asks who the document is for, who is drafting and the details, then starts drafting", async () => {
    mocks.mutate.mockResolvedValue(null);
    render(<DocumentDraftCard draft={summary()} onOpen={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Tenancy Agreement" })).toBeVisible();
    const sides = screen.getByRole("group", { name: "Who is this document for?" });
    expect(within(sides).getByRole("radio", { name: "Tenant" })).toBeChecked();
    fireEvent.click(within(sides).getByRole("radio", { name: "Landlord" }));
    fireEvent.click(screen.getByRole("radio", { name: "A legal professional" }));
    expect(screen.getByLabelText("Monthly rent")).toHaveValue("GH₵ 2,000");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Who pays for water?" })).getByRole("radio", { name: "Tenant" }));
    fireEvent.change(screen.getByLabelText(/Anything else/u), { target: { value: "No pets." } });
    fireEvent.click(screen.getByRole("button", { name: "Draft document" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({
      draftId: "draft-1", roleId: "landlord", audience: "professional",
      answers: [{ questionId: "rent", value: "GH₵ 2,000" }, { questionId: "water", value: "Tenant" }],
      instructions: "No pets.",
    }));
  });

  it("shows progress and a finished summary with blanks to fill", () => {
    const { rerender } = render(<DocumentDraftCard draft={summary({ status: "drafting", draftedCount: 3, draftTotal: 12, preview: [{ heading: "Rent", basis: "required" }] })} onOpen={vi.fn()} />);
    expect(screen.getByRole("progressbar", { name: "Parts drafted" })).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByText("Required by law")).toBeVisible();
    const onOpen = vi.fn();
    rerender(<DocumentDraftCard draft={summary({ status: "completed", counts: { required: 2, protects: 1, common: 3, choice: 2 }, placeholderCount: 4 })} onOpen={onOpen} />);
    expect(screen.getByText("4 blanks to fill in before it is used.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Open document/u }));
    expect(onOpen).toHaveBeenCalledWith("draft-1");
  });
});

describe("document draft workspace", () => {
  it("shows each clause with its basis and sources, and edits a clause", async () => {
    mocks.data = draftData();
    mocks.mutate.mockResolvedValue(null);
    render(<DocumentDraftWorkspace draftId={"draft-1" as never} onClose={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getByText("1. Rent")).toBeVisible();
    fireEvent.click(screen.getByText("1. Rent"));
    const detail = screen.getByRole("article", { name: "Clause: 1. Rent" });
    fireEvent.click(within(detail).getByRole("button", { name: "Preview source: Rent Act, s. 25" }));
    expect(screen.getByRole("dialog", { name: "Source preview" })).toHaveTextContent("/api/document-drafts/draft-1/sources/c1/0#page=4");
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(detail).getByLabelText("Wording"), { target: { value: "Rent is GH₵ 2,500." } });
    fireEvent.click(within(detail).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ clauseId: "c1", heading: "Rent", text: "Rent is GH₵ 2,500." }));
    fireEvent.click(screen.getByRole("tab", { name: /Before you sign/u }));
    expect(screen.getByText("Stamp the agreement")).toBeVisible();
  });

  it("exports a watermarked PDF on the free plan and keeps Word for Pro", async () => {
    mocks.data = draftData();
    mocks.usage = { billingEnabled: true, isPro: false };
    exportMock.exportDraft.mockResolvedValue(undefined);
    render(<DocumentDraftWorkspace draftId={"draft-1" as never} onClose={vi.fn()} onAsk={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const panel = screen.getByRole("dialog", { name: "Export document" });
    expect(within(panel).getByRole("radio", { name: /Word/u })).toBeDisabled();
    fireEvent.click(within(panel).getByRole("radio", { name: /Classic/u }));
    fireEvent.click(within(panel).getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(exportMock.exportDraft).toHaveBeenCalledWith(mocks.data, "pdf",
      { style: "classic", paper: "a4", includeCover: true, includeNotes: false, watermark: true }));
  });

  it("maps a draft to the export model", () => {
    const document = toExportDocument(draftData(), { style: "modern", paper: "a4", includeCover: true, includeNotes: true, watermark: false }, 5);
    expect(document).toMatchObject({ title: "Tenancy Agreement", sideLabel: "Landlord", audience: "professional", version: 2, preparedAt: 5 });
    expect(document.clauses[1]).toMatchObject({ kind: "clause", basisLabel: "Required by law", sources: ["Rent Act, s. 25"] });
    expect(document.formalities).toEqual([{ title: "Stamp the agreement", detail: "Pay stamp duty.", required: true, sources: ["Stamp Duty Act, s. 2"] }]);
    expect(askAboutClausePrompt({ heading: "Rent" }, "Tenancy Agreement")).toContain('"Rent" clause');
  });
});
