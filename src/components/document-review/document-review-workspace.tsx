"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, ListChecks, MessageSquare, Printer,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CitationSourcePreview, type CitationPreviewSource } from "@/components/chat/citation-source-preview";
import {
  FINDING_STATUSES,
  FINDING_STATUS_DESCRIPTIONS,
  FINDING_STATUS_LABELS,
  FINDING_STATUS_ORDER,
  NOT_SURE_ROLE,
  countFindings,
  documentReviewSourceUrl,
  sortFindings,
  type FindingStatus,
} from "../../../shared/document-review";
import { FINDING_HIGHLIGHT_CLASSES, FINDING_MARKER_CLASSES, FindingStatusBadge } from "./review-status";
import { buildDocumentReviewReport, downloadDocumentReviewReport, printDocumentReviewReport } from "./document-review-report";

type ReviewData = NonNullable<FunctionReturnType<typeof api.documentReviews.get>>;
type Finding = ReviewData["findings"][number];
type Segment = ReviewData["segments"][number];
type Filter = "all" | FindingStatus;
type SortOrder = "severity" | "document";

const STATUS_BY_SEVERITY = [...FINDING_STATUSES].sort((left, right) => FINDING_STATUS_ORDER[left] - FINDING_STATUS_ORDER[right]);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function segmentLabel(segment: Segment | undefined): string {
  if (!segment) return "";
  return segment.ref ?? `¶${segment.ordinal + 1}`;
}

function relationLabel(citation: Finding["citations"][number]): string {
  if (citation.relation === "selected") return citation.jurisdictionName;
  if (citation.relation === "geographic_ancestor") return `${citation.jurisdictionName} · wider jurisdiction`;
  return `${citation.jurisdictionName} · organization geography`;
}

/** The question placed in the composer by “Ask about this”. */
export function askAboutFindingPrompt(finding: Pick<Finding, "title" | "kind">, segment: Pick<Segment, "ref"> | undefined, filename: string): string {
  if (finding.kind === "missing") return `My ${filename} doesn't seem to cover "${finding.title}". What does the law say, and what should I ask for?`;
  const where = segment?.ref ? `part ${segment.ref} ("${finding.title}")` : `"${finding.title}"`;
  return `Can you explain ${where} in ${filename}, and what I can do about it?`;
}

interface WorkspaceProps {
  reviewId: Id<"documentReviews">;
  onClose: () => void;
  /** Closes the review and puts a follow-up question in the composer. */
  onAsk: (prompt: string) => void;
}

export function DocumentReviewWorkspace({ reviewId, onClose, onAsk }: WorkspaceProps) {
  const data = useQuery(api.documentReviews.get, { reviewId });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    }
    return () => {
      if (dialog?.open) { if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }
      trigger?.focus();
    };
  }, []);

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none overflow-hidden bg-background p-0 text-foreground backdrop:bg-black/40">
      {data === undefined ? (
        <div role="status" className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <h2 id={titleId} className="sr-only">Document review</h2>
          <Spinner />Loading the review…
        </div>
      ) : data === null ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <h2 id={titleId} className="text-lg font-semibold">This review isn&apos;t available</h2>
          <p className="max-w-sm text-sm text-muted-foreground">It may have been deleted, or your access to this chat may have changed.</p>
          <Button type="button" variant="outline" onClick={onClose}>Back to chat</Button>
        </div>
      ) : (
        <ReviewLayout data={data} titleId={titleId} onClose={onClose} onAsk={onAsk} />
      )}
    </dialog>
  );
}

