import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPermissionProvider } from "./permission-boundary";
import { DocumentReview } from "./document-review";

vi.mock("../../../convex/_generated/api", () => ({
  api: { admin: { reviews: { approveVersion: "approve", rejectVersion: "reject" }, publication: {
    publishVersion: "publish", unpublishVersion: "unpublish", rollbackVersion: "rollback",
  } } },
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

afterEach(cleanup);

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
    expect(screen.getByText(/SHA-256 a{12}/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "X-Ray evidence" })).toBeVisible();
    expect(screen.getByText("gx-staging-2")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Metadata-only version diff" })).toBeVisible();
    expect(screen.getByText(/Original file bodies are never loaded/)).toBeVisible();
    expect(screen.getByText("Citation mismatch")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve version" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject version" })).toBeVisible();
  });

  it("hides mutating controls from document readers", () => {
    render(<AdminPermissionProvider permissions={["document:read"]}><DocumentReview items={[item]} /></AdminPermissionProvider>);
    expect(screen.queryByRole("button", { name: "Approve version" })).toBeNull();
    expect(screen.getByText(/Read-only review evidence/)).toBeVisible();
  });
});
