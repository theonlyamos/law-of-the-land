import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CitationPdfPage } from "./citation-pdf-page";

const pdf = vi.hoisted(() => ({
  items: [{ str: "Before. A worker has rights. After.", hasEOL: true }],
  getDocument: vi.fn(),
  getPage: vi.fn(),
  destroy: vi.fn(),
  cancel: vi.fn(),
  textCancel: vi.fn(),
  render: vi.fn(),
  getTextContent: vi.fn(),
  textFailure: false,
  textMismatch: false,
}));

vi.mock("pdfjs-dist", () => ({
  version: "6.4.299",
  GlobalWorkerOptions: {},
  getDocument: pdf.getDocument,
  TextLayer: class {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    constructor(private options: { container: HTMLElement; textContentSource: { items: typeof pdf.items } }) {}
    async render() {
      if (pdf.textFailure) throw new Error("Unavailable text layer");
      for (const item of this.options.textContentSource.items) {
        const span = document.createElement("span");
        span.textContent = item.str;
        this.textDivs.push(span);
        this.textContentItemsStr.push(pdf.textMismatch ? "Different text" : item.str);
        this.options.container.append(span);
      }
    }
    cancel() { pdf.textCancel(); }
  },
}));

const bytes = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
  pdf.items = [{ str: "Before. A worker has rights. After.", hasEOL: true }];
  pdf.textFailure = false;
  pdf.textMismatch = false;
  pdf.destroy.mockResolvedValue(undefined);
  pdf.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: pdf.cancel }));
  pdf.getTextContent.mockImplementation(async () => ({ items: pdf.items, styles: {} }));
  pdf.getPage.mockImplementation(async () => ({
    userUnit: 1,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    render: pdf.render,
    getTextContent: pdf.getTextContent,
  }));
  pdf.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 3, getPage: pdf.getPage }),
    destroy: pdf.destroy,
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({} as CanvasRenderingContext2D));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("CitationPdfPage", () => {
  it("shows the original page with a page-only explanation and an accessible text fallback", async () => {
    render(<CitationPdfPage bytes={bytes} initialPage={2} />);
    expect(await screen.findByText(/Page-only citation/i)).toBeVisible();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByLabelText("PDF page 2")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Read page text"));
    expect(screen.getByText("Before. A worker has rights. After.", { selector: "pre" })).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    const parameters = pdf.getDocument.mock.calls[0][0];
    expect(parameters.data).toEqual(bytes);
    expect(parameters.data).not.toBe(bytes);
    expect(parameters.url).toBeUndefined();
    expect(parameters.enableXfa).toBe(false);
  });

  it("loads PDF.js supporting assets from this origin and rejects recoverable parse errors", async () => {
    render(<CitationPdfPage bytes={bytes} />);
    await screen.findByText(/Page-only citation/i);
    const parameters = pdf.getDocument.mock.calls[0][0];
    expect(parameters).toMatchObject({
      cMapUrl: new URL("/pdfjs/6.4.299/cmaps/", window.location.origin).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("/pdfjs/6.4.299/standard_fonts/", window.location.origin).href,
      wasmUrl: new URL("/pdfjs/6.4.299/wasm/", window.location.origin).href,
      iccUrl: new URL("/pdfjs/6.4.299/iccs/", window.location.origin).href,
      useSystemFonts: false,
      stopAtErrors: true,
    });
  });

  it("highlights only the exact original quoted span while keeping surrounding page text", async () => {
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(/Exact passage highlighted/i)).toBeVisible();
    const mark = document.querySelector("mark");
    expect(mark?.textContent).toBe("A worker has rights.");
    expect(mark?.parentElement?.textContent).toBe("Before. A worker has rights. After.");
    expect(screen.getByLabelText("PDF page 1").querySelector("canvas")).toBeInTheDocument();
    expect(pdf.getTextContent).toHaveBeenCalledWith({ disableNormalization: true });
  });

  it.each([
    ["A worker must leave.", /No exact passage match/i],
    ["A worker has rights. A worker has rights.", /appears more than once/i],
    ["", /No text layer/i],
  ])("never highlights unverified or ambiguous page text %j", async (text, status) => {
    pdf.items = [{ str: text, hasEOL: true }];
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(status)).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    expect(screen.getByLabelText("PDF page 1").querySelector("canvas")).toBeInTheDocument();
  });

  it("keeps the page visible when its text layer cannot render", async () => {
    pdf.textFailure = true;
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(/Text layer unavailable/i)).toBeVisible();
    expect(screen.getByLabelText("PDF page 1").querySelector("canvas")).toBeInTheDocument();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });

  it("keeps the original canvas visible when text extraction fails", async () => {
    pdf.getTextContent.mockRejectedValue(new Error("Text extraction failed"));
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(/Text layer unavailable/i)).toBeVisible();
    expect(screen.getByLabelText("PDF page 1").querySelector("canvas")).toBeInTheDocument();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });

  it("highlights exact text across separate PDF runs without highlighting surrounding characters", async () => {
    pdf.items = [{ str: "Before. A worker", hasEOL: true }, { str: "has rights. After.", hasEOL: true }];
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(/Exact passage highlighted/i)).toBeVisible();
    expect(Array.from(document.querySelectorAll("mark"), (mark) => mark.textContent)).toEqual(["A worker", "has rights."]);
  });

  it.each([
    ["Before. A worker has rights. After.", true],
    ["A worker must leave.", false],
    ["A worker has rights. A worker has rights.", false],
  ])("scrolls only the PDF container to a unique exact match in %j", async (text, shouldScroll) => {
    pdf.items = [{ str: text, hasEOL: true }];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: this.tagName === "MARK" ? 900 : 100, top: this.tagName === "MARK" ? 900 : 100,
        left: 0, bottom: this.tagName === "MARK" ? 920 : 500, right: 600, width: 600,
        height: this.tagName === "MARK" ? 20 : 400, toJSON() {} };
    });
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    await waitFor(() => expect(screen.queryByText("Loading original PDF page…")).not.toBeInTheDocument());
    const container = screen.getByLabelText("Scrollable original PDF page");
    expect(container.scrollTop > 0).toBe(shouldScroll);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("refuses a highlight if PDF.js span mapping does not match the extracted text", async () => {
    pdf.textMismatch = true;
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByText(/Text layer unavailable/i)).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });

  it("navigates pages and quoted passages without carrying an old highlight onto another page", async () => {
    render(<CitationPdfPage bytes={bytes} passages={[
      { pageNumber: 1, quote: "A worker has rights." },
      { pageNumber: 3, quote: "A worker has rights." },
    ]} />);
    await screen.findByText(/Exact passage highlighted/i);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/Page-only citation/i)).toBeVisible();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Next passage" }));
    expect(await screen.findByText(/Exact passage highlighted/i)).toBeVisible();
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
  });

  it("rerenders the full page and exact text highlight when zoom changes", async () => {
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    await screen.findByText(/Exact passage highlighted/i);
    const before = (document.querySelector("canvas") as HTMLCanvasElement).width;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect((document.querySelector("canvas") as HTMLCanvasElement).width).toBeGreaterThan(before));
    expect(await screen.findByText(/Exact passage highlighted/i)).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(1);
  });

  it("reports a malformed document without exposing an untrusted exception message", async () => {
    pdf.getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error("untrusted source error")), destroy: pdf.destroy }));
    render(<CitationPdfPage bytes={bytes} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This PDF could not be displayed");
    expect(screen.queryByText(/untrusted source error/)).not.toBeInTheDocument();
  });

  it("reports page rendering failures without claiming a passage match", async () => {
    pdf.render.mockImplementation(() => ({ promise: Promise.reject(new Error("Render failed")), cancel: pdf.cancel }));
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This PDF could not be displayed");
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });

  it("warns when the cited page is outside the original PDF", async () => {
    render(<CitationPdfPage bytes={bytes} initialPage={99} />);
    expect(await screen.findByText(/outside this PDF/i)).toBeVisible();
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
  });

  it("destroys document loading and cancels page work on dismissal", async () => {
    const { unmount } = render(<CitationPdfPage bytes={bytes} />);
    await screen.findByText(/Page-only citation/i);
    unmount();
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(pdf.cancel).toHaveBeenCalled();
    expect(pdf.textCancel).toHaveBeenCalled();
  });

  it("ignores a document load that finishes after the preview closes", async () => {
    let resolve!: (value: unknown) => void;
    pdf.getDocument.mockImplementation(() => ({ promise: new Promise((done) => { resolve = done; }), destroy: pdf.destroy }));
    const { unmount } = render(<CitationPdfPage bytes={bytes} />);
    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { resolve({ numPages: 3, getPage: pdf.getPage }); });
    expect(pdf.getPage).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("does not let a late old page replace a more recently selected page", async () => {
    let resolveFirst!: (value: unknown) => void;
    const normalPage = await pdf.getPage();
    pdf.getPage.mockClear();
    pdf.getPage.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    render(<CitationPdfPage bytes={bytes} passages={[{ pageNumber: 1, quote: "A worker has rights." }]} />);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/Page-only citation/i)).toBeVisible();
    await act(async () => { resolveFirst(normalPage); });
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByText(/Page-only citation/i)).toBeVisible();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });
});
