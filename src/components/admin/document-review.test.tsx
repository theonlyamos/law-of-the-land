import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPermissionProvider } from "./permission-boundary";
import { DocumentReview } from "./document-review";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: { admin: { reviews: { approveVersion: "approve", rejectVersion: "reject" }, publication: {
    publishVersion: "publish", unpublishVersion: "unpublish", rollbackVersion: "rollback",
  } } },
}));
vi.mock("convex/react", () => ({ useMutation: (reference: string) => reference === "approve" ? mocks.approve : vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

afterEach(cleanup);
beforeEach(() => {
  mocks.approve.mockReset().mockResolvedValue({});
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
  effectiveDate: "2026-01-01",
  status: "ready_for_review" as const,
  stagingDocumentId: "gx-staging-2",
  stagingProcessId: "gx-process-2",
  xrayEvidence: {
    status: "complete" as const,
    documentId: "gx-staging-2",
    processId: "gx-process-2",
    fileType: "pdf",
    fileSize: 4096,
  },
  submittedBy: "manager-1",
  submittedAt: 1_700_000_000_000,
  previousVersion: { versionNumber: 1, filename: "act-843-v1.pdf", sha256: "b".repeat(64), effectiveDate: "2025-01-01" },
  decisions: [{ decision: "reject" as const, reviewerId: "reviewer-1", reason: "Citation mismatch", evaluationRunId: "eval-1", createdAt: 1_699_000_000_000 }],
};

describe("document review workbench", () => {
  it("shows safe evidence, body-free diff, immutable decisions, and reviewer actions", () => {
    render(<AdminPermissionProvider permissions={["document:review", "document:publish", "document:rollback"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    expect(screen.getByRole("heading", { name: "Data Protection Act" })).toBeVisible();
    expect(screen.getByText("Act 843")).toBeVisible();
    expect(screen.getByText(`SHA-256 ${"a".repeat(64)}`)).toBeVisible();
    expect(screen.getByRole("heading", { name: "X-Ray evidence" })).toBeVisible();
    expect(screen.getByText("gx-staging-2")).toBeVisible();
    expect(screen.getByText((_, node) =>
      node?.tagName === "P" && node.textContent?.includes("Complete / pdf / 4,096 bytes") === true,
    )).toBeVisible();
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
      "Official source authenticated", "Metadata is accurate", "X-Ray extraction reviewed", "Citations verified", "Search evaluation passed",
    ]) fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(screen.getByLabelText("Evaluation run ID"), { target: { value: "eval-2" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Evidence complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });

  it("labels missing provider evidence as unavailable instead of synthesizing it", () => {
    render(<AdminPermissionProvider permissions={["document:read"]}><DocumentReview items={[{
      ...item,
      id: "version_without_evidence",
      xrayEvidence: { status: "unavailable" as const },
    }]} /></AdminPermissionProvider>);
    expect(screen.getByText("Provider-derived X-Ray evidence is unavailable.")).toBeVisible();
    expect(screen.queryByText(/Complete \/ pdf \/ 4,096 bytes/)).toBeNull();
  });
});
