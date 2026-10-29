"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ClipboardCheck, Download, FileText, MessageSquare, Pencil, Sparkles, Trash2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CitationSourcePreview, type CitationPreviewSource } from "@/components/chat/citation-source-preview";
import {
  CLAUSE_BASIS_DESCRIPTIONS,
  DOCUMENT_DRAFT_LIMITS,
  countPlaceholders,
  documentDraftSourceUrl,
} from "../../../shared/document-draft";
import { clauseHeadingLine, numberClauses, type ExportPaper, type ExportStyle } from "@/lib/document-export/model";
import { CLAUSE_BASIS_MARKER_CLASSES, ClauseBasisBadge } from "./draft-status";
import { useDraftAction } from "./document-draft-card";
import { exportDraft, type DraftData, type ExportFormat } from "./draft-export";
import { BlankFields, ClauseParts, uniqueBlanks, type ActiveBlank } from "./draft-blanks";

type Clause = DraftData["clauses"][number];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function relationLabel(citation: Clause["citations"][number]): string {
  if (citation.relation === "selected") return citation.jurisdictionName;
  if (citation.relation === "geographic_ancestor") return `${citation.jurisdictionName} · wider jurisdiction`;
  return `${citation.jurisdictionName} · organization geography`;
}

/** Clause wording quoted in a follow-up question; the chat accepts questions up to 4,000 characters. */
const ASK_CLAUSE_TEXT_LIMIT = 2_800;

/**
 * The question placed in the composer by "Ask about this". It quotes the clause's current
 * wording, including the person's own edits, so the answer is about what the draft actually says.
 */
export function askAboutClausePrompt(clause: Pick<Clause, "heading" | "text" | "edited">, title: string): string {
  const name = clause.heading.trim() || "untitled";
  const text = clause.text.trim();
  const quoted = text.length > ASK_CLAUSE_TEXT_LIMIT ? `${text.slice(0, ASK_CLAUSE_TEXT_LIMIT).trimEnd()} […]` : text;
  return `In my draft ${title}, the "${name}" clause${clause.edited ? ", as I have edited it," : ""} reads:\n\n"""\n${quoted}\n"""\n\nCan you explain what this wording means and whether it fits what the law says?`;
}

interface WorkspaceProps {
  draftId: Id<"documentDrafts">;
  onClose: () => void;
  /** Closes the workspace and puts a follow-up question in the composer. */
  onAsk: (prompt: string) => void;
}

export function DocumentDraftWorkspace({ draftId, onClose, onAsk }: WorkspaceProps) {
  const data = useQuery(api.documentDrafts.get, { draftId });
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
          <h2 id={titleId} className="sr-only">Document draft</h2>
          <Spinner />Loading the draft…
        </div>
      ) : data === null || data.draft.status !== "completed" ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <h2 id={titleId} className="text-lg font-semibold">This draft isn&apos;t available</h2>
          <p className="max-w-sm text-sm text-muted-foreground">It may still be drafting, it may have been deleted, or your access to this chat may have changed.</p>
          <Button type="button" variant="outline" onClick={onClose}>Back to chat</Button>
        </div>
      ) : (
        <DraftLayout data={data} titleId={titleId} onClose={onClose} onAsk={onAsk} />
      )}
    </dialog>
  );
}