function ReviewLayout({ data, titleId, onClose, onAsk }: { data: ReviewData; titleId: string; onClose: () => void; onAsk: (prompt: string) => void }) {
  const { review } = data;
  const [filter, setFilter] = useState<Filter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("severity");
  const [selectedId, setSelectedId] = useState<Id<"documentReviewFindings"> | null>(null);
  const [mobilePane, setMobilePane] = useState<"document" | "findings">("findings");
  const [sourcePreview, setSourcePreview] = useState<CitationPreviewSource | null>(null);
  const documentPaneRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => new Map(data.segments.map((segment) => [segment.ordinal, segment])), [data.segments]);
  const counts = useMemo(() => countFindings(data.findings), [data.findings]);
  const ordered = useMemo(() => {
    const sorted = sortFindings(data.findings, sortOrder);
    // Passages first, then anything missing from the document.
    return [...sorted.filter((finding) => finding.kind === "passage"), ...sorted.filter((finding) => finding.kind === "missing")];
  }, [data.findings, sortOrder]);
  const visible = useMemo(() => filter === "all" ? ordered : ordered.filter((finding) => finding.status === filter), [ordered, filter]);
  const selected = visible.find((finding) => finding.id === selectedId) ?? visible[0] ?? null;
  const selectedIndex = selected ? visible.indexOf(selected) : -1;
  const bySegment = useMemo(() => {
    const map = new Map<number, Finding[]>();
    for (const finding of sortFindings(data.findings, "severity")) {
      if (finding.segmentOrdinal === undefined) continue;
      map.set(finding.segmentOrdinal, [...(map.get(finding.segmentOrdinal) ?? []), finding]);
    }
    return map;
  }, [data.findings]);

  const scrollToSegment = useCallback((ordinal: number | undefined) => {
    if (ordinal === undefined) return;
    const element = documentPaneRef.current?.querySelector<HTMLElement>(`[data-segment="${ordinal}"]`);
    element?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  const select = useCallback((finding: Finding, from: "document" | "list") => {
    setSelectedId(finding.id);
    if (from === "list") {
      scrollToSegment(finding.segmentOrdinal);
      detailRef.current?.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } else {
      setMobilePane("findings");
      window.requestAnimationFrame(() => detailRef.current?.focus({ preventScroll: false }));
    }
  }, [scrollToSegment]);

  const step = (offset: number) => {
    const next = visible[selectedIndex + offset];
    if (next) select(next, "list");
  };

  const reportHtml = () => buildDocumentReviewReport({
    filename: review.filename,
    documentType: review.documentType,
    title: review.title,
    roleLabel: review.roleLabel,
    focusLabels: review.focusLabels,
    jurisdictionName: review.jurisdictionName,
    headline: review.headline,
    overview: data.overview,
    nextSteps: data.nextSteps,
    partialCoverage: data.partialCoverage,
    completedAt: review.completedAt,
    segments: data.segments,
    findings: data.findings,
  });

  const meta = [
    review.roleLabel && review.roleLabel !== NOT_SURE_ROLE.label ? `Reviewed for: ${review.roleLabel}` : review.documentType,
    review.jurisdictionName,
    `${review.checkTotal || data.segments.length} ${(review.checkTotal || data.segments.length) === 1 ? "part" : "parts"} checked`,
  ].filter(Boolean).join(" · ");
  const passageFindings = visible.filter((finding) => finding.kind === "passage");
  const missingFindings = visible.filter((finding) => finding.kind === "missing");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 sm:px-6">
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Back to chat" className="size-10 shrink-0">
          <ArrowLeft className="size-[18px]" aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <h2 id={titleId} className="truncate text-[15px] font-semibold" title={review.filename}>{review.filename}</h2>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        <div className="flex items-center gap-2 lg:order-last">
          <a href={`/api/chat/attachments/${encodeURIComponent(review.attachmentId)}`} target="_blank" rel="noopener noreferrer"
            className="hidden min-h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex">
            Open original<ExternalLink className="size-3.5" aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
          </a>
          <ExportMenu onPrint={() => printDocumentReviewReport(reportHtml())} onDownload={() => downloadDocumentReviewReport(reportHtml(), review.filename)} />
        </div>
        <nav aria-label="Filter findings" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 scrollbar-hide lg:order-none lg:mx-0 lg:w-auto lg:px-0">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")} label="All" count={data.findings.length} />
          {STATUS_BY_SEVERITY.map((status) => (
            <FilterButton key={status} active={filter === status} onClick={() => setFilter(status)}
              label={FINDING_STATUS_LABELS[status]} count={counts[status]} disabled={counts[status] === 0} status={status} />
          ))}
        </nav>
      </header>

      <div className="flex shrink-0 border-b p-1.5 md:hidden" role="group" aria-label="Show">
        {(["document", "findings"] as const).map((pane) => (
          <button key={pane} type="button" aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)}
            className={cn("flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mobilePane === pane ? "bg-muted text-foreground" : "text-muted-foreground")}>
            {pane === "document" ? <FileText className="size-4" aria-hidden="true" /> : <ListChecks className="size-4" aria-hidden="true" />}
            {pane === "document" ? "Document" : `Findings · ${data.findings.length}`}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <section ref={documentPaneRef} aria-label="Your document"
          className={cn("min-h-0 min-w-0 flex-[1.4] overflow-y-auto bg-muted/60 px-3 py-5 sm:px-8 sm:py-8", mobilePane === "document" ? "block" : "hidden md:block")}>
          <DocumentPaper segments={data.segments} bySegment={bySegment} filter={filter} selected={selected}
            onSelect={(finding) => select(finding, "document")} title={review.title} />
        </section>

        <aside aria-label="Findings" className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l bg-background md:flex md:max-w-[34rem]",
          mobilePane === "findings" ? "flex" : "hidden")}>
          <SummaryBlock data={data} />

          {selected ? (
            <div ref={detailRef} tabIndex={-1} className="scroll-mt-2 border-b focus:outline-none" aria-live="polite">
              <FindingDetail finding={selected} segment={selected.segmentOrdinal === undefined ? undefined : segments.get(selected.segmentOrdinal)}
                reviewId={review.id}
                onSource={setSourcePreview}
                onShowInDocument={selected.segmentOrdinal === undefined ? undefined : () => { setMobilePane("document"); window.requestAnimationFrame(() => scrollToSegment(selected.segmentOrdinal)); }}
                onAsk={() => onAsk(askAboutFindingPrompt(selected, selected.segmentOrdinal === undefined ? undefined : segments.get(selected.segmentOrdinal), review.filename))} />
              <div className="flex items-center justify-between gap-2 px-4 pb-4 sm:px-5">
                <Button type="button" variant="ghost" size="sm" className="min-h-9" disabled={selectedIndex <= 0} onClick={() => step(-1)}>
                  <ChevronLeft className="mr-1 size-4" aria-hidden="true" />Previous
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">{selectedIndex + 1} of {visible.length}</span>
                <Button type="button" variant="ghost" size="sm" className="min-h-9" disabled={selectedIndex >= visible.length - 1} onClick={() => step(1)}>
                  Next<ChevronRight className="ml-1 size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : (
            <p className="border-b px-5 py-8 text-center text-sm text-muted-foreground">
              {data.findings.length ? "No findings match this filter." : "This review didn't record any findings."}
            </p>
          )}

          {passageFindings.length > 0 && (
            <FindingList heading="In the document" findings={passageFindings} segments={segments} selectedId={selected?.id}
              onSelect={(finding) => select(finding, "list")}
              action={(
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="sr-only sm:not-sr-only">Sort</span>
                  <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}
                    className="h-8 rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="severity">Most serious first</option>
                    <option value="document">Document order</option>
                  </select>
                </label>
              )} />
          )}
          {missingFindings.length > 0 && (
            <FindingList heading="Missing from the document" description="Things the law expects that this document doesn't mention."
              findings={missingFindings} segments={segments} selectedId={selected?.id} onSelect={(finding) => select(finding, "list")} />
          )}

          <p className="mt-auto border-t px-4 py-3.5 text-xs leading-5 text-muted-foreground sm:px-5">
            Select a highlighted part of the document or a finding here to move between them. General legal information, not legal advice.
          </p>
        </aside>
      </div>

      {sourcePreview && <CitationSourcePreview key={sourcePreview.originalUrl} source={sourcePreview} onClose={() => setSourcePreview(null)} />}
    </div>
  );
}

