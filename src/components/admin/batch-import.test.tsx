import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BatchImport } from "./batch-import";

const query = vi.fn();
const commit = vi.fn();
const uploadUrl = vi.fn();
vi.mock("convex/react", () => ({
  useConvex: () => ({ query }),
  useMutation: (reference: unknown) => String(reference).includes("generateUploadUrl") ? uploadUrl : commit,
  useQuery_experimental: () => ({ status: "success", data: { page: [{ _id: "ghana", name: "Ghana", status: "enabled" }] } }),
}));
vi.mock("../../../convex/_generated/api", () => ({ api: { admin: {
  batchImports: { preflight: "preflight", commit: "commit", getStatus: "getStatus", prepareDuplicateChecks: "prepareDuplicateChecks" },
  documents: { generateUploadUrl: "generateUploadUrl" }, resources: { listJurisdictions: "listJurisdictions" },
} } }));
vi.mock("@/lib/admin/batch-import", async () => ({
  ...(await vi.importActual("@/lib/admin/batch-import")),
  fingerprintFile: async (file: File) => ({ sha256: "a".repeat(64), byteSize: file.size }),
}));
const manifest = JSON.stringify({ version: 1, jurisdictionId: "ghana", documents: [{
  filename: "case.pdf", title: "Example v Republic", issuer: "Supreme Court", officialCitation: "[2020] GHSC 1",
  sourceUrl: "https://lawfirm.example/case.pdf", topics: ["tax"], sourceProvenance: "Law firm hosted reproduction of court judgment; authenticity requires review.", caseAliases: [],
}] });
beforeEach(() => { localStorage.clear(); query.mockReset(); commit.mockReset(); uploadUrl.mockReset(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function load() {
  render(<BatchImport userId="admin" maxBytes={1000} />);
  fireEvent.change(screen.getByLabelText("Manifest JSON"), { target: { value: manifest } });
  fireEvent.click(screen.getByRole("button", { name: "Load manifest" }));
  fireEvent.change(screen.getByLabelText("Judgment PDFs"), { target: { files: [new File(["%PDF-test"], "case.pdf", { type: "application/pdf" })] } });
}
it("shows truthful provenance and requires a separate document review", async () => {
  load();
  expect(screen.getByText(/Law firm hosted reproduction/, { selector: "dd" })).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve|Publish version/ })).toBeNull();
  expect(commit).not.toHaveBeenCalled();
});
it("reconciles a committed upload after its response is lost without uploading again", async () => {
  query.mockResolvedValueOnce({ kind: "new", message: "New", indexed: false }).mockResolvedValueOnce({ kind: "existing", message: "Already recorded", resourceId: "resource", versionId: "version", status: "ready_for_review", indexed: false });
  uploadUrl.mockResolvedValue("https://upload.example");
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ storageId: "storage" })));
  commit.mockRejectedValueOnce(new Error("connection lost"));
  load();
  fireEvent.click(screen.getByRole("button", { name: "Upload pending PDFs" }));
  await screen.findByText(/could not finish/);
  fireEvent.click(screen.getByRole("button", { name: "Upload pending PDFs" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Review document" })).toHaveAttribute("href", "/admin/review?versionId=version"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
});