function DraftLayout({ data, titleId, onClose, onAsk }: { data: DraftData; titleId: string; onClose: () => void; onAsk: (prompt: string) => void }) {
  const { draft } = data;
  const [selectedId, setSelectedId] = useState<Id<"documentDraftClauses"> | null>(null);
  const [panel, setPanel] = useState<"clause" | "sign">("clause");
  const [mobilePane, setMobilePane] = useState<"document" | "details">("document");
  const [exportOpen, setExportOpen] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<CitationPreviewSource | null>(null);
  const [activeBlank, setActiveBlank] = useState<ActiveBlank | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);

  const numbered = useMemo(() => {
    const labels = numberClauses(data.clauses.map((clause) => ({ ...clause, basisLabel: "", sources: [] })));
    return data.clauses.map((clause, index) => ({ clause, line: clauseHeadingLine(labels[index]!) }));
  }, [data.clauses]);
  const selected = data.clauses.find((clause) => clause.id === selectedId) ?? data.clauses[0] ?? null;
  const selectedLine = numbered.find((entry) => entry.clause.id === selected?.id)?.line ?? "";
  const blanks = useMemo(() => countPlaceholders(data.clauses.map((clause) => clause.text)), [data.clauses]);
  const title = draft.title ?? "Document";

  const select = (clause: Clause, blankKey?: string) => {
    setSelectedId(clause.id);
    setPanel("clause");
    setMobilePane("details");
    window.requestAnimationFrame(() => {
      const field = blankKey === undefined ? undefined
        : [...(detailRef.current?.querySelectorAll<HTMLInputElement>("input[data-blank-input]") ?? [])]
          .find((input) => input.getAttribute("data-blank-input") === blankKey);
      (field ?? detailRef.current)?.focus({ preventScroll: false });
    });
  };
  const showInDocument = (clause: Clause) => {
    setMobilePane("document");
    window.requestAnimationFrame(() => paperRef.current?.querySelector<HTMLElement>(`[data-clause="${clause.id}"]`)
      ?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
  };

  const meta = [draft.documentType, draft.jurisdictionName, `Version ${draft.version}`, blanks ? `${blanks} ${blanks === 1 ? "blank" : "blanks"} to fill in` : ""]
    .filter(Boolean).join(" · ");

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 sm:px-6">
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Back to chat" className="size-10 shrink-0">
          <ArrowLeft className="size-[18px]" aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <h2 id={titleId} className="truncate text-[15px] font-semibold" title={title}>{title}</h2>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        <Button type="button" size="sm" className="min-h-9" onClick={() => setExportOpen(true)}>
          <Download className="mr-1.5 size-3.5" aria-hidden="true" />Export
        </Button>
      </header>

      <div className="flex shrink-0 border-b p-1.5 md:hidden" role="group" aria-label="Show">
        {(["document", "details"] as const).map((pane) => (
          <button key={pane} type="button" aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)}
            className={cn("flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mobilePane === pane ? "bg-muted text-foreground" : "text-muted-foreground")}>
            {pane === "document" ? <FileText className="size-4" aria-hidden="true" /> : <ClipboardCheck className="size-4" aria-hidden="true" />}
            {pane === "document" ? "Document" : "Details"}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <section ref={paperRef} aria-label="Your document"
          className={cn("min-h-0 min-w-0 flex-[1.4] overflow-y-auto bg-muted/60 px-3 py-5 sm:px-8 sm:py-8", mobilePane === "document" ? "block" : "hidden md:block")}>
          <article className="mx-auto w-full max-w-[44rem] rounded border bg-card px-5 py-8 text-[14px] leading-[1.75] text-card-foreground shadow-[0_1px_3px_rgba(3,7,18,0.06)] sm:px-12 sm:py-12">
            <h3 className="mb-6 text-center text-base font-semibold uppercase tracking-wide">{title}</h3>
            {numbered.map(({ clause, line }) => {
              const active = clause.id === selected?.id;
              return (
                <button key={clause.id} type="button" data-clause={clause.id} aria-current={active ? "true" : undefined}
                  onClick={(event) => select(clause, (event.target as Element).closest?.("[data-blank]")?.getAttribute("data-blank") ?? undefined)}
                  className={cn("group -mx-2 mb-3 block w-[calc(100%+1rem)] scroll-my-24 rounded-md px-2 py-1.5 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "bg-muted ring-1 ring-border" : "hover:bg-muted/50")}>
                  {line && (
                    <span className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
                      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", CLAUSE_BASIS_MARKER_CLASSES[clause.basis])} />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
                      {clause.revising && <Spinner className="size-3.5" />}
                    </span>
                  )}
                  <ClauseParts clause={clause} active={activeBlank} />
                </button>
              );
            })}
          </article>
        </section>

        <aside aria-label="Clause details" className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l bg-background md:flex md:max-w-[34rem]",
          mobilePane === "details" ? "flex" : "hidden")}>
          <div role="tablist" aria-label="Details" className="flex shrink-0 gap-1 border-b px-3 py-2 sm:px-4">
            <TabButton active={panel === "clause"} onClick={() => setPanel("clause")}>This clause</TabButton>
            <TabButton active={panel === "sign"} onClick={() => setPanel("sign")}>
              Before you sign{data.formalities.length ? <span className="tabular-nums text-muted-foreground">{data.formalities.length}</span> : null}
            </TabButton>
          </div>
          {panel === "clause" ? (
            selected ? (
              <div ref={detailRef} tabIndex={-1} className="focus:outline-none" aria-live="polite">
                <ClauseDetail key={selected.id} clause={selected} line={selectedLine} draftId={draft.id} canRemove={data.clauses.length > 1}
                  numbered={numbered} activeBlank={activeBlank} onPreviewBlank={setActiveBlank} onSelect={select}
                  onSource={setSourcePreview} onShowInDocument={() => showInDocument(selected)}
                  onAsk={() => onAsk(askAboutClausePrompt(selected, title))} />
              </div>
            ) : <p className="px-5 py-8 text-center text-sm text-muted-foreground">This draft has no clauses.</p>
          ) : (
            <BeforeYouSign data={data} blanks={blanks} />
          )}
          <p className="mt-auto border-t px-4 py-3.5 text-xs leading-5 text-muted-foreground sm:px-5">
            {draft.audience === "professional"
              ? "A working draft for professional review. Check the current law and the facts before it is used."
              : "A starting point, not legal advice. For anything important or unusual, ask a lawyer to review it."}
          </p>
        </aside>
      </div>

      {exportOpen && <ExportPanel data={data} blanks={blanks} onClose={() => setExportOpen(false)} />}
      {sourcePreview && <CitationSourcePreview key={sourcePreview.originalUrl} source={sourcePreview} onClose={() => setSourcePreview(null)} />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className={cn("inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
      {children}
    </button>
  );
}

function ClauseDetail({ clause, line, draftId, canRemove, numbered, activeBlank, onPreviewBlank, onSelect, onSource, onShowInDocument, onAsk }: {
  clause: Clause;
  line: string;
  draftId: Id<"documentDrafts">;
  canRemove: boolean;
  numbered: { clause: Clause; line: string }[];
  activeBlank: ActiveBlank | null;
  onPreviewBlank: (active: ActiveBlank | null) => void;
  onSelect: (clause: Clause, blankKey?: string) => void;
  onSource: (source: CitationPreviewSource) => void;
  onShowInDocument: () => void;
  onAsk: () => void;
}) {
  const updateClause = useMutation(api.documentDrafts.updateClause);
  const removeClause = useMutation(api.documentDrafts.removeClause);
  const reviseClause = useMutation(api.documentDrafts.reviseClause);
  const action = useDraftAction();
  const [mode, setMode] = useState<"view" | "edit" | "revise" | "remove">("view");
  const [heading, setHeading] = useState(clause.heading);
  const [text, setText] = useState(clause.text);
  const [instruction, setInstruction] = useState("");
  const headingId = useId();
  const textId = useId();
  const instructionId = useId();
  const busy = action.pending || clause.revising;

  return (
    <article aria-label={`Clause: ${line || clause.heading}`} className="flex flex-col gap-3 px-4 pb-4 pt-4 sm:px-5">
      <div className="flex items-start gap-2.5">
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-6 [overflow-wrap:anywhere]">{line || clause.heading || "Untitled part"}</h3>
        <ClauseBasisBadge basis={clause.basis} />
      </div>
      {mode !== "edit" && uniqueBlanks(clause).length > 0 && (
        <>
          {/* The document is a separate pane on phones, so the wording shows here as it is filled in. */}
          <div className="rounded-lg bg-muted/70 p-3 text-sm leading-6 md:hidden"><ClauseParts clause={clause} active={activeBlank} /></div>
          <BlankFields clause={clause} numbered={numbered} onPreview={onPreviewBlank} onSelect={onSelect} />
        </>
      )}
      <p className="text-xs leading-5 text-muted-foreground">{CLAUSE_BASIS_DESCRIPTIONS[clause.basis]}</p>
      {clause.why && <p className="text-sm leading-6">{clause.why}</p>}

      {(clause.lawSummary || clause.citations.length > 0) && (
        <div className="rounded-lg bg-muted/70 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">The law</p>
          {clause.lawSummary && <p className="mt-1 text-[13px] leading-6">{clause.lawSummary}</p>}
          {clause.citations.length > 0 && (
            <ul className="mt-2 space-y-1.5 text-[13px] leading-5">
              {clause.citations.map((citation, index) => {
                const label = `${citation.label}${citation.provision ? `, ${citation.provision}` : ""}`;
                return (
                  <li key={`${citation.label}:${index}`} className="flex flex-col">
                    {citation.previewable ? (
                      <button type="button" className="w-fit rounded-sm text-left font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
                        aria-label={`Preview source: ${label}`}
                        onClick={() => onSource({ label: citation.label, originalUrl: documentDraftSourceUrl(draftId, clause.id, index, citation.pageNumber), ...(citation.pageNumber ? { pageNumber: citation.pageNumber } : {}) })}>
                        {label}
                      </button>
                    ) : <span className="font-medium [overflow-wrap:anywhere]">{label}</span>}
                    <span className="text-xs text-muted-foreground">{relationLabel(citation)}{citation.pageNumber ? ` · page ${citation.pageNumber}` : ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {clause.edited && (
        <p role="note" className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
          You edited this clause. Its sources were checked against the earlier wording, so read them again if the meaning changed.
        </p>
      )}
      {clause.revising && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Rewriting this clause against the law…</p>}
      {clause.revisionFailed && !clause.revising && <p role="alert" className="text-sm text-destructive">The rewrite didn&apos;t finish. The clause is unchanged; you can try again.</p>}

      {mode === "edit" ? (
        <form className="flex flex-col gap-2.5 rounded-lg border p-3" onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => updateClause({ clauseId: clause.id, heading, text })).then((ok) => { if (ok) setMode("view"); });
        }}>
          <label htmlFor={headingId} className="text-xs font-medium">Heading</label>
          <input id={headingId} value={heading} onChange={(event) => setHeading(event.target.value)} maxLength={DOCUMENT_DRAFT_LIMITS.maxClauseHeading}
            className="h-9 rounded-md border bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <label htmlFor={textId} className="text-xs font-medium">Wording</label>
          <textarea id={textId} value={text} onChange={(event) => setText(event.target.value)} rows={8} maxLength={DOCUMENT_DRAFT_LIMITS.maxClauseCharacters}
            className="resize-y rounded-md border bg-background px-2.5 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <p className="text-xs text-muted-foreground">Fill in a [blank] by replacing it, brackets included.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setHeading(clause.heading); setText(clause.text); setMode("view"); action.clearError(); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !text.trim()}>{action.pending ? <Spinner className="mr-1.5 size-3.5" /> : null}Save</Button>
          </div>
        </form>
      ) : mode === "revise" ? (
        <form className="flex flex-col gap-2.5 rounded-lg border p-3" onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => reviseClause({ clauseId: clause.id, instruction })).then((ok) => { if (ok) { setInstruction(""); setMode("view"); } });
        }}>
          <label htmlFor={instructionId} className="text-xs font-medium">What should change?</label>
          <textarea id={instructionId} value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3} maxLength={DOCUMENT_DRAFT_LIMITS.maxInstructionCharacters}
            placeholder="e.g. Make the notice period two months and allow notice by email."
            className="resize-y rounded-md border bg-background px-2.5 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <p className="text-xs text-muted-foreground">The clause is rewritten and checked against the law again. This counts as one question.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setMode("view"); action.clearError(); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !instruction.trim()}>{action.pending ? <Spinner className="mr-1.5 size-3.5" /> : null}Rewrite clause</Button>
          </div>
        </form>
      ) : mode === "remove" ? (
        <div role="alertdialog" aria-label="Remove this clause?" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <p className="text-sm">Remove this clause from the document?</p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setMode("view")}>Keep it</Button>
            <Button type="button" variant="destructive" size="sm" disabled={busy}
              onClick={() => void action.run(() => removeClause({ clauseId: clause.id }))}>Remove</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={busy}
            onClick={() => { setHeading(clause.heading); setText(clause.text); setMode("edit"); }}>
            <Pencil className="mr-1.5 size-3.5" aria-hidden="true" />Edit
          </Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={busy} onClick={() => setMode("revise")}>
            <Sparkles className="mr-1.5 size-3.5" aria-hidden="true" />Ask for a change
          </Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={onAsk}>
            <MessageSquare className="mr-1.5 size-3.5" aria-hidden="true" />Ask about this
          </Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 md:hidden" onClick={onShowInDocument}>
            <FileText className="mr-1.5 size-3.5" aria-hidden="true" />Show in document
          </Button>
          {canRemove && (
            <Button type="button" variant="ghost" size="sm" className="min-h-9 text-muted-foreground" disabled={busy} onClick={() => setMode("remove")}>
              <Trash2 className="mr-1.5 size-3.5" aria-hidden="true" />Remove
            </Button>
          )}
        </div>
      )}
      {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
    </article>
  );
}

function BeforeYouSign({ data, blanks }: { data: DraftData; blanks: number }) {
  return (
    <section aria-label="Before you sign" className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      {blanks > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-[13px] leading-5 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100">
          Fill in the {blanks} highlighted {blanks === 1 ? "blank" : "blanks"} before the document is used.
        </p>
      )}
      {data.formalities.length ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {data.formalities.map((item, index) => (
            <li key={`${item.title}:${index}`} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold leading-6">{item.title}</p>
                <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium",
                  item.basis === "required" ? "bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200" : "bg-muted text-muted-foreground")}>
                  {item.basis === "required" ? "Required by law" : "Good practice"}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{item.detail}</p>
              {item.citations.length > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">{item.citations.map((citation) => citation.provision ? `${citation.label}, ${citation.provision}` : citation.label).join("; ")}</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">No signing steps were found in the library for this document. Check whether it needs witnesses, stamping or registration.</p>
      )}
      {data.partialCoverage && (
        <p role="note" className="border-l-2 border-amber-700 pl-3 text-xs leading-5 text-muted-foreground">
          Some sources for this jurisdiction were unavailable while drafting, so some clauses may not cite the law that applies.
        </p>
      )}
    </section>
  );
}

function OptionGroup<T extends string>({ legend, name, value, onChange, options }: {
  legend: string; name: string; value: T; onChange: (value: T) => void;
  options: { id: T; label: string; hint?: string; disabled?: boolean; tag?: string }[];
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-2 p-0 text-[13px] font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <label key={option.id} className={cn("relative flex min-h-11 cursor-pointer flex-col justify-center rounded-lg border px-3 py-2 text-sm transition-colors",
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            option.disabled ? "cursor-not-allowed opacity-50" : "",
            value === option.id ? "border-primary bg-secondary" : "border-border hover:bg-muted")}>
            <input type="radio" name={name} value={option.id} checked={value === option.id} disabled={option.disabled}
              onChange={() => onChange(option.id)} className="sr-only" />
            <span className="flex items-center gap-2 font-medium">{option.label}{option.tag && <span className="rounded bg-muted px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{option.tag}</span>}</span>
            {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ExportPanel({ data, blanks, onClose }: { data: DraftData; blanks: number; onClose: () => void }) {
  const usage = useQuery(api.usage.summary, {});
  const titleId = useId();
  const formatName = useId();
  const styleName = useId();
  const paperName = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restricted = usage ? usage.billingEnabled && !usage.isPro : false;
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [style, setStyle] = useState<ExportStyle>("modern");
  const [paper, setPaper] = useState<ExportPaper>("a4");
  const [includeCover, setIncludeCover] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenFormat = restricted ? "pdf" : format;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("input:not([disabled]), button")?.focus();
    return () => trigger?.focus();
  }, []);

  const download = async () => {
    setPending(true);
    setError(null);
    try {
      await exportDraft(data, chosenFormat, { style, paper, includeCover, includeNotes, watermark: chosenFormat === "pdf" && restricted });
      onClose();
    } catch (caught) {
      console.error("Failed to export draft:", caught);
      setError("We couldn't create the file. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border bg-background p-5 shadow-xl sm:rounded-xl sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 id={titleId} className="text-base font-semibold">Export document</h3>
          <Button type="button" variant="ghost" size="icon" className="size-9" aria-label="Close" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button>
        </div>

        <OptionGroup legend="Format" name={formatName} value={chosenFormat} onChange={setFormat} options={[
          { id: "pdf", label: "PDF", hint: "Ready to print and sign" },
          { id: "docx", label: "Word", hint: "Keep editing (.docx)", disabled: restricted, ...(restricted ? { tag: "Pro" } : {}) },
        ]} />
        <OptionGroup legend="Font" name={styleName} value={style} onChange={setStyle} options={[
          { id: "modern", label: "Modern", hint: "Sans serif" },
          { id: "classic", label: "Classic", hint: "Serif, traditional" },
        ]} />
        <OptionGroup legend="Paper" name={paperName} value={paper} onChange={setPaper} options={[
          { id: "a4", label: "A4" },
          { id: "letter", label: "US Letter" },
        ]} />

        <div className="flex flex-col gap-2.5">
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={includeCover} onChange={(event) => setIncludeCover(event.target.checked)} className="mt-1 size-4 accent-[hsl(var(--primary))]" />
            <span><span className="font-medium">Cover page</span><span className="block text-xs text-muted-foreground">What this document is and the steps before signing. You can remove it before signing.</span></span>
          </label>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} className="mt-1 size-4 accent-[hsl(var(--primary))]" />
            <span><span className="font-medium">Drafting notes</span><span className="block text-xs text-muted-foreground">Why each clause is there and the law it rests on, at the end.</span></span>
          </label>
        </div>

        {blanks > 0 && <p className="text-xs leading-5 text-muted-foreground">{blanks} {blanks === 1 ? "blank is" : "blanks are"} still to fill in. {blanks === 1 ? "It is" : "They are"} highlighted in the file.</p>}
        {restricted && (
          <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
            On the free plan, PDFs carry a light &quot;Draft&quot; mark. <Link href="/settings/billing" className="font-medium text-foreground underline underline-offset-4">Upgrade to Pro</Link> for clean PDFs and Word files.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending || usage === undefined} onClick={() => void download()}>
            {pending ? <Spinner className="mr-2 size-4" /> : <Download className="mr-2 size-4" aria-hidden="true" />}Download {chosenFormat === "pdf" ? "PDF" : "Word file"}
          </Button>
        </div>
      </div>
    </div>
  );
}