function FilterButton({ active, onClick, label, count, disabled, status }: {
  active: boolean; onClick: () => void; label: string; count: number; disabled?: boolean; status?: FindingStatus;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} disabled={disabled && !active}
      className={cn("inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
      {status && <span aria-hidden="true" className={cn("size-2 rounded-full", FINDING_MARKER_CLASSES[status])} />}
      {label}
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function ExportMenu({ onPrint, onDownload }: { onPrint: () => void; onDownload: () => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choose = (action: () => void) => { setOpen(false); action(); };
  return (
    <div ref={containerRef} className="relative"
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); event.preventDefault(); setOpen(false); } }}>
      <Button type="button" size="sm" className="min-h-9" aria-haspopup="true" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((value) => !value)}>
        Export<ChevronDown className="ml-1.5 size-3.5" aria-hidden="true" />
      </Button>
      {open && (
        <div id={menuId} className="absolute right-0 top-full z-10 mt-1.5 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          <button type="button" onClick={() => choose(onPrint)} autoFocus
            className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
            <Printer className="size-4 text-muted-foreground" aria-hidden="true" />Print or save as PDF
          </button>
          <button type="button" onClick={() => choose(onDownload)}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
            <Download className="size-4 text-muted-foreground" aria-hidden="true" />Download report (.html)
          </button>
        </div>
      )}
    </div>
  );
}

