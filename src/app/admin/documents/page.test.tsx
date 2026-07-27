import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";

const mocks = vi.hoisted(() => ({
  authorizeAdminPage: vi.fn(),
  fetchAuthQuery: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/admin/catalog-actions", () => ({
  ResourceEditor: () => <section aria-label="Resource editor" />,
}));

import DocumentsPage from "./page";

beforeEach(() => {
  mocks.authorizeAdminPage.mockReset();
  mocks.fetchAuthQuery.mockReset();
  mocks.redirect.mockReset();
  mocks.authorizeAdminPage.mockResolvedValue({
    status: "authorized",
    currentAdmin: { userId: "manager_1", roles: ["content_manager"] },
  });
});

afterEach(cleanup);

describe("document catalog jurisdiction picker", () => {
  it("loads a bounded initial jurisdiction page", async () => {
    mocks.fetchAuthQuery
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" })
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" });

    render(await DocumentsPage({ searchParams: Promise.resolve({}) }));

    expect(mocks.fetchAuthQuery).toHaveBeenNthCalledWith(
      2,
      api.admin.resources.listJurisdictions,
      { paginationOpts: { numItems: 25, cursor: null } },
    );
    expect(screen.getByRole("heading", { name: "Documents" })).toBeVisible();
  });

  it("forwards exact-code search and cursor state to the bounded query", async () => {
    mocks.fetchAuthQuery
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" })
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" });

    render(await DocumentsPage({ searchParams: Promise.resolve({
      jurisdictionCode: "GH",
      jurisdictionCursor: "jurisdictions-25",
    }) }));

    expect(mocks.fetchAuthQuery).toHaveBeenNthCalledWith(
      2,
      api.admin.resources.listJurisdictions,
      {
        paginationOpts: { numItems: 25, cursor: "jurisdictions-25" },
        code: "GH",
      },
    );
  });
});
