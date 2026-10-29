"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { ArrowRight, CircleCheck, FilePen, RotateCcw, Square } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_DRAFT_FAILURE_MESSAGES,
  DRAFT_AUDIENCES,
  DRAFT_AUDIENCE_LABELS,
  NOT_SURE_SIDE,
  type DraftAudience,
  type DraftOption,
  type DraftQuestion,
} from "../../../shared/document-draft";
import { documentTypePhrase } from "@/components/document-review/document-review-card";
import { CLAUSE_BASIS_ORDER, ClauseBasisBadge } from "./draft-status";

export type DocumentDraftSummary = FunctionReturnType<typeof api.documentDrafts.listForChat>[number];

export function draftActionErrorMessage(error: unknown): string {
  const data = error instanceof ConvexError ? error.data as unknown : undefined;
  const code = typeof data === "string" ? data : data && typeof data === "object" && "code" in data ? String((data as { code: unknown }).code) : "";
  switch (code) {
    case "QUOTA_EXCEEDED": return "You have reached your question limit for today. Drafting a document, or asking for a clause to be rewritten, counts as one question.";
    case "DOCUMENT_DRAFT_RESEARCH_UNAVAILABLE": return DOCUMENT_DRAFT_FAILURE_MESSAGES.research_unavailable;
    case "DOCUMENT_DRAFT_LIMIT": return "This chat has reached its limit of drafts. Start a new chat to draft another document.";
    case "DOCUMENT_DRAFT_INVALID_CHOICE": return "One of those choices is no longer available. Reload the chat and try again.";
    case "DOCUMENT_DRAFT_NOT_READY":
    case "DOCUMENT_DRAFT_NOT_RETRYABLE": return "This draft has already moved on. It will update in a moment.";
    case "DOCUMENT_DRAFT_CLAUSE_BUSY": return "This clause is being rewritten. Wait for it to finish, then try again.";
    case "DOCUMENT_DRAFT_EMPTY_CLAUSE": return "A clause can't be empty. Remove it instead if you don't need it.";
    case "DOCUMENT_DRAFT_LAST_CLAUSE": return "A document needs at least one part, so this one can't be removed.";
    case "DOCUMENT_DRAFT_EMPTY_INSTRUCTION": return "Say what you'd like changed, then try again.";
    default: return "We couldn't update this draft. Check your connection and try again.";
  }
}

export function useDraftAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(draftActionErrorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, clearError: () => setError(null) };
}

function sideSummary(draft: DocumentDraftSummary): string {
  const parts: string[] = [];
  if (draft.roleLabel && draft.roleLabel !== NOT_SURE_SIDE.label) parts.push(`For: ${draft.roleLabel}`);
  if (draft.audience === "professional") parts.push("Professional drafting");
  return parts.join(" · ");
}

interface CardProps {
  draft: DocumentDraftSummary;
  /** Opens the draft workspace. */
  onOpen: (draftId: Id<"documentDrafts">) => void;
}

export function DocumentDraftCard({ draft, onOpen }: CardProps) {
  switch (draft.status) {
    case "planning": return <PlanningCard draft={draft} />;
    case "awaiting_input": return <SetupCard draft={draft} />;
    case "drafting": return <ProgressCard draft={draft} />;
    case "completed": return <CompletedCard draft={draft} onOpen={onOpen} />;
    case "failed":
    case "cancelled": return <StoppedCard draft={draft} />;
  }
}

function CardShell({ children, className, labelledBy, label }: { children: React.ReactNode; className?: string; labelledBy?: string; label?: string }) {
  return (
    <section aria-labelledby={labelledBy} aria-label={label}
      className={cn("w-full overflow-hidden rounded-xl border bg-card text-card-foreground shadow-[0_1px_2px_rgba(3,7,18,0.04),0_8px_24px_rgba(3,7,18,0.05)]", className)}>
      {children}
    </section>
  );
}

function DraftIcon() {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
      <FilePen className="size-5" aria-hidden="true" />
    </span>
  );
}

function BetaTag() {
  return <span className="ml-2 inline-flex h-5 items-center rounded bg-muted px-1.5 align-[2px] text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Beta</span>;
}

