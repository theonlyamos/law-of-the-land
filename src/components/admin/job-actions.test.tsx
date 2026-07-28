import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.mutate }));
import { JobActions } from "./job-actions";
afterEach(() => { cleanup(); mocks.mutate.mockReset(); });
describe("authoritative job controls", () => {
  it("shows only legal state controls and sends a reason with an opaque idempotency key", async () => {
    mocks.mutate.mockResolvedValue({ status: "queued" });
    render(<JobActions jobId={"job-1" as never} status="failed" canRetry canCancel />);
    expect(screen.getByRole("button", { name: "Retry safely" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel queued job" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Reason for job-1"), { target: { value: "Retry confirmed transport failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ jobId: "job-1", reason: "Retry confirmed transport failure", idempotencyKey: expect.stringMatching(/^retry_[a-f0-9]{32}$/) }));
  });
});
