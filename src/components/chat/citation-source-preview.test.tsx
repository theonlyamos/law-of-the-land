import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CitationSourcePreview, privateCitationSourceUrl } from "./citation-source-preview";

const renderer = vi.hoisted(() => ({ fail: false }));
vi.mock("./citation-pdf-page", () => ({ CitationPdfPage: ({ initialPage }: { initialPage?: number }) => { if (renderer.fail) throw new Error("Preview rendering failed"); return <div>Original PDF page {initialPage ?? 1}</div>; } }));
const url = "/api/chat/sources/saved_answer/0?chat=owned-chat#page=11";
beforeEach(() => {
  renderer.fail = false;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("accepts only the private same-origin citation proxy and bounded pages", () => {
  expect(privateCitationSourceUrl(url)).toEqual({ url: url.split("#")[0], pageNumber: 11 });
  expect(privateCitationSourceUrl("/api/chat/sources/saved_answer/15?chat=owned-chat")).toEqual({ url: "/api/chat/sources/saved_answer/15?chat=owned-chat" });
  for (const input of ["https://external.invalid/a.pdf", "//external.invalid/a.pdf", "/api/storage/secret", "/api/chat/sources/saved_answer/16?chat=owned-chat", `${url}&extra=1`, "/api/chat/sources/saved_answer/0?chat=a&chat=b", "/api/chat/sources/saved_answer/0?chat=a#page=0", "/api/chat/sources/saved_answer/0?chat=a#page=10001"]) {
    expect(privateCitationSourceUrl(input)).toBeNull();
  }
});
it("opens an accessible preview, fetches privately and jumps to the source page", async () => {
  render(<CitationSourcePreview source={{ label: "Employment Act", originalUrl: url }} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Employment Act" })).toBeVisible();
  await screen.findByText("Original PDF page 11");
  expect(fetch).toHaveBeenCalledWith(url.split("#")[0], expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }));
  expect(screen.getByRole("link", { name: "Open full document (opens in a new tab)" })).toHaveAttribute("href", url.split("#")[0]);
});
it("does not claim passage highlighting for legacy page-only citations", async () => {
  render(<CitationSourcePreview source={{ label: "Legacy source", originalUrl: url }} onClose={vi.fn()} />);
  await screen.findByText("Original PDF page 11");
  expect(screen.getByText(/A cited page is available, but no exact supporting passage was saved/)).toBeVisible();
});
it("shows an unavailable-source state without fetching arbitrary links", () => {
  render(<CitationSourcePreview source={{ label: "Old source", originalUrl: "https://external.invalid/private.pdf" }} onClose={vi.fn()} />);
  expect(screen.getByText(/An original document preview is not available for this citation/)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});
it("handles expired sign-in and allows a fresh retry", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response("Sign in", { status: 401 }));
  render(<CitationSourcePreview source={{ label: "Act", originalUrl: url }} onClose={vi.fn()} />);
  await screen.findByText(/Sign in again to view this document/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Original PDF page 11");
});
it("rejects non-PDF or oversized responses rather than displaying unsafe bytes", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  render(<CitationSourcePreview source={{ label: "Act", originalUrl: url }} onClose={vi.fn()} />);
  await screen.findByText(/We could not load this document preview/);
  expect(screen.queryByText("Original PDF page 11")).not.toBeInTheDocument();
});
it("closes on Escape and returns focus to the source trigger", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const onClose = vi.fn();
  const view = render(<CitationSourcePreview source={{ label: "Act" }} onClose={onClose} />);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  trigger.remove();
});

it("keeps a full-document fallback if the PDF renderer fails", async () => {
  renderer.fail = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<CitationSourcePreview source={{ label: "Act", originalUrl: url }} onClose={vi.fn()} />);
    await screen.findByText(/This PDF could not be rendered here/);
    expect(screen.getByRole("link", { name: "Open full document (opens in a new tab)" })).toBeVisible();
  } finally { error.mockRestore(); }
});

it("wraps Tab and Shift+Tab within the preview controls", async () => {
  render(<CitationSourcePreview source={{ label: "Act", originalUrl: url }} onClose={vi.fn()} />);
  await screen.findByText("Original PDF page 11");
  const close = screen.getByRole("button", { name: "Close source preview" });
  const full = screen.getByRole("link", { name: "Open full document (opens in a new tab)" });
  close.focus();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(full);
  fireEvent.keyDown(full, { key: "Tab" });
  expect(document.activeElement).toBe(close);
});
