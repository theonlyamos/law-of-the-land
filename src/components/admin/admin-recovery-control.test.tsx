import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutation = vi.fn();
vi.mock("convex/react", () => ({ useMutation: () => mutation }));

import { AdminRecoveryControl } from "./admin-recovery-control";

afterEach(cleanup);

describe("persisted admin-panel recovery control", () => {
  beforeEach(() => {
    mutation.mockReset().mockResolvedValue({
      environment: "preview",
      enabled: true,
      correlationId: "op_recovery",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000020",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("binds a fresh password proof and exact confirmation to enabling the current environment", async () => {
    render(<AdminRecoveryControl environment="preview" enabled={false} />);

    expect(screen.getByText("Disabled")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Enable persisted flag" }));
    expect(screen.getByRole("button", { name: "Cancel recovery action" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Reason for this action"), {
      target: { value: "Restore access after incident review" },
    });
    fireEvent.change(screen.getByLabelText("Exact confirmation"), {
      target: { value: "ADMIN_PANEL preview ENABLE" },
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "private-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/verify-password",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          "x-admin-step-up-action": "admin_panel_set",
          "x-admin-step-up-target": "admin_panel:preview",
          "x-admin-step-up-key": "00000000-0000-4000-8000-000000000020",
        }),
        body: JSON.stringify({ password: "private-password" }),
      }),
    );
    expect(mutation).toHaveBeenCalledWith({
      environment: "preview",
      enabled: true,
      confirmation: "ADMIN_PANEL preview ENABLE",
      reason: "Restore access after incident review",
      idempotencyKey: "00000000-0000-4000-8000-000000000020",
    });
    expect(JSON.stringify(mutation.mock.calls)).not.toContain("private-password");
    expect(await screen.findByText(/Correlation op_recovery/)).toBeVisible();
  });

  it("does not invoke the mutation when password verification fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }));
    render(<AdminRecoveryControl environment="production" enabled />);

    fireEvent.click(screen.getByRole("button", { name: "Disable persisted flag" }));
    fireEvent.change(screen.getByLabelText("Reason for this action"), {
      target: { value: "Contain a confirmed administrative incident" },
    });
    fireEvent.change(screen.getByLabelText("Exact confirmation"), {
      target: { value: "ADMIN_PANEL production DISABLE" },
    });
    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "incorrect" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and disable" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "password could not be verified",
    );
    expect(mutation).not.toHaveBeenCalled();
  });
});