function DocumentPaper({ segments, bySegment, filter, selected, onSelect, title }: {
  segments: Segment[];
  bySegment: Map<number, Finding[]>;
  filter: Filter;
  selected: Finding | null;
  onSelect: (finding: Finding) => void;
  title?: string;
}) {
  if (!segments.length) {
    return <p className="mx-auto max-w-[44rem] py-16 text-center text-sm text-muted-foreground">The text of this document isn&apos;t available.</p>;
  }
  let lastPage: number | undefined;
  return (
    <article className="mx-auto w-full max-w-[44rem] rounded border bg-card px-5 py-8 text-[14px] leading-[1.75] text-card-foreground shadow-[0_1px_3px_rgba(3,7,18,0.06)] sm:px-12 sm:py-12">
      {title && <h3 className="mb-6 text-base font-semibold tracking-tight">{title}</h3>}
      {segments.map((segment) => {
        const pageMarker = segment.page !== undefined && segment.page !== lastPage
          ? <p className="mb-2 mt-6 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:mt-0">Page {segment.page}</p> : null;
        lastPage = segment.page ?? lastPage;
        const findings = bySegment.get(segment.ordinal) ?? [];
        const shown = filter === "all" ? findings : findings.filter((finding) => finding.status === filter);
        const lead = shown[0];
        const isSelected = Boolean(selected && selected.segmentOrdinal === segment.ordinal);
        const text = <>{segment.text}{segment.excerpt ? <span className="text-muted-foreground"> […]</span> : null}</>;
        return (
          <Fragment key={segment.ordinal}>
            {pageMarker}
            <div data-segment={segment.ordinal} className="mb-4 scroll-my-24">
              {segment.heading && <h4 className="mb-1.5 mt-5 text-[15px] font-semibold">{segment.heading}</h4>}
              {lead ? (
                <button type="button" onClick={() => onSelect(isSelected && selected ? selected : lead)} aria-current={isSelected ? "true" : undefined}
                  className={cn("block w-full whitespace-pre-wrap rounded-[4px] px-1.5 py-0.5 text-left transition-shadow -mx-1.5 [overflow-wrap:anywhere]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    FINDING_HIGHLIGHT_CLASSES[lead.status], isSelected ? "ring-2" : "ring-0 hover:ring-1")}>
                  <span className={cn("mr-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 align-[1px] font-mono text-[11px] font-semibold",
                    FINDING_MARKER_CLASSES[lead.status])}>{segmentLabel(segment)}</span>
                  <span className="sr-only">{FINDING_STATUS_LABELS[lead.status]}: {lead.title}{shown.length > 1 ? ` and ${shown.length - 1} more` : ""}. </span>
                  {text}
                </button>
              ) : (
                <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", findings.length && "text-foreground/90")}>
                  {segment.ref && !segment.heading?.startsWith(segment.ref) ? <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{segment.ref}</span> : null}
                  {text}
                </p>
              )}
            </div>
          </Fragment>
        );
      })}
    </article>
  );
}

function SummaryBlock({ data }: { data: ReviewData }) {
  const { review } = data;
  const counts = countFindings(data.findings);
  return (
    <section aria-label="Summary" className="border-b bg-muted/30 px-4 py-4 sm:px-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</p>
      <h3 className="mt-1 text-[15px] font-semibold leading-6">{review.headline ?? "Review complete"}</h3>
      {data.overview && <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{data.overview}</p>}
      <ul aria-label="Findings by status" className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
        {STATUS_BY_SEVERITY.filter((status) => counts[status] > 0).map((status) => (
          <li key={status}><FindingStatusBadge status={status} count={counts[status]} /></li>
        ))}
      </ul>
      {data.nextSteps.length > 0 && (
        <details className="group mt-3">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />Next steps ({data.nextSteps.length})
          </summary>
          <ol className="mt-1 list-decimal space-y-1.5 pl-9 text-sm leading-6">
            {data.nextSteps.map((stepText, index) => <li key={index}>{stepText}</li>)}
          </ol>
        </details>
      )}
      {data.partialCoverage && (
        <p role="note" className="mt-3 border-l-2 border-amber-700 pl-3 text-xs leading-5 text-muted-foreground">
          Some sources for this jurisdiction were unavailable during the review, so coverage may be incomplete.
        </p>
      )}
      {review.focusLabels.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Focus areas: {review.focusLabels.join(", ")}</p>}
    </section>
  );
}

function FindingDetail({ finding, segment, reviewId, onSource, onShowInDocument, onAsk }: {
  finding: Finding;
  segment: Segment | undefined;
  reviewId: Id<"documentReviews">;
  onSource: (source: CitationPreviewSource) => void;
  onShowInDocument?: () => void;
  onAsk: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [finding.id]);
  const copy = async () => {
    if (!finding.suggestedWording) return;
    try {
      await navigator.clipboard.writeText(finding.suggestedWording);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch { setCopied(false); }
  };
  return (
    <article aria-label={`Finding: ${finding.title}`} className="flex flex-col gap-3 px-4 pb-3 pt-4 sm:px-5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 min-w-8 shrink-0 font-mono text-xs font-medium text-muted-foreground">
          {finding.kind === "missing" ? "Gap" : segmentLabel(segment)}
        </span>
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-6">{finding.title}</h3>
        <FindingStatusBadge status={finding.status} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{FINDING_STATUS_DESCRIPTIONS[finding.status]}</p>
      <p className="text-sm leading-6">{finding.meaning}</p>

      <div className="rounded-lg bg-muted/70 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">The law</p>
        <p className="mt-1 text-[13px] leading-6">{finding.lawSummary}</p>
        {finding.citations.length > 0 && (
          <ul className="mt-2 space-y-1.5 text-[13px] leading-5">
            {finding.citations.map((citation, index) => {
              const text = `${citation.label}${citation.provision ? `, ${citation.provision}` : ""}`;
              return (
                <li key={`${citation.label}:${index}`} className="flex flex-col">
                  {citation.previewable ? (
                    <button type="button" className="w-fit rounded-sm text-left font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
                      aria-label={`Preview source: ${text}`}
                      onClick={() => onSource({ label: citation.label, originalUrl: documentReviewSourceUrl(reviewId, finding.id, index, citation.pageNumber), ...(citation.pageNumber ? { pageNumber: citation.pageNumber } : {}) })}>
                      {text}
                    </button>
                  ) : <span className="font-medium [overflow-wrap:anywhere]">{text}</span>}
                  <span className="text-xs text-muted-foreground">{relationLabel(citation)}{citation.pageNumber ? ` · page ${citation.pageNumber}` : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-[13px] leading-6"><strong className="font-semibold">What to do:</strong> {finding.recommendation}</p>

      {finding.suggestedWording && (
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Suggested wording</p>
            <Button type="button" variant="ghost" size="sm" className="-my-1 h-8" onClick={() => void copy()}>
              {copied ? <Check className="mr-1.5 size-3.5" aria-hidden="true" /> : <Copy className="mr-1.5 size-3.5" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6">{finding.suggestedWording}</p>
          <span className="sr-only" aria-live="polite">{copied ? "Suggested wording copied" : ""}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={onAsk}>
          <MessageSquare className="mr-1.5 size-3.5" aria-hidden="true" />Ask about this
        </Button>
        {onShowInDocument && (
          <Button type="button" variant="outline" size="sm" className="min-h-9 md:hidden" onClick={onShowInDocument}>
            <FileText className="mr-1.5 size-3.5" aria-hidden="true" />Show in document
          </Button>
        )}
      </div>
    </article>
  );
}

function FindingList({ heading, description, findings, segments, selectedId, onSelect, action }: {
  heading: string;
  description?: string;
  findings: Finding[];
  segments: Map<number, Segment>;
  selectedId?: Id<"documentReviewFindings">;
  onSelect: (finding: Finding) => void;
  action?: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4 sm:px-5">
        <div>
          <h3 id={headingId} className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{heading} · {findings.length}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <ul className="m-0 list-none border-t p-0">
        {findings.map((finding) => {
          const segment = finding.segmentOrdinal === undefined ? undefined : segments.get(finding.segmentOrdinal);
          const active = finding.id === selectedId;
          return (
            <li key={finding.id}>
              <button type="button" onClick={() => onSelect(finding)} aria-current={active ? "true" : undefined}
                className={cn("flex min-h-12 w-full items-center gap-2.5 border-b px-4 py-2 text-left text-sm transition-colors sm:px-5",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active ? "bg-muted" : "hover:bg-muted/50")}>
                <span className="w-9 shrink-0 truncate font-mono text-xs text-muted-foreground">{finding.kind === "missing" ? "—" : segmentLabel(segment)}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{finding.title}</span>
                <FindingStatusBadge status={finding.status} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
