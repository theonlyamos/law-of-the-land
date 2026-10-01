import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../../../../convex/_generated/api";

const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/components/admin/catalog-actions", () => ({ ResourceEditor: () => null }));
vi.mock("@/components/admin/document-upload", () => ({ DocumentUpload: () => null }));
import ResourceDetailPage from "./page";

const resource = {
  _id: "resource_1", title: "Labour Act", status: "active", jurisdictionId: "ghana", type: "act",
  jurisdiction: { code: "GH", name: "Ghana" }, officialCitation: "Act 651", issuer: "Parliament",
  effectiveDate: "2003-01-01", topics: [], sourceUrl: "https://example.gov/act",
};
const version = { _id: "latest_version", versionNumber: 2, filename: "latest.pdf", mimeType: "application/pdf", byteSize: 100, sha256: "a".repeat(64), status: "unpublished", createdAt: 2 };
beforeEach(() => {
  mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { roles: ["auditor"] } });
  mocks.fetchAuthQuery.mockReset();
});
afterEach(cleanup);

it("links the latest uploaded original even when an older version is published", async () => {
  mocks.fetchAuthQuery.mockResolvedValueOnce(resource).mockResolvedValueOnce({
    page: [version, { ...version, _id: "older_version", versionNumber: 1, filename: "older.pdf", status: "published", createdAt: 1 }],
  });
  render(await ResourceDetailPage({ params: Promise.resolve({ resourceId: resource._id }) }));
  const link = screen.getByRole("link", { name: "View latest uploaded file for Labour Act, version 2" });
  expect(mocks.fetchAuthQuery).toHaveBeenNthCalledWith(2, api.admin.resources.listVersions, { resourceId: resource._id, paginationOpts: { numItems: 50, cursor: null } });
  expect(link).toHaveAttribute("href", "/api/admin/review-files/latest_version");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getAllByRole("link", { name: /View latest uploaded file/ })).toHaveLength(1);
  expect(screen.getByRole("table", { name: "Document version history" })).toBeVisible();
});

it("omits file viewing when no versions have been uploaded", async () => {
  mocks.fetchAuthQuery.mockResolvedValueOnce(resource).mockResolvedValueOnce({ page: [] });
  render(await ResourceDetailPage({ params: Promise.resolve({ resourceId: resource._id }) }));
  expect(screen.queryByRole("link", { name: /View latest uploaded file/ })).not.toBeInTheDocument();
  expect(screen.getByText(/No document versions have been recorded/)).toBeVisible();
});
