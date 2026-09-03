import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogStatus, VersionHistory } from "./resource-register";

afterEach(cleanup);

describe("legal catalog register", () => {
  it("exposes lifecycle state in text rather than color alone", () => {
    render(<CatalogStatus status="ready_for_review" />);
    expect(screen.getByText("Ready for review")).toBeVisible();
  });

  it("renders bounded version metadata without file bodies", () => {
    render(
      <VersionHistory
        versions={[
          {
            id: "version_2",
            versionNumber: 2,
            filename: "constitution-1992.pdf",
            mimeType: "application/pdf",
            byteSize: 2048,
            sha256: "a".repeat(64),
            status: "published",
            createdAt: Date.UTC(2026, 0, 2),
          },
        ]}
      />,
    );
    expect(screen.getByRole("table", { name: "Document version history" })).toBeVisible();
    expect(screen.getByText("Version 2")).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.getByText(/application\/pdf \/ 2\.0 KB \/ SHA-256/)).toBeVisible();
    expect(screen.queryByText("document body")).toBeNull();
  });

  it("shows the approved durable publication messages", () => {
    render(
      <VersionHistory
        versions={[
          { id: "version_1", versionNumber: 1, filename: "v1.pdf", mimeType: "application/pdf", byteSize: 10, sha256: "a".repeat(64), status: "approved", failureSummary: "Publishing failed. No version was published.", createdAt: Date.UTC(2026, 0, 1) },
          { id: "version_2", versionNumber: 2, filename: "v2.pdf", mimeType: "application/pdf", byteSize: 10, sha256: "b".repeat(64), status: "publishing", createdAt: Date.UTC(2026, 0, 2) },
          { id: "version_3", versionNumber: 3, filename: "v3.pdf", mimeType: "application/pdf", byteSize: 10, sha256: "c".repeat(64), status: "publishing", failureSummary: "Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job.", createdAt: Date.UTC(2026, 0, 3) },
        ]}
      />,
    );
    expect(screen.getByText("Publishing failed. No version was published.")).toBeVisible();
    expect(screen.getByText("Gemini is indexing this document. You can leave this page; the status updates automatically.")).toBeVisible();
    expect(screen.getByText("Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job.")).toBeVisible();
    expect(screen.getByText("Indexing needs review")).toBeVisible();
  });
});
