import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStageRetry } from "./document-stage-retry";

const stageDocumentVersion = vi.fn();
const refresh = vi.fn();

vi.mock("../../../convex/_generated/api", () => ({
  api: { admin: { documents: { stageDocumentVersion: "stage-document-version" } } },
}));
vi.mock("convex/react", () => ({ useMutation: () => stageDocumentVersion }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  stageDocumentVersion.mockReset();
  refresh.mockReset();
  stageDocumentVersion.mockResolvedValue({ jobId: "job_1", duplicate: false });
});
afterEach(cleanup);

describe("recorded draft staging recovery", () => {
  it("queues staging for a recorded draft without re-uploading its original", async () => {
    render(<DocumentStageRetry versions={[
      { id: "version_1", versionNumber: 1, status: "draft" },
      { id: "version_2", versionNumber: 2, status: "ready_for_review", stagingDocumentId: "groundx_2" },
    ]} />);

    fireEvent.click(screen.getByRole("button", { name: "Stage version 1" }));

    await waitFor(() => expect(stageDocumentVersion).toHaveBeenCalledWith({
      versionId: "version_1",
      reason: "Retry staging a recorded draft version",
      idempotencyKey: expect.stringMatching(/^restage-version_1-/),
    }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Version 1 was queued for GroundX staging/i);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
