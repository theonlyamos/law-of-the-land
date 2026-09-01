import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingActions, BillingAllowanceSummary } from "./billing-actions";

const mutate = vi.fn();
const refresh = vi.fn();
vi.mock("convex/react", () => ({ useMutation: () => mutate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("BillingActions", () => {
  beforeEach(() => {
    mutate.mockReset().mockResolvedValue({ status: "succeeded" });
    refresh.mockReset();
  });
  afterEach(cleanup);

  it("reveals and enforces the exceptional-override confirmation before submission", async () => {
    render(<BillingActions userId="user-7" />);
    fireEvent.click(screen.getByText("Adjust temporary allowance"));
    fireEvent.change(screen.getByLabelText("Effective question limit"), { target: { value: "1001" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Temporary account remediation" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2090-01-01T00:00" } });
    expect(screen.getByLabelText("Type CONFIRM_QUOTA_OVERRIDE user-7 to continue")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Grant temporary override" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Type CONFIRM_QUOTA_OVERRIDE user-7 to continue"), { target: { value: "CONFIRM_QUOTA_OVERRIDE user-7" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant temporary override" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({ userId: "user-7", limit: 1001, confirmation: "CONFIRM_QUOTA_OVERRIDE user-7", reason: "Temporary account remediation" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("refreshes the server allowance projection after revocation", async () => {
    render(<BillingActions userId="user-7" activeOverrideId={"override-7" as never} />);
    fireEvent.click(screen.getByText("Adjust temporary allowance"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Temporary remediation complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke active override" }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ overrideId: "override-7", reason: "Temporary remediation complete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("renders the effective decision and complete active override provenance", () => {
    render(<BillingAllowanceSummary used={10} effectiveLimit={10} allowed canRecord={false} override={{ limit: 25, expiresAt: Date.parse("2026-08-01T00:00:00.000Z"), grantedBy: "admin-7", reason: "Temporary remediation" }} />);
    expect(screen.getByText("10 / 10")).toBeVisible();
    expect(screen.getByText("At limit — another question cannot be recorded")).toBeVisible();
    expect(screen.getByText(/Expires 2026-08-01T00:00:00.000Z/)).toBeVisible();
    expect(screen.getByText(/Granted by admin-7/)).toBeVisible();
    expect(screen.getByText(/Temporary remediation/)).toBeVisible();
  });
});
