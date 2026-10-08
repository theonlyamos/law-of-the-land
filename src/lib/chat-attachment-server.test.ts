// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../convex/lib/chatAttachmentProof", () => ({ createChatAttachmentProof: vi.fn(async () => "proof") }));
import { loadChatAttachmentContext, parsePrivateAttachment } from "./chat-attachment-server";

const jurisdiction = { id: "jurisdiction", name: "Ghana", kind: "geographic" };
const textFile = { id: "attachment-one", filename: "notes.txt", mimeType: "text/plain", byteSize: 20, kind: "text", extractedText: "The rent is 900.", url: "https://test.convex.cloud/api/storage/one" };
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private chat attachment context", () => {
  it("loads current and saved text context without exposing URLs to the model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ selectedJurisdiction: jurisdiction, attachments: [textFile] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadChatAttachmentContext("chat", [], "jwt", new AbortController().signal);
    expect(result.attachmentIds).toEqual(["attachment-one"]);
    expect(result.attachments).toEqual([{ id: "attachment-one", filename: "notes.txt", mimeType: "text/plain", kind: "text", text: "The rent is 900." }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ authorization: "Bearer jwt", "x-file-proof": "proof" });
  });

  it("rejects external storage destinations and mismatched MIME", () => {
    expect(() => parsePrivateAttachment({ ...textFile, url: "http://127.0.0.1/private" })).toThrow();
    expect(() => parsePrivateAttachment({ ...textFile, mimeType: "text/html" })).toThrow();
  });

  it("maps extracted DOCX content to a text model input while retaining its original MIME", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ selectedJurisdiction: jurisdiction, attachments: [
      { ...textFile, filename: "agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
    ] })));
    const context = await loadChatAttachmentContext("chat", [], "jwt", new AbortController().signal);
    expect(context.attachments).toEqual([{
      id: "attachment-one", filename: "agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "text", text: "The rent is 900.",
    }]);
  });

  it("fails rather than silently dropping a requested attachment or oversized context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ selectedJurisdiction: jurisdiction, attachments: [textFile] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadChatAttachmentContext("chat", ["missing"], "jwt", new AbortController().signal)).rejects.toThrow();
    fetchMock.mockResolvedValue(Response.json({ selectedJurisdiction: jurisdiction, attachments: [0, 1, 2].map(index => ({ ...textFile, id: `file-${index}`, extractedText: "a".repeat(80_000) })) }));
    await expect(loadChatAttachmentContext("chat", [], "jwt", new AbortController().signal)).rejects.toThrow(/too much content/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads bounded binary input and rejects an incomplete original", async () => {
    const pdf = { ...textFile, filename: "file.pdf", mimeType: "application/pdf", kind: "document", extractedText: undefined, byteSize: 3, pageCount: 1 };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ selectedJurisdiction: jurisdiction, attachments: [pdf] })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const context = await loadChatAttachmentContext("chat", [pdf.id], "jwt", new AbortController().signal);
    expect(context.attachments[0].data).toBe("AQID");
    fetchMock.mockResolvedValueOnce(Response.json({ selectedJurisdiction: jurisdiction, attachments: [pdf] })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    await expect(loadChatAttachmentContext("chat", [pdf.id], "jwt", new AbortController().signal)).rejects.toThrow(/could not be read/);
  });
});