function PlanningCard({ draft }: { draft: DocumentDraftSummary }) {
  const titleId = useId();
  const cancel = useMutation(api.documentDrafts.cancel);
  const action = useDraftAction();
  return (
    <CardShell labelledBy={titleId}>
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <DraftIcon />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">Planning your document<BetaTag /></h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              Working out what kind of document this is, what it needs to cover under {draft.jurisdictionName} law, and what to ask you.
              {draft.attachmentFilename ? <> Reading <span className="font-medium text-foreground">{draft.attachmentFilename}</span> for background.</> : null}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={action.pending}
            onClick={() => void action.run(() => cancel({ draftId: draft.id }))}>Stop</Button>
        </div>
        <div role="status" className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Spinner className="size-4" />This usually takes under a minute.
        </div>
        <div aria-hidden="true" className="space-y-2.5">
          <div className="h-2.5 w-3/4 animate-pulse rounded-full bg-muted" />
          <div className="h-2.5 w-1/2 animate-pulse rounded-full bg-muted" />
          <div className="h-2.5 w-2/3 animate-pulse rounded-full bg-muted" />
        </div>
        {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
      </div>
    </CardShell>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function QuestionField({ question, value, onChange }: { question: DraftQuestion; value: string; onChange: (value: string) => void }) {
  const fieldId = useId();
  const helpId = useId();
  const inputClass = "w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const described = question.help ? helpId : undefined;
  let control: React.ReactNode;
  if (question.kind === "choice" && question.options.length) {
    control = (
      <div role="radiogroup" aria-labelledby={fieldId} aria-describedby={described} className="flex flex-wrap gap-2">
        {question.options.map((option) => (
          <label key={option} className={cn(
            "relative inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-[13px] transition-colors",
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            value === option ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
          )}>
            <input type="radio" name={fieldId} value={option} checked={value === option} onChange={() => onChange(option)} className="sr-only" />
            {option}
          </label>
        ))}
      </div>
    );
  } else if (question.kind === "longtext") {
    control = <textarea id={`${fieldId}-input`} aria-describedby={described} value={value} rows={3} maxLength={1000}
      onChange={(event) => onChange(event.target.value)} className={cn(inputClass, "resize-y py-2 leading-6")} />;
  } else {
    const date = question.kind === "date" && (!value || ISO_DATE.test(value));
    control = <input id={`${fieldId}-input`} aria-describedby={described} value={value} maxLength={1000}
      type={date ? "date" : "text"} inputMode={question.kind === "number" ? "decimal" : undefined}
      onChange={(event) => onChange(event.target.value)} className={cn(inputClass, "h-10")} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {question.kind === "choice" && question.options.length
        ? <span id={fieldId} className="text-[13px] font-medium">{question.label}</span>
        : <label id={fieldId} htmlFor={`${fieldId}-input`} className="text-[13px] font-medium">{question.label}</label>}
      {question.help && <p id={helpId} className="-mt-0.5 text-xs leading-5 text-muted-foreground">{question.help}</p>}
      {control}
    </div>
  );
}

function ChipRadio<T extends string>({ name, options, value, onChange }: { name: string; options: { id: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <label key={option.id} className={cn(
          "relative inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-4 text-sm font-medium transition-colors",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1",
          value === option.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
        )}>
          <input type="radio" name={name} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} className="sr-only" />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function initialSide(draft: DocumentDraftSummary): string {
  return draft.suggestedRoleId && draft.roleOptions.some((option) => option.id === draft.suggestedRoleId) ? draft.suggestedRoleId : NOT_SURE_SIDE.id;
}

function SetupCard({ draft }: { draft: DocumentDraftSummary }) {
  const titleId = useId();
  const sideName = useId();
  const audienceName = useId();
  const instructionsId = useId();
  const start = useMutation(api.documentDrafts.start);
  const cancel = useMutation(api.documentDrafts.cancel);
  const action = useDraftAction();
  const [sideId, setSideId] = useState(() => initialSide(draft));
  const [audience, setAudience] = useState<DraftAudience>(() => draft.suggestedAudience ?? "personal");
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(draft.questions.map((question) => [question.id, question.suggested ?? ""])));
  const [instructions, setInstructions] = useState("");
  const sides: DraftOption[] = draft.roleOptions.length ? [...draft.roleOptions, NOT_SURE_SIDE] : [];
  const legal = draft.isLegalDocument !== false;

  return (
    <CardShell labelledBy={titleId}>
      <form className="flex flex-col gap-5 p-5 sm:p-6" onSubmit={(event) => {
        event.preventDefault();
        void action.run(() => start({
          draftId: draft.id,
          roleId: sides.length ? sideId : undefined,
          audience,
          answers: draft.questions.map((question) => ({ questionId: question.id, value: answers[question.id] ?? "" })),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        }));
      }}>
        <div className="flex items-start gap-3.5">
          <DraftIcon />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">Drafting {documentTypePhrase(draft.documentType)}<BetaTag /></p>
            <h3 id={titleId} className="mt-1 text-[17px] font-semibold tracking-tight [overflow-wrap:anywhere]">{draft.title ?? "Your document"}</h3>
            {draft.summary && <p className="mt-1 text-sm leading-6 text-muted-foreground">{draft.summary}</p>}
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {legal
                ? `${draft.sectionCount} ${draft.sectionCount === 1 ? "part" : "parts"} planned, each drafted from the ${draft.jurisdictionName} laws in the library.`
                : `This may not need legal drafting, but we can still prepare it using the ${draft.jurisdictionName} laws in the library.`}
              {" "}Answer what you can. Anything left blank becomes a [blank] to fill in later.
            </p>
          </div>
        </div>

        {sides.length > 0 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2.5 p-0 text-[13px] font-medium">Who is this document for?</legend>
            <ChipRadio name={sideName} options={sides} value={sideId} onChange={setSideId} />
          </fieldset>
        )}

        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2.5 p-0 text-[13px] font-medium">Who is drafting it?</legend>
          <ChipRadio name={audienceName} value={audience} onChange={setAudience}
            options={DRAFT_AUDIENCES.map((id) => ({ id, label: DRAFT_AUDIENCE_LABELS[id] }))} />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {audience === "professional"
              ? "Formal drafting with defined terms, interpretation and boilerplate clauses, and full statutory references."
              : "Clear, plain wording that is still legally precise."}
          </p>
        </fieldset>

        {draft.questions.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-2.5 p-0 text-[13px] font-medium">The details</legend>
            {draft.questions.map((question) => (
              <QuestionField key={question.id} question={question} value={answers[question.id] ?? ""}
                onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))} />
            ))}
          </fieldset>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={instructionsId} className="text-[13px] font-medium">
            Anything else to include or leave out? <span className="font-normal text-muted-foreground">Optional</span>
          </label>
          <textarea id={instructionsId} value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={2} maxLength={1000}
            placeholder={audience === "professional" ? `e.g. Arbitration for disputes; ${draft.jurisdictionName} law governs; no break clause.` : "e.g. No pets, and the tenant pays for water."}
            className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-t pt-4">
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            Takes a few minutes. Each clause shows whether the law requires it and which provision it rests on. Not a substitute for a lawyer.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="min-h-11" disabled={action.pending}
              onClick={() => void action.run(() => cancel({ draftId: draft.id }))}>Not now</Button>
            <Button type="submit" className="min-h-11" disabled={action.pending}>
              {action.pending ? <Spinner className="mr-2 size-4" /> : null}Draft document
            </Button>
          </div>
        </div>
        {action.error && <p role="alert" className="-mt-2 text-sm text-destructive">{action.error}</p>}
      </form>
    </CardShell>
  );
}

type StepState = "done" | "active" | "waiting";

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CircleCheck className="size-[18px] shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />;
  if (state === "active") return <Spinner className="size-[18px] shrink-0" />;
  return <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border-2 border-muted-foreground/40" />;
}

