import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("convex/react", () => ({ useAction: () => mocks.inspect }));
import { JobDiagnostics } from "./job-diagnostics";
afterEach(() => { cleanup(); mocks.inspect.mockReset(); });
describe("read-only indexing inspection", () => {
  it("requires an explicit click and shows exact mapping and incomplete evidence without claiming recovery", async () => {
    mocks.inspect.mockResolvedValue({ observedAt: 1000, detail: { versionId: "version-exact", resourceId: "resource-exact", recoveryKind: "poll_operation", providerOperationName: "fileSearchStores/fixture/upload/operations/known", lastErrorKind: "invalid_response" }, provider: { operation: { status: "ok", done: true, error: null, response: { metadataMatched: true, document: { state: "STATE_ACTIVE" } } }, documents: { scanComplete: false, scanLimit: "pages", pagesScanned: 20, documentsScanned: 400, matchingCount: 1, duplicateMatches: false, matches: [{ reference: "sha256:safe-reference", state: "STATE_ACTIVE" }], requestError: null } } });
    render(<JobDiagnostics jobId={"job-1" as never} />);
    expect(mocks.inspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect indexing (read-only)" }));
    await screen.findByText("Version: version-exact");
    expect(screen.getByText("Resource: resource-exact")).toBeVisible();
    expect(screen.getByText(/Scan complete: No/)).toBeVisible();
    expect(screen.getByText("Scan bound: pages")).toBeVisible();
    expect(screen.getByText("Match: sha256:safe-reference · STATE_ACTIVE")).toBeVisible();
    expect(screen.getByText(/Pages: 20 · Documents: 400/)).toBeVisible();
    expect(screen.getByText(/Incomplete scan is not publication proof/)).toBeVisible();
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith({ jobId: "job-1" });
  });
  it("reports failure safely without raw exception text or automatic retries", async () => {
    mocks.inspect.mockRejectedValue(new Error("secret https://private.invalid"));
    render(<JobDiagnostics jobId={"job-1" as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect indexing (read-only)" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Inspection unavailable"));
    expect(document.body.textContent).not.toMatch(/secret|private.invalid/);
    expect(mocks.inspect).toHaveBeenCalledOnce();
  });
});
