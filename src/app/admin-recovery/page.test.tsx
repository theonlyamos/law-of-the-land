import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAdminRecoveryPage: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({
  authorizeAdminRecoveryPage: mocks.authorizeAdminRecoveryPage,
}));
vi.mock("@/components/admin/admin-recovery-control", () => ({
  AdminRecoveryControl: () => null,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import AdminRecoveryPage from "./page";

describe("admin recovery page access", () => {
  beforeEach(() => {
    mocks.authorizeAdminRecoveryPage.mockReset();
    mocks.redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("renders for an assured non-impersonated Super Admin while the persisted flag is off", async () => {
    mocks.authorizeAdminRecoveryPage.mockResolvedValue({
      status: "authorized",
      state: { environment: "preview", enabled: false },
    });

    await expect(AdminRecoveryPage()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects denied sessions outside the disabled /admin layout", async () => {
    mocks.authorizeAdminRecoveryPage.mockResolvedValue({ status: "denied" });

    await expect(AdminRecoveryPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
  });
});
