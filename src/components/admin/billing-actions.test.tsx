import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingActions } from "./billing-actions";

const mutate = vi.fn();
vi.mock("convex/react", () => ({ useMutation: () => mutate }));

describe("BillingActions", () => {
  beforeEach(() => mutate.mockReset().mockResolvedValue({ status: "succeeded" }));

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
  });
});