function PreviewList({ items, label }: { items: DocumentDraftSummary["preview"]; label: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label={label} className="border-t bg-muted/40 py-1.5">
      {items.map((item, index) => (
        <li key={`${item.heading}:${index}`} className="flex items-center gap-3 px-5 py-2.5 text-sm sm:px-6">
          <span className="min-w-0 flex-1 truncate">{item.heading || "Untitled part"}</span>
          <ClauseBasisBadge basis={item.basis} />
        </li>
      ))}
    </ul>
  );
}

function ProgressCard({ draft }: { draft: DocumentDraftSummary }) {
  const titleId = useId();
  const cancel = useMutation(api.documentDrafts.cancel);
  const action = useDraftAction();
  const total = Math.max(draft.draftTotal, 0);
  const done = Math.min(draft.draftedCount, total);
  const finishing = total > 0 && done >= total;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const meta = sideSummary(draft);
  const steps: { label: string; state: StepState }[] = [
    { label: `Planned ${total} ${total === 1 ? "part" : "parts"}`, state: "done" },
    { label: `Drafting from the law · ${done} of ${total}`, state: finishing ? "done" : "active" },
    { label: "Checking what's needed before signing", state: finishing ? "active" : "waiting" },
  ];
  return (
    <div className="w-full space-y-3">
      <CardShell labelledBy={titleId}>
        <div className="flex flex-col gap-3.5 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 id={titleId} className="text-base font-semibold tracking-tight [overflow-wrap:anywhere]">Drafting {draft.title ?? "your document"}</h3>
              {meta && <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>}
            </div>
            <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={action.pending}
              onClick={() => void action.run(() => cancel({ draftId: draft.id }))}>
              <Square className="mr-1.5 size-3 fill-current" aria-hidden="true" />Stop
            </Button>
          </div>
          <div role="progressbar" aria-label="Parts drafted" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
            className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${finishing ? 100 : percent}%` }} />
          </div>
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">
            {steps.map((step) => (
              <li key={step.label} className={cn("flex items-center gap-2.5", step.state === "active" ? "font-medium text-foreground" : "text-muted-foreground")}>
                <StepIcon state={step.state} />
                <span className="min-w-0 [overflow-wrap:anywhere]">{step.label}</span>
                {step.state === "active" && <span className="sr-only">(in progress)</span>}
              </li>
            ))}
          </ol>
          {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
        </div>
        <PreviewList items={draft.preview} label="Latest parts drafted" />
      </CardShell>
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        Parts appear as they are drafted. You can leave this page; drafting keeps going.
      </p>
    </div>
  );
}

function CompletedCard({ draft, onOpen }: { draft: DocumentDraftSummary; onOpen: CardProps["onOpen"] }) {
  const titleId = useId();
  const counts = draft.counts;
  const meta = sideSummary(draft);
  return (
    <CardShell labelledBy={titleId}>
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <DraftIcon />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground [overflow-wrap:anywhere]">
              Draft ready · {draft.jurisdictionName}{meta ? ` · ${meta}` : ""}<BetaTag />
            </p>
            <h3 id={titleId} className="mt-1 text-base font-semibold leading-6 tracking-tight [overflow-wrap:anywhere]">{draft.title ?? "Your document"}</h3>
          </div>
        </div>
        {counts && (
          <ul aria-label="Clauses by basis" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {CLAUSE_BASIS_ORDER.filter((basis) => counts[basis] > 0).map((basis) => (
              <li key={basis}><ClauseBasisBadge basis={basis} count={counts[basis]} /></li>
            ))}
          </ul>
        )}
        {draft.placeholderCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {draft.placeholderCount} {draft.placeholderCount === 1 ? "blank" : "blanks"} to fill in before it is used.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3.5 sm:px-6">
        <p className="text-xs text-muted-foreground">A starting point, not legal advice.</p>
        <Button type="button" className="min-h-10" onClick={() => onOpen(draft.id)}>
          Open document<ArrowRight className="ml-2 size-4" aria-hidden="true" />
        </Button>
      </div>
    </CardShell>
  );
}

function StoppedCard({ draft }: { draft: DocumentDraftSummary }) {
  const retry = useMutation(api.documentDrafts.retry);
  const action = useDraftAction();
  const cancelled = draft.status === "cancelled";
  const name = draft.title ?? "Document draft";
  const message = cancelled ? "You stopped this draft." : DOCUMENT_DRAFT_FAILURE_MESSAGES[draft.failure ?? "internal"];
  return (
    <CardShell label={name} className="shadow-none">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{cancelled ? "Draft stopped" : "Draft didn't finish"} · <span className="font-normal text-muted-foreground">{name}</span></p>
          <p role={cancelled ? undefined : "alert"} className="mt-0.5 text-sm text-muted-foreground">{message}</p>
          {action.error && <p role="alert" className="mt-1 text-sm text-destructive">{action.error}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={action.pending}
          onClick={() => void action.run(() => retry({ draftId: draft.id }))}>
          <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />{cancelled ? "Start again" : "Try again"}
        </Button>
      </div>
    </CardShell>
  );
}
