import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAdminRecoveryPage: vi.fn(),
  fetchAuthQuery: vi.fn(),
  adminControl: vi.fn(),
  redirect: vi.fn(),
  unifiedControl: vi.fn(),
}));

vi.mock("@/lib/admin/server", () => ({
  authorizeAdminRecoveryPage: mocks.authorizeAdminRecoveryPage,
}));
vi.mock("@/components/admin/admin-recovery-control", () => ({
  AdminRecoveryControl: (props: unknown) => {
    mocks.adminControl(props);
    return <div>Admin panel recovery available</div>;
  },
}));
vi.mock("@/components/admin/unified-jurisdictions-recovery-control", () => ({
  UnifiedJurisdictionsRecoveryControl: (props: unknown) => {
    mocks.unifiedControl(props);
    return null;
  },
}));
vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { api } from "../../../convex/_generated/api";
import AdminRecoveryPage from "./page";

const rollout = {
  environment: "preview",
  migrationVersion: "jurisdiction_ids_v1",
  flagEnabled: false,
  ghana: { ready: true, jurisdictionId: null, reasons: [] },
  targets: [],
  blockers: [],
  canEnable: true,
  legacyObservation: {
    active: false,
    generation: 0,
    startedAt: null,
    lastAcceptedAt: null,
    acceptedSinceStart: 0,
    zeroForMs: null,
  },
} as const;

afterEach(cleanup);

describe("admin recovery page access", () => {
  beforeEach(() => {
    mocks.authorizeAdminRecoveryPage.mockReset();
    mocks.fetchAuthQuery.mockReset().mockResolvedValue(rollout);
    mocks.adminControl.mockReset();
    mocks.redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    mocks.unifiedControl.mockReset();
  });

  it("loads unified rollout readiness for an assured non-impersonated Super Admin", async () => {
    mocks.authorizeAdminRecoveryPage.mockResolvedValue({
      status: "authorized",
      state: { environment: "preview", enabled: false },
    });

    render(await AdminRecoveryPage());
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.fetchAuthQuery).toHaveBeenCalledWith(
      api.admin.featureFlags.getUnifiedJurisdictionRolloutState,
      {},
    );
    expect(mocks.unifiedControl).toHaveBeenCalledWith({ rollout });
  });

  it("redirects denied sessions outside the disabled /admin layout", async () => {
    mocks.authorizeAdminRecoveryPage.mockResolvedValue({ status: "denied" });

    await expect(AdminRecoveryPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });

  it("keeps admin-panel recovery available when rollout readiness cannot load", async () => {
    mocks.authorizeAdminRecoveryPage.mockResolvedValue({
      status: "authorized",
      state: { environment: "preview", enabled: false },
    });
    mocks.fetchAuthQuery.mockRejectedValue(new Error("rollout unavailable"));

    render(await AdminRecoveryPage());

    expect(mocks.adminControl).toHaveBeenCalledWith({
      environment: "preview",
      enabled: false,
    });
    expect(screen.getByText("Admin panel recovery available")).toBeInTheDocument();
    expect(screen.getByText("Unified jurisdictions unavailable")).toBeInTheDocument();
    expect(mocks.unifiedControl).not.toHaveBeenCalled();
  });
});
