"use client";

import { Component, type ReactNode, lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { X, ExternalLink } from "lucide-react";

const CitationPdfPage = lazy(() => import("./citation-pdf-page").then(module => ({ default: module.CitationPdfPage })));
const MAX_PDF_BYTES = 32 * 1024 * 1024;
export type CitationPreviewMetadata = import("../../../shared/citation-source-preview").CitationPreview;
export type CitationPreviewSource = CitationPreviewMetadata & { label: string; originalUrl?: string; externalUrl?: string };

/** Only server-owned, same-origin source proxies may supply preview bytes. */
export function privateCitationSourceUrl(value?: string): { url: string; pageNumber?: number } | null {
  const review = value?.match(/^(\/api\/document-(?:reviews|drafts)\/[A-Za-z0-9_-]{1,128}\/sources\/[A-Za-z0-9_-]{1,128}\/[0-3])(?:#page=([1-9][0-9]{0,4}))?$/u);
  if (review) {
    const pageNumber = review[2] ? Number(review[2]) : undefined;
    if (pageNumber !== undefined && pageNumber > 10_000) return null;
    return { url: review[1]!, ...(pageNumber === undefined ? {} : { pageNumber }) };
  }
  if (!value ||!/^\/api\/chat\/sources\/[A-Za-z0-9_-]{1,128}\/(?:[0-9]|1[0-5])\?chat=[^#]+(?:#page=[1-9][0-9]{0,4})?$/u.test(value)) return null;
  try {
    const parsed = new URL(value, "https://preview.invalid");
    const chat = parsed.searchParams.get("chat");
    if ([...parsed.searchParams.keys()].length !== 1 || !chat?.trim() || chat !== chat.trim() || chat.length > 200) return null;
    const pageNumber = parsed.hash ? Number(parsed.hash.slice(6)) : undefined;
    if (pageNumber !== undefined && (!Number.isSafeInteger(pageNumber) || pageNumber > 10_000)) return null;
    return { url: `${parsed.pathname}${parsed.search}`, ...(pageNumber === undefined ? {} : { pageNumber }) };
  } catch { return null; }
}
function publicSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}
async function readBoundedPdf(response: Response): Promise<Uint8Array> {
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") throw new Error("invalid");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_PDF_BYTES)) throw new Error("invalid");
  if (!response.body) throw new Error("invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PDF_BYTES) { await reader.cancel(); throw new Error("invalid"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new Error("invalid");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

class PdfPreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert" className="py-8 text-sm">This PDF could not be rendered here. You can still open the full document below.</p> : this.props.children;
  }
}

type LoadState = { status: "loading" } | { status: "loaded"; bytes: Uint8Array } | { status: "error"; message: string };
export function CitationSourcePreview({ source, onClose }: { source: CitationPreviewSource; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const original = privateCitationSourceUrl(source.originalUrl);
  const url = original?.url;
  const externalUrl = publicSourceUrl(source.externalUrl);
  const pageNumber = source.pageNumber ?? original?.pageNumber;
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); trigger?.focus(); };
  }, []);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
        if (!response.ok) {
          if (active) setState({ status: "error", message: response.status === 401
            ? "Sign in again to view this document, then try again."
            : response.status === 404 ? "This source is no longer available to view. It may have been replaced or access may have changed."
            : "We could not load this document preview. Please try again." });
          return;
        }
        const bytes = await readBoundedPdf(response);
        if (active) setState({ status: "loaded", bytes });
      } catch {
        if (active && !controller.signal.aborted) setState({ status: "error", message: "We could not load this document preview. Please try again." });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [url, attempt]);
  return <dialog ref={dialogRef} aria-labelledby={titleId} onKeyDown={event => {
    if (event.key !== "Tab") return;
    // Native modal dialogs make the background inert, but some browsers allow
    // Tab at either edge to leave document focus for browser chrome.
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex], summary',
    )].filter(element => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last && first) {
      event.preventDefault(); first.focus();
    }
  }} onCancel={event => { event.preventDefault(); closeRef.current(); }}
    className="fixed inset-0 m-auto h-[100dvh] max-h-[100dvh] w-screen max-w-none overflow-hidden border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 sm:h-[92dvh] sm:max-w-6xl sm:rounded-xl">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Original source</p>
          <h2 id={titleId} className="mt-1 break-words text-base font-semibold">{source.label}</h2>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close source preview" className="shrink-0"><X aria-hidden="true" className="size-5" /></Button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-5">
        {!url ? <div className="mx-auto max-w-lg space-y-3 py-12 text-sm leading-6">
          <p>An original document preview is not available for this citation.</p>
          <p className="text-muted-foreground">Older answers may not have a saved document reference. No passage has been highlighted.</p>
          {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">Open source website (opens in a new tab)</a>}
        </div> : state.status === "loading" ? <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm"><Spinner className="size-4" />Loading original document…</div>
          : state.status === "error" ? <div className="mx-auto max-w-lg space-y-4 py-12"><p role="alert" className="text-sm leading-6">{state.message}</p><Button type="button" variant="outline" onClick={() => { setState({ status: "loading" }); setAttempt(value => value + 1); }}>Try again</Button></div>
          : <>
            {!source.passages?.length && <p className="mb-4 text-sm leading-6 text-muted-foreground">{pageNumber
              ? "A cited page is available, but no exact supporting passage was saved. No text is highlighted."
              : "No page or exact supporting passage was saved. You can browse the original document."}</p>}
            <PdfPreviewBoundary><Suspense fallback={<p role="status" className="py-8 text-center text-sm">Preparing PDF preview…</p>}>
              <CitationPdfPage bytes={state.bytes} initialPage={pageNumber} passages={source.passages} />
            </Suspense></PdfPreviewBoundary>
          </>}
      </div>
      {url && <footer className="shrink-0 border-t px-4 py-3 sm:px-6"><a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open full document (opens in a new tab)" className="inline-flex items-center gap-2 text-sm font-medium underline underline-offset-4">Open full document <ExternalLink aria-hidden="true" className="size-4" /></a></footer>}
    </div>
  </dialog>;
}
