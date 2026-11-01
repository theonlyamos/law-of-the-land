import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPermissionProvider } from "./permission-boundary";
import { DocumentReview } from "./document-review";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  correct: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: { admin: { sourceVerification: { recordCorrection: "correct" }, reviews: { approveVersion: "approve", rejectVersion: "reject" }, publication: {
    publishVersion: "publish", unpublishVersion: "unpublish", rollbackVersion: "rollback",
  } } },
}));
vi.mock("convex/react", () => ({ useMutation: (reference: string) => reference === "approve" ? mocks.approve : reference === "reject" ? mocks.reject : reference === "correct" ? mocks.correct : reference === "publish" ? mocks.publish : reference === "rollback" ? mocks.rollback : vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  mocks.approve.mockReset().mockResolvedValue({});
  mocks.reject.mockReset().mockResolvedValue({});
  mocks.correct.mockReset().mockResolvedValue({});
  mocks.publish.mockReset().mockResolvedValue({});
  mocks.rollback.mockReset().mockResolvedValue({});
  mocks.refresh.mockReset();
});

const item = {
  id: "version_2",
  resourceTitle: "Data Protection Act",
  officialCitation: "Act 843",
  versionNumber: 2,
  filename: "act-843-v2.pdf",
  mimeType: "application/pdf",
  byteSize: 1240,
  sha256: "a".repeat(64),
  sourceHost: "laws.example.gov",
  sourceUrl: "https://laws.example.gov/act-843.pdf",
  effectiveDate: "2026-01-01",
  status: "ready_for_review" as const,
  submittedBy: "manager-1",
  submittedAt: 1_700_000_000_000,
  previousVersion: { versionNumber: 1, filename: "act-843-v1.pdf", sha256: "b".repeat(64), effectiveDate: "2025-01-01" },
  decisions: [{ decision: "reject" as const, reviewerId: "reviewer-1", reason: "Citation mismatch", evaluationRunId: "eval-1", createdAt: 1_699_000_000_000 }],
};

const verificationNotes = "Compared the complete original, case citation, and current later-treatment records; evidence and any limits recorded here.";
function fillSource(sourceClass = "official_hosted", complete = true) {
  fireEvent.change(screen.getByLabelText("Source classification"), { target: { value: sourceClass } });
  fireEvent.change(screen.getByLabelText("Verification notes"), { target: { value: verificationNotes } });
  if (sourceClass === "corroborated_reproduction") fireEvent.change(screen.getByLabelText("Corroborating URLs (one per line)"), { target: { value: "https://judicial.example.org/case-record" } });
  if (complete) for (const label of ["Complete original verified", "Case citation checked against the source", "Later treatment checked and recorded in the notes"]) fireEvent.click(screen.getByLabelText(label));
}

describe("document review workbench", () => {
  it("leaves every verification assertion unchecked when a version is opened", () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, requiresSourceVerification: true }]} /></AdminPermissionProvider>);
    const assertions = screen.getAllByRole("checkbox");
    expect(assertions).toHaveLength(8);
    for (const assertion of assertions) expect(assertion).not.toBeChecked();
    expect(screen.getByLabelText("Evaluation run ID")).toHaveValue("");
    expect(screen.getByLabelText("Decision reason")).toHaveValue("");
    expect(screen.getByLabelText("Source classification")).toHaveValue("");
    expect(screen.getByLabelText("Actual source URL")).toHaveValue(item.sourceUrl);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("shows third-party provenance verbatim without asserting official hosting or review", () => {
    const sourceProvenance = "Court judgment reproduced by Example Law Firm; downloaded from the firm's public case archive. Authenticity requires comparison with the court record.";
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, sourceHost: "example-lawfirm.com", sourceUrl: "https://example-lawfirm.com/judgments/case.pdf", sourceProvenance, caseAliases: ["Mensah v Mensah", "Case J4/20/2010"] }]} /></AdminPermissionProvider>);
    expect(screen.getByText(sourceProvenance)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Uploaded court text" })).toBeVisible();
    expect(screen.getByText("Source host")).toBeVisible();
    expect(screen.queryByText("Official source host")).toBeNull();
    expect(screen.getByRole("link", { name: "Open recorded source" })).toHaveAttribute("href", "https://example-lawfirm.com/judgments/case.pdf");
    expect(screen.getByText(/Mensah v Mensah; Case J4\/20\/2010/)).toBeVisible();
    for (const assertion of screen.getAllByRole("checkbox")) expect(assertion).not.toBeChecked();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires publication acknowledgement and keeps the typed phrase without password verification", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<AdminPermissionProvider permissions={["document:publish"]}><DocumentReview items={[{ ...item, status: "approved" }]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(screen.queryByLabelText("Confirm your password")).toBeNull();
    expect(screen.getByText("PUBLISH version_2")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Reason for this action"), { target: { value: "Publish reviewed version" } });
    fireEvent.change(screen.getByLabelText("Exact confirmation"), { target: { value: "PUBLISH version_2" } });
    const acknowledgement = screen.getByRole("checkbox", { name: "I confirm this is the version I intend to publish." });
    expect(acknowledgement).toBeRequired();
    expect(acknowledgement).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Queue publish" }));
    expect(mocks.publish).not.toHaveBeenCalled();
    fireEvent.click(acknowledgement);
    fireEvent.click(screen.getByRole("button", { name: "Queue publish" }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    expect(mocks.publish).toHaveBeenCalledWith({
      versionId: "version_2", confirmation: "PUBLISH version_2", reason: "Publish reviewed version", idempotencyKey: expect.any(String),
    });
    expect(fetch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["published", "Unpublish version", "UNPUBLISH"],
    ["superseded", "Roll back to version", "ROLLBACK"],
  ] as const)("keeps password confirmation for %s versions", (status, button, phrase) => {
    render(<AdminPermissionProvider permissions={["document:publish", "document:rollback"]}><DocumentReview items={[{ ...item, status }]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByLabelText("Confirm your password")).toBeRequired();
    expect(screen.getByText(phrase + " version_2")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows queued publication without offering another publication action", () => {
    render(<AdminPermissionProvider permissions={["document:publish", "document:rollback"]}><DocumentReview items={[{ ...item, status: "publishing" }]} /></AdminPermissionProvider>);
    expect(screen.getByText("Queued for publishing")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Publish version|Roll back/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View publishing jobs" })).toHaveAttribute("href", "/admin/operations");
  });

  it("distinguishes a blocked publication from normal indexing", () => {
    render(<DocumentReview items={[{ ...item, status: "publishing", failureSummary: "Search is paused until this job is reviewed." }]} />);
    expect(screen.getByText("Publishing needs review")).toBeVisible();
    expect(screen.getByText("Search is paused until this job is reviewed.")).toBeVisible();
  });

  it("shows safe evidence, body-free diff, immutable decisions, and reviewer actions", () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:publish", "document:rollback"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    expect(screen.getByRole("heading", { name: "Data Protection Act" })).toBeVisible();
    expect(screen.getByText("Act 843")).toBeVisible();
    expect(screen.getByRole("link", { name: "View uploaded file for Data Protection Act, version 2" })).toHaveAttribute("href", "/api/admin/review-files/version_2");
    expect(screen.getByText(`SHA-256 ${"a".repeat(64)}`)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "X-Ray evidence" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Metadata-only version diff" })).toBeVisible();
    expect(screen.getByText(/Original file bodies are never loaded/)).toBeVisible();
    expect(screen.getByText("Changed")).toBeVisible();
    expect(screen.getByText(`Previous SHA-256 ${"b".repeat(64)}`)).toBeVisible();
    expect(screen.getByText(`Current SHA-256 ${"a".repeat(64)}`)).toBeVisible();
    expect(screen.getByText("Citation mismatch")).toBeVisible();
    expect(JSON.stringify(document.body.textContent)).not.toContain("xrayUrl");
    expect(screen.getByRole("button", { name: "Approve version" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject version" })).toBeVisible();
  });

  it("hides mutating controls from document readers", () => {
    render(<AdminPermissionProvider permissions={["document:read"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    expect(screen.queryByRole("button", { name: "Approve version" })).toBeNull();
    expect(screen.getByText(/Read-only review evidence/)).toBeVisible();
  });

  it("refreshes server-rendered review items after recording a decision", async () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    for (const label of [
      "Official source authenticated", "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed",
    ]) fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(screen.getByLabelText("Evaluation run ID"), { target: { value: "eval-2" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Evidence complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve.mock.calls[0][0]).not.toHaveProperty("sourceVerification");
  });

  it("blocks approval without an explicit classification and complete source evidence", async () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, requiresSourceVerification: true }]} /></AdminPermissionProvider>);
    const form = screen.getByRole("button", { name: "Approve version" }).closest("form")!;
    fireEvent.submit(form);
    expect(await screen.findByRole("status")).toHaveTextContent("Choose how this source was verified");
    fillSource("official_hosted", false);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Verify the complete original, citation, and later treatment"));
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("records explicit official-source evidence for a judgment approval", async () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, requiresSourceVerification: true }]} /></AdminPermissionProvider>);
    fillSource();
    for (const label of ["Official source authenticated", "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed"]) fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(screen.getByLabelText("Evaluation run ID"), { target: { value: "real-official-evaluation" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Official source evidence verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({ sourceVerification: {
      sourceClass: "official_hosted", sourceUrl: item.sourceUrl, verificationNotes, corroboratingUrls: [], completeOriginal: true, citationChecked: true, laterTreatmentChecked: true,
    } }));
  });

  it("keeps the existing five-check workflow for ordinary acts and notices", () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    expect(screen.queryByLabelText("Source classification")).toBeNull();
    expect(screen.getByLabelText("Official source authenticated")).not.toBeChecked();
  });

  it("requires independent corroboration for reproduction approval and resets authenticity on class changes", async () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, requiresSourceVerification: true, sourceUrl: "https://example-lawfirm.com/case.pdf" }]} /></AdminPermissionProvider>);
    fillSource("corroborated_reproduction");
    expect(screen.getByLabelText("Reproduction authenticity independently corroborated")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Reproduction authenticity independently corroborated"));
    fireEvent.change(screen.getByLabelText("Source classification"), { target: { value: "official_hosted" } });
    expect(screen.getByLabelText("Official source authenticated")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Source classification"), { target: { value: "corroborated_reproduction" } });
    expect(screen.getByLabelText("Reproduction authenticity independently corroborated")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Corroborating URLs (one per line)"), { target: { value: "https://example-lawfirm.com/other-page" } });
    const form = screen.getByRole("button", { name: "Approve version" }).closest("form")!;
    fireEvent.submit(form);
    expect(await screen.findByRole("status")).toHaveTextContent("at least one independent corroborating source");
    expect(mocks.approve).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Corroborating URLs (one per line)"), { target: { value: "https://judicial.example.org/case-record" } });
    for (const label of ["Complete original verified", "Case citation checked against the source", "Later treatment checked and recorded in the notes"]) fireEvent.click(screen.getByLabelText(label));
    for (const label of ["Reproduction authenticity independently corroborated", "Metadata is accurate", "Original text reviewed", "Citations verified", "Search evaluation passed"]) fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(screen.getByLabelText("Evaluation run ID"), { target: { value: "real-eval-3" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Independent evidence verified" } });
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({ sourceVerification: expect.objectContaining({ sourceClass: "corroborated_reproduction", corroboratingUrls: ["https://judicial.example.org/case-record"] }) }));
  });

  it("allows rejection without inventing source evidence", async () => {
    render(<AdminPermissionProvider permissions={["document:review"]}><DocumentReview items={[{ ...item, requiresSourceVerification: true }]} /></AdminPermissionProvider>);
    fireEvent.change(screen.getByLabelText("Evaluation run ID"), { target: { value: "real-eval-4" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Source remains unresolved" } });
    const reject = screen.getByRole("button", { name: "Reject version" }) as HTMLButtonElement;
    fireEvent(reject.form!, new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: reject }));
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledTimes(1));
    expect(mocks.reject.mock.calls[0][0]).not.toHaveProperty("sourceVerification");
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("appends a verified correction once while preserving earlier decisions and history", async () => {
    const oldRecord = { sourceClass: "official_hosted" as const, sourceUrl: item.sourceUrl, verificationNotes: "Earlier verification notes retained without editing.", corroboratingUrls: [], completeOriginal: true, citationChecked: true, laterTreatmentChecked: true, kind: "approval" as const, assessment: "verified" as const, reviewerId: "original-reviewer", reason: "Earlier assertion", createdAt: 1_700_000_000_000 };
    const approved = { ...item, status: "published" as const, sourceUrl: "https://example-lawfirm.com/case.pdf", sourceVerifications: [oldRecord] };
    const { rerender } = render(<AdminPermissionProvider permissions={["document:review", "document:publish"]}><DocumentReview items={[approved]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Record source correction" }));
    expect(screen.getByLabelText("Correction assessment")).toHaveValue("");
    expect(screen.queryByRole("option", { name: /Unresolved/ })).toBeNull();
    expect(screen.getByText(/unpublish the document through the guarded action above/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Unpublish version" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Correction assessment"), { target: { value: "verified" } });
    fillSource("corroborated_reproduction");
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Correct hosting classification using independent evidence" } });
    const form = screen.getByRole("button", { name: "Append source correction" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledTimes(1));
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({ assessment: "verified", versionId: item.id, sourceVerification: expect.objectContaining({ sourceClass: "corroborated_reproduction" }) }));
    expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    const correctedRecord = { ...oldRecord, ...mocks.correct.mock.calls[0][0].sourceVerification, kind: "correction" as const, reviewerId: "correcting-reviewer", reason: "Correct hosting classification using independent evidence", createdAt: 1_700_000_100_000 };
    rerender(<AdminPermissionProvider permissions={["document:review", "document:publish"]}><DocumentReview items={[{ ...approved, sourceVerifications: [correctedRecord, oldRecord] }]} /></AdminPermissionProvider>);
    expect(screen.getByText("Earlier verification notes retained without editing.")).toBeVisible();
    expect(screen.getByText("Citation mismatch")).toBeVisible();
    expect(screen.getByText(verificationNotes)).toBeVisible();
    expect(screen.getByText("Source host")).toBeVisible();
    expect(screen.queryByText("Official source host")).toBeNull();
    expect(screen.getByRole("heading", { name: "Uploaded court text" })).toBeVisible();
  });

  it("records unresolved evidence only on an unpublished version without checking assertions", async () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:publish"]}><DocumentReview items={[{ ...item, status: "unpublished" }]} /></AdminPermissionProvider>);
    expect(screen.queryByRole("button", { name: /Publish version|Roll back to version/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Record source correction" }));
    fireEvent.change(screen.getByLabelText("Correction assessment"), { target: { value: "unresolved" } });
    fireEvent.change(screen.getByLabelText("Source classification"), { target: { value: "corroborated_reproduction" } });
    fireEvent.change(screen.getByLabelText("Verification notes"), { target: { value: "Unable to corroborate the reproduction or establish completeness and later treatment; remains unpublished." } });
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Record unresolved source uncertainty" } });
    fireEvent.click(screen.getByRole("button", { name: "Append source correction" }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledTimes(1));
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({ assessment: "unresolved", sourceVerification: expect.objectContaining({ completeOriginal: false, citationChecked: false, laterTreatmentChecked: false, corroboratingUrls: [] }) }));
    expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("makes approval withdrawal explicit before recording unresolved source evidence", async () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:publish"]}><DocumentReview items={[{ ...item, status: "approved" }]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Record source correction" }));
    fireEvent.change(screen.getByLabelText("Correction assessment"), { target: { value: "unresolved" } });
    expect(screen.getByText(/withdraws the current approval and returns this version for fresh review/)).toBeVisible();
    expect(screen.getByRole("option", { name: "Reproduction requiring verification" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Source classification"), { target: { value: "corroborated_reproduction" } });
    fireEvent.change(screen.getByLabelText("Verification notes"), { target: { value: "Source remains uncertain; completeness and later treatment require independent investigation." } });
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Withdraw approval pending source verification" } });
    fireEvent.click(screen.getByRole("button", { name: "Append source correction" }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledTimes(1));
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({ assessment: "unresolved", sourceVerification: expect.objectContaining({ completeOriginal: false, citationChecked: false, laterTreatmentChecked: false, corroboratingUrls: [] }) }));
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("describes unresolved reproduction history without claiming corroboration", () => {
    const unresolved = { sourceClass: "corroborated_reproduction" as const, sourceUrl: item.sourceUrl, verificationNotes: "No independent evidence was found; authenticity remains unresolved.", corroboratingUrls: [], completeOriginal: false, citationChecked: false, laterTreatmentChecked: false, kind: "correction" as const, assessment: "unresolved" as const, reviewerId: "reviewer", reason: "Unresolved source", createdAt: 1_700_000_000_000 };
    render(<DocumentReview items={[{ ...item, status: "unpublished", sourceVerifications: [unresolved] }]} />);
    expect(screen.getByText(/Reproduction - verification unresolved/)).toBeVisible();
    expect(screen.queryByText(/Independently corroborated reproduction/)).toBeNull();
  });

  it.each([["document:review"], ["document:rollback"]])("hides superseded correction without both review and rollback permissions: %j", (...permissions) => {
    render(<AdminPermissionProvider permissions={permissions}><DocumentReview items={[{ ...item, status: "superseded" }]} /></AdminPermissionProvider>);
    expect(screen.queryByRole("button", { name: "Record source correction" })).toBeNull();
    expect(mocks.correct).not.toHaveBeenCalled();
  });

  it("records verified superseded evidence without rolling back or replacing prior history", async () => {
    const oldRecord = { sourceClass: "official_hosted" as const, sourceUrl: item.sourceUrl, verificationNotes: "Prior source evidence must remain in the history.", corroboratingUrls: [], completeOriginal: true, citationChecked: true, laterTreatmentChecked: true, kind: "approval" as const, assessment: "verified" as const, reviewerId: "earlier-reviewer", reason: "Earlier source review", createdAt: 1_700_000_000_000 };
    const superseded = { ...item, status: "superseded" as const, sourceUrl: "https://example-lawfirm.com/case.pdf", sourceVerifications: [oldRecord] };
    const permissions = ["document:review", "document:rollback"];
    const { rerender } = render(<AdminPermissionProvider permissions={permissions}><DocumentReview items={[superseded]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Record source correction" }));
    expect(screen.getByText(/Use the separate guarded rollback action after the evidence is recorded/)).toBeVisible();
    expect(screen.getByLabelText("Correction assessment")).toHaveValue("");
    expect(screen.queryByRole("option", { name: /Unresolved/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Correction assessment"), { target: { value: "verified" } });
    fillSource("corroborated_reproduction");
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Record verified source before considering rollback" } });
    fireEvent.click(screen.getByRole("button", { name: "Append source correction" }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledTimes(1));
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({ versionId: item.id, assessment: "verified", sourceVerification: expect.objectContaining({ completeOriginal: true, citationChecked: true, laterTreatmentChecked: true, sourceClass: "corroborated_reproduction" }) }));
    const correction = { ...oldRecord, ...mocks.correct.mock.calls[0][0].sourceVerification, kind: "correction" as const, reviewerId: "correcting-reviewer", reason: "Record verified source before considering rollback", createdAt: 1_700_000_100_000 };
    rerender(<AdminPermissionProvider permissions={permissions}><DocumentReview items={[{ ...superseded, sourceVerifications: [correction, oldRecord] }]} /></AdminPermissionProvider>);
    expect(screen.getByText("Prior source evidence must remain in the history.")).toBeVisible();
    expect(screen.getByText("Citation mismatch")).toBeVisible();
    expect(screen.getByText(verificationNotes)).toBeVisible();
    expect(screen.getByText("superseded", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Roll back to version" })).toBeVisible();
    expect(mocks.rollback).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("blocks incomplete superseded source corrections before calling a mutation", async () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:rollback"]}><DocumentReview items={[{ ...item, status: "superseded" }]} /></AdminPermissionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Record source correction" }));
    fireEvent.change(screen.getByLabelText("Correction assessment"), { target: { value: "verified" } });
    fillSource("official_hosted", false);
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Verification remains incomplete" } });
    fireEvent.click(screen.getByRole("button", { name: "Append source correction" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Verify the complete original, citation, and later treatment");
    expect(mocks.correct).not.toHaveBeenCalled(); expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it("keeps superseded correction hidden for scoped actions without an authorized correction operation", () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:rollback"]}><DocumentReview items={[{ ...item, status: "superseded" }]} canReview actions={{ approve: mocks.approve, reject: mocks.reject, publish: mocks.publish, unpublish: vi.fn(), rollback: mocks.rollback }} /></AdminPermissionProvider>);
    expect(screen.queryByRole("button", { name: "Record source correction" })).toBeNull();
  });

});
