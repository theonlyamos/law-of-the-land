import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentUpload } from "./document-upload";

const generateUploadUrl = vi.fn();
const createDocumentVersion = vi.fn();

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    admin: {
      documents: {
        generateUploadUrl: "generate-upload-url",
        createDocumentVersion: "create-document-version",
      },
    },
  },
}));
vi.mock("convex/react", () => ({
  useMutation: (reference: string) =>
    reference === "generate-upload-url" ? generateUploadUrl
      : createDocumentVersion,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

beforeEach(() => {
  generateUploadUrl.mockReset();
  createDocumentVersion.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderUpload(resourceStatus: "active" | "repealed" | "archived" = "active") {
  render(
    <DocumentUpload
      resourceId="resource_1"
      resourceStatus={resourceStatus}
      defaultSourceUrl="https://laws.example.gov/files/act.pdf"
      defaultEffectiveAt="2012-10-16"
      maxBytes={100}
    />,
  );
}

describe("document original upload", () => {
  it("explains the governed direct-upload flow with accessible fields", () => {
    renderUpload();
    expect(screen.getByRole("heading", { name: "Add an original" })).toBeVisible();
    expect(screen.getByLabelText("Original legal file")).toHaveAttribute(
      "accept",
      ".txt,.docx,.pptx,.xlsx,.pdf,.png,.jpg,.csv,.tsv,.json",
    );
    expect(screen.getByLabelText("Official source URL")).toHaveValue(
      "https://laws.example.gov/files/act.pdf",
    );
    expect(screen.getByLabelText("Effective date")).toHaveValue("2012-10-16");
    expect(screen.getByText(/100 B maximum/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload version" })).toBeVisible();
  });

  it.each(["repealed", "archived"] as const)(
    "does not render upload controls for a %s resource",
    (status) => {
      renderUpload(status);
      expect(screen.queryByRole("heading", { name: "Add an original" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Upload version" })).toBeNull();
    },
  );

  it("stops an unsupported file before requesting an upload URL", async () => {
    renderUpload();
    const file = new File(["bad"], "law.exe", {
      type: "application/octet-stream",
    });
    fireEvent.change(screen.getByLabelText("Original legal file"), {
      target: { files: [file] },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Upload version" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a supported PDF, Office, text, image, CSV, TSV, or JSON file.",
    );
    expect(generateUploadUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hashes, uploads directly, records metadata, and announces success", async () => {
    generateUploadUrl.mockResolvedValue("https://upload.example/token-secret");
    createDocumentVersion.mockResolvedValue("version_1");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ storageId: "storage_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    renderUpload();
    const file = new File(["abc"], "Act-843.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("abc").buffer,
    });
    fireEvent.change(screen.getByLabelText("Original legal file"), {
      target: { files: [file] },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Upload version" }).closest("form")!);

    await waitFor(() => expect(createDocumentVersion).toHaveBeenCalledTimes(1));
    expect(generateUploadUrl).toHaveBeenCalledWith({});
    expect(fetch).toHaveBeenCalledWith(
      "https://upload.example/token-secret",
      expect.objectContaining({
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    expect(createDocumentVersion).toHaveBeenCalledWith({
      resourceId: "resource_1",
      storageId: "storage_1",
      filename: "Act-843.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl: "https://laws.example.gov/files/act.pdf",
      effectiveAt: "2012-10-16",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Version recorded and ready for review.",
    );
  });

  it("uses the approved bounded-size guidance before requesting an upload URL", async () => {
    renderUpload();
    const file = new File([new Uint8Array(101)], "law.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Original legal file"), { target: { files: [file] } });
    fireEvent.submit(screen.getByRole("button", { name: "Upload version" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a file smaller than 100 B.");
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });

  it("announces a storage failure without submitting authoritative metadata", async () => {
    generateUploadUrl.mockResolvedValue("https://upload.example/token-secret");
    vi.mocked(fetch).mockResolvedValue(new Response("denied", { status: 403 }));
    renderUpload();
    const file = new File(["abc"], "law.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("abc").buffer,
    });
    fireEvent.change(screen.getByLabelText("Original legal file"), {
      target: { files: [file] },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Upload version" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The original could not be uploaded",
    );
    expect(createDocumentVersion).not.toHaveBeenCalled();
  });
});
