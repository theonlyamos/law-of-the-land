import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedJurisdictionRolloutState } from "../../../convex/lib/unifiedJurisdictionRollout";

const mutation = vi.fn();
vi.mock("convex/react", () => ({ useMutation: () => mutation }));

import { UnifiedJurisdictionsRecoveryControl } from "./unified-jurisdictions-recovery-control";

const readyRollout: UnifiedJurisdictionRolloutState = {
  environment: "preview",
  migrationVersion: "jurisdiction_ids_v1",
  flagEnabled: false,
  ghana: { ready: true, jurisdictionId: null, reasons: [] },
  targets: [
    { target: "chatSessions", status: "verified", processed: 1, updated: 0, unresolved: 0, mismatches: 0, runNumber: 2, verifiedAt: 1 },
  ],
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
};

afterEach(cleanup);

describe("unified-jurisdictions recovery control", () => {
  beforeEach(() => {
    mutation.mockReset().mockResolvedValue({
      environment: "preview",
      enabled: true,
      correlationId: "op_unified_recovery",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000021",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("binds the unified flag mutation to a fresh scoped password proof", async () => {
    render(<UnifiedJurisdictionsRecoveryControl rollout={readyRollout} />);

    expect(screen.getByText("Ready to enable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", {
      name: "Enable unified jurisdictions",
    }));
    fireEvent.change(screen.getByLabelText("Reason for this action"), {
      target: { value: "Enable the verified preview jurisdiction rollout" },
    });
    fireEvent.change(screen.getByLabelText("Exact confirmation"), {
      target: { value: "UNIFIED_JURISDICTIONS preview ENABLE" },
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "private-password" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Verify and enable",
    }));

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/verify-password",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          "x-admin-step-up-action": "unified_jurisdictions_set",
          "x-admin-step-up-target": "unified_jurisdictions:preview",
          "x-admin-step-up-key": "00000000-0000-4000-8000-000000000021",
        }),
        body: JSON.stringify({ password: "private-password" }),
      }),
    );
    expect(mutation).toHaveBeenCalledWith({
      environment: "preview",
      enabled: true,
      confirmation: "UNIFIED_JURISDICTIONS preview ENABLE",
      reason: "Enable the verified preview jurisdiction rollout",
      idempotencyKey: "00000000-0000-4000-8000-000000000021",
    });
    expect(JSON.stringify(mutation.mock.calls)).not.toContain("private-password");
    expect(await screen.findByText(/Correlation op_unified_recovery/)).toBeVisible();
  });

  it("blocks enablement while readiness is red but preserves rollback", () => {
    const blockedRollout = {
      ...readyRollout,
      canEnable: false,
      blockers: ["CHAT_SESSIONS_NOT_VERIFIED"],
      targets: readyRollout.targets.map((target) =>
        target.target === "chatSessions"
          ? { ...target, status: "blocked" as const, verifiedAt: null }
          : target,
      ),
    };
    const { unmount } = render(
      <UnifiedJurisdictionsRecoveryControl rollout={blockedRollout} />,
    );

    expect(screen.getByRole("button", {
      name: "Enable unified jurisdictions",
    })).toBeDisabled();
    expect(screen.getByText("Chat sessions not verified")).toBeVisible();

    unmount();
    render(
      <UnifiedJurisdictionsRecoveryControl
        rollout={{ ...blockedRollout, flagEnabled: true }}
      />,
    );
    expect(screen.getByRole("button", {
      name: "Disable unified jurisdictions",
    })).toBeEnabled();
  });
});
