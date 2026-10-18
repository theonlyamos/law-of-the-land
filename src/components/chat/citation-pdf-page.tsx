"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { matchCitationPassage, type CitationTextItem } from "@/lib/citation-passage-match";
import "./citation-pdf-page.css";

export type CitationPdfPageProps = {
  bytes: Uint8Array;
  initialPage?: number;
  passages?: readonly { pageNumber: number; quote: string }[];
};

type PdfLibrary = typeof import("pdfjs-dist");
type PageStatus = "loading" | "page-only" | "matched" | "no-match" | "ambiguous" | "no-text" | "text-error" | "error";
const EMPTY_PASSAGES: NonNullable<CitationPdfPageProps["passages"]> = [];
const STATUS_TEXT: Record<Exclude<PageStatus, "error">, string> = {
  loading: "Loading original PDF page…",
  "page-only": "Page-only citation. No exact source passage was provided for this page.",
  matched: "Exact passage highlighted in the original page.",
  "no-match": "No exact passage match on this page. The original page is shown without a highlight.",
  ambiguous: "This passage appears more than once on this page. No unique location can be highlighted.",
  "no-text": "No text layer on this page. The original page is shown without a highlight.",
  "text-error": "Text layer unavailable. The original page is shown without a highlight.",
};

function validPage(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

export function CitationPdfPage({ bytes, initialPage, passages = EMPTY_PASSAGES }: CitationPdfPageProps) {
  const quotedPassages = useMemo(() => passages.filter((passage) => validPage(passage.pageNumber) && passage.quote.trim()), [passages]);
  const requestedInitialPage = initialPage ?? quotedPassages[0]?.pageNumber ?? 1;
  const [loaded, setLoaded] = useState<{ document: PDFDocumentProxy; library: PdfLibrary; bytes: Uint8Array } | null>(null);
  const [pageNumber, setPageNumber] = useState(validPage(requestedInitialPage) ? requestedInitialPage : 1);
  const [pageInput, setPageInput] = useState(String(pageNumber));
  const [passageIndex, setPassageIndex] = useState(() => quotedPassages.findIndex((passage) => passage.pageNumber === pageNumber));
  const [pageWarning, setPageWarning] = useState("");
  const [zoom, setZoom] = useState(1);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [pageText, setPageText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const currentDocument = loaded?.bytes === bytes ? loaded : null;
  const pageCount = currentDocument?.document.numPages ?? 0;
  const selectedPassage = quotedPassages[passageIndex]?.pageNumber === pageNumber ? quotedPassages[passageIndex] : undefined;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const resize = () => {
      if (container.clientWidth > 0) setAvailableWidth(Math.max(1, container.clientWidth - 24));
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setLoaded(null);
    setStatus("loading");
    setPageText("");
    setPageWarning("");
    pageRef.current?.replaceChildren();

    async function load() {
      try {
        // Import in the browser only. The worker is emitted by Next as a local asset.
        const library = await import("pdfjs-dist");
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const assetBase = new URL(`/pdfjs/${library.version}/`, window.location.origin);
        // PDF.js transfers its input buffer to the worker; keep the caller's bytes intact.
        loadingTask = library.getDocument({
          data: bytes.slice(),
          enableXfa: false,
          cMapUrl: new URL("cmaps/", assetBase).href,
          cMapPacked: true,
          standardFontDataUrl: new URL("standard_fonts/", assetBase).href,
          wasmUrl: new URL("wasm/", assetBase).href,
          iccUrl: new URL("iccs/", assetBase).href,
          useSystemFonts: false,
          stopAtErrors: true,
        });
        const document = await loadingTask.promise;
        if (cancelled) return;
        const requested = validPage(requestedInitialPage) ? requestedInitialPage : 1;
        const firstPage = Math.min(requested, document.numPages);
        if (firstPage !== requestedInitialPage) {
          setPageWarning(`The cited page ${requestedInitialPage} is outside this PDF. Showing page ${firstPage}.`);
        }
        setPageNumber(firstPage);
        setPageInput(String(firstPage));
        setPassageIndex(quotedPassages.findIndex((passage) => passage.pageNumber === firstPage));
        setLoaded({ document, library, bytes });
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
      void loadingTask?.destroy().catch(() => {});
    };
    // Passage selection is initialized when the actual source or starting page changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, requestedInitialPage]);

  useEffect(() => {
    const container = pageRef.current;
    if (!currentDocument || !container) return;
    let cancelled = false;
    let renderingTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setStatus("loading");
    setPageText("");
    container.replaceChildren();

    async function renderPage() {
      try {
        const page = await currentDocument!.document.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = (availableWidth / baseViewport.width) * zoom;
        const viewport = page.getViewport({ scale });
        const surface = document.createElement("div");
        surface.className = "citation-pdf-surface";
        surface.style.width = `${viewport.width}px`;
        surface.style.height = `${viewport.height}px`;
        surface.style.setProperty("--total-scale-factor", String(scale * page.userUnit));
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
          16_384 / viewport.width, 16_384 / viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        if (!canvas.getContext("2d")) throw new Error("Canvas unavailable");
        surface.append(canvas);
        container!.replaceChildren(surface);
        renderingTask = page.render({
          canvas, viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderingTask.promise;
        if (cancelled) return;

        try {
          // Preserve source characters; matching applies only explicit whitespace/ligature rules.
          const content = await page.getTextContent({ disableNormalization: true });
          if (cancelled) return;
          const items = content.items.filter((item): item is typeof item & CitationTextItem => "str" in item);
          setPageText(items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join(""));
          if (!items.some((item) => item.str.trim())) {
            setStatus("no-text");
            return;
          }
          const textContainer = document.createElement("div");
          textContainer.className = "citation-pdf-text-layer";
          // Screen readers use the ordered, selectable text fallback below the page.
          textContainer.setAttribute("aria-hidden", "true");
          surface.append(textContainer);
          textLayer = new currentDocument!.library.TextLayer({ textContentSource: content, container: textContainer, viewport });
          await textLayer.render();
          if (cancelled) return;
          if (textLayer.textDivs.length !== items.length
            || items.some((item, index) => textLayer!.textContentItemsStr[index] !== item.str
              || textLayer!.textDivs[index].textContent !== item.str)) {
            textContainer.remove();
            setStatus("text-error");
            return;
          }
          if (!selectedPassage) {
            setStatus("page-only");
            return;
          }
          const match = matchCitationPassage(items, selectedPassage.quote);
          if (match.status === "matched") {
            for (const range of match.ranges) {
              const span = textLayer.textDivs[range.itemIndex];
              const sourceText = items[range.itemIndex].str;
              const mark = document.createElement("mark");
              mark.className = "citation-pdf-highlight";
              mark.textContent = sourceText.slice(range.start, range.end);
              span.replaceChildren(document.createTextNode(sourceText.slice(0, range.start)), mark,
                document.createTextNode(sourceText.slice(range.end)));
            }
            const firstHighlight = textContainer.querySelector("mark");
            const scrollContainer = scrollRef.current;
            if (firstHighlight && scrollContainer) {
              const highlighted = firstHighlight.getBoundingClientRect();
              const visible = scrollContainer.getBoundingClientRect();
              // Move only this PDF viewport; never scroll the dialog or underlying chat.
              if (highlighted.top < visible.top + 16 || highlighted.bottom > visible.bottom - 16) {
                scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop + highlighted.top - visible.top - visible.height / 3);
              }
              if (highlighted.left < visible.left || highlighted.right > visible.right) {
                scrollContainer.scrollLeft = Math.max(0, scrollContainer.scrollLeft + highlighted.left - visible.left - 16);
              }
            }
          }
          setStatus(match.status);
        } catch {
          if (!cancelled) {
            surface.querySelector(".citation-pdf-text-layer")?.remove();
            setStatus("text-error");
          }
        }
      } catch {
        if (!cancelled) {
          container!.replaceChildren();
          setStatus("error");
        }
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderingTask?.cancel();
      textLayer?.cancel();
    };
  }, [currentDocument, pageNumber, availableWidth, zoom, selectedPassage]);

  function goToPage(requested: number, selectedIndex?: number) {
    if (!pageCount || !validPage(requested)) { setPageInput(String(pageNumber)); return; }
    const next = Math.min(requested, pageCount);
    setPageWarning(next !== requested ? `The cited page ${requested} is outside this PDF. Showing page ${next}.` : "");
    setPageNumber(next);
    setPageInput(String(next));
    setPassageIndex(selectedIndex ?? quotedPassages.findIndex((passage) => passage.pageNumber === next));
    if (scrollRef.current) { scrollRef.current.scrollTop = 0; scrollRef.current.scrollLeft = 0; }
  }

  function goToPassage(direction: -1 | 1) {
    let next: number;
    if (passageIndex >= 0) next = (passageIndex + direction + quotedPassages.length) % quotedPassages.length;
    else if (direction === 1) {
      next = quotedPassages.findIndex((passage) => passage.pageNumber > pageNumber);
      if (next < 0) next = 0;
    } else {
      next = quotedPassages.map((passage) => passage.pageNumber < pageNumber).lastIndexOf(true);
      if (next < 0) next = quotedPassages.length - 1;
    }
    goToPage(quotedPassages[next].pageNumber, next);
  }

  return (
    <div className="citation-pdf-viewer flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2" aria-label="PDF navigation">
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Previous page" disabled={!pageCount || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ChevronLeft className="size-4" /></Button>
          <span className="text-sm tabular-nums">{pageCount ? `Page ${pageNumber} of ${pageCount}` : "Loading PDF…"}</span>
          <Button type="button" variant="ghost" size="icon" aria-label="Next page" disabled={!pageCount || pageNumber >= pageCount} onClick={() => goToPage(pageNumber + 1)}><ChevronRight className="size-4" /></Button>
          {pageCount > 1 && <form className="ml-1" onSubmit={(event) => { event.preventDefault(); goToPage(Number(pageInput)); }}>
            <input className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm" type="number" min={1} max={pageCount} aria-label="Go to page" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={() => goToPage(Number(pageInput))} />
          </form>}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" disabled={!pageCount || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><Minus className="size-4" /></Button>
          <Button type="button" variant="ghost" size="sm" disabled={!pageCount} onClick={() => setZoom(1)} aria-label="Fit page width">{zoom === 1 ? "Fit width" : `${Math.round(zoom * 100)}%`}</Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" disabled={!pageCount || zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))}><Plus className="size-4" /></Button>
        </div>
      </div>
      {quotedPassages.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{selectedPassage ? `Passage ${passageIndex + 1} of ${quotedPassages.length}` : `${quotedPassages.length} quoted passages`}</span>
        <Button type="button" variant="outline" size="sm" aria-label="Previous passage" disabled={!pageCount || (quotedPassages.length === 1 && !!selectedPassage)} onClick={() => goToPassage(-1)}>Previous passage</Button>
        <Button type="button" variant="outline" size="sm" aria-label="Next passage" disabled={!pageCount || (quotedPassages.length === 1 && !!selectedPassage)} onClick={() => goToPassage(1)}>Next passage</Button>
      </div>}
      {pageWarning && <p className="text-sm text-muted-foreground" role="status">{pageWarning}</p>}
      {status === "error" ? <p role="alert" className="rounded-lg border border-border p-4 text-sm">This PDF could not be displayed. Try opening the original source.</p>
        : <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{STATUS_TEXT[status]}</p>}
      <div ref={scrollRef} className="citation-pdf-scroll min-h-0 overflow-auto rounded-lg border border-border bg-muted/40 p-3" tabIndex={0} aria-label="Scrollable original PDF page">
        <div ref={pageRef} role="img" aria-label={`PDF page ${pageNumber}`} aria-busy={status === "loading"} className="citation-pdf-page" />
      </div>
      {pageText && <details className="rounded-lg border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Read page text</summary>
        <p className="mt-2 text-xs text-muted-foreground">Text extracted from this original page. Reading order may differ from the page layout.</p>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{pageText}</pre>
      </details>}
    </div>
  );
}
