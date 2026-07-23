import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAdminOverview: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({
  loadAdminOverview: mocks.loadAdminOverview,
}));
vi.mock("@/components/admin/admin-overview", () => ({
  AdminOverview: () => null,
}));
vi.mock("@/components/admin/permission-boundary", () => ({
  PermissionBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import AdminOverviewPage from "./page";

describe("admin overview page access", () => {
  beforeEach(() => {
    mocks.loadAdminOverview.mockReset();
    mocks.redirect.mockReset();
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("redirects when the page-level access check is denied", async () => {
    mocks.loadAdminOverview.mockResolvedValue({
      access: { status: "denied" },
      overview: null,
    });

    await expect(AdminOverviewPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
  });
});
