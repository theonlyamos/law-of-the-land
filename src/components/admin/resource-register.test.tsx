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
});
