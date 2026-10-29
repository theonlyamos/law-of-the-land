"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { ArrowRight, CircleCheck, FileSearch, FileText, RotateCcw, Square } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_REVIEW_FAILURE_MESSAGES,
  FINDING_STATUSES,
  FINDING_STATUS_ORDER,
  NOT_SURE_ROLE,
  type DocumentReviewOption,
} from "../../../shared/document-review";
import { FindingStatusBadge } from "./review-status";

export type DocumentReviewSummary = FunctionReturnType<typeof api.documentReviews.listForChat>[number];

/** "lease" → "a lease", "employment contract" → "an employment contract". */
export function documentTypePhrase(documentType: string | undefined): string {
  const raw = documentType?.trim();
  if (!raw) return "a document";
  // Keep acronyms (NDA, MOU) as written; otherwise read it mid-sentence.
  const type = /^[A-Z]{2,}/u.test(raw) ? raw : raw.charAt(0).toLowerCase() + raw.slice(1);
  if (/^(?:a|an|the|this|your)\s/iu.test(type)) return type;
  const vowelSound = /^(?:[aeio]|u(?![sn]i)|h(?:our|onou?r|eir))/iu.test(type) || /^(?:NDA|MOU|SLA|LOI)\b/u.test(type);
  return `${vowelSound ? "an" : "a"} ${type}`;
}

function shortType(documentType: string | undefined): string {
  const raw = documentType?.trim();
  if (!raw) return "document";
  return /^[A-Z]{2,}/u.test(raw) ? raw : raw.charAt(0).toLowerCase() + raw.slice(1);
}

export function reviewActionErrorMessage(error: unknown): string {
  const data = error instanceof ConvexError ? error.data as unknown : undefined;
  const code = typeof data === "string" ? data : data && typeof data === "object" && "code" in data ? String((data as { code: unknown }).code) : "";
  switch (code) {
    case "QUOTA_EXCEEDED": return "You have reached your question limit for today. A document review counts as one question.";
    case "DOCUMENT_REVIEW_RESEARCH_UNAVAILABLE": return DOCUMENT_REVIEW_FAILURE_MESSAGES.research_unavailable;
    case "DOCUMENT_REVIEW_LIMIT": return "This chat has reached its limit of document reviews. Start a new chat to review another document.";
    case "DOCUMENT_REVIEW_INVALID_CHOICE": return "One of those choices is no longer available. Reload the chat and try again.";
    case "DOCUMENT_REVIEW_NOT_READY":
    case "DOCUMENT_REVIEW_NOT_RETRYABLE": return "This review has already moved on. It will update in a moment.";
    default: return "We couldn't update this review. Check your connection and try again.";
  }
}

function focusSummary(review: DocumentReviewSummary): string {
  const parts: string[] = [];
  if (review.roleLabel && review.roleLabel !== NOT_SURE_ROLE.label) parts.push(review.roleLabel);
  if (review.focusLabels.length) parts.push(`Focus: ${review.focusLabels.join(", ")}`);
  return parts.join(" · ");
}

interface CardProps {
  review: DocumentReviewSummary;
  /** Opens the side-by-side review. */
  onOpen: (reviewId: Id<"documentReviews">) => void;
  /** Asks for a plain summary instead of a review. */
  onSummarise: (review: DocumentReviewSummary) => void;
  /** True while another answer is being prepared. */
  busy?: boolean;
}

export function DocumentReviewCard({ review, onOpen, onSummarise, busy = false }: CardProps) {
  switch (review.status) {
    case "reading": return <ReadingCard review={review} />;
    case "awaiting_input": return <SetupCard review={review} onSummarise={onSummarise} busy={busy} />;
    case "checking": return <ProgressCard review={review} />;
    case "completed": return <CompletedCard review={review} onOpen={onOpen} />;
    case "failed":
    case "cancelled": return <StoppedCard review={review} />;
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

function DocumentIcon({ icon: Icon = FileText }: { icon?: typeof FileText }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

function useReviewAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(reviewActionErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function ReadingCard({ review }: { review: DocumentReviewSummary }) {
  const titleId = useId();
  const cancel = useMutation(api.documentReviews.cancel);
  const action = useReviewAction();
  return (
    <CardShell labelledBy={titleId}>
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <DocumentIcon icon={FileSearch} />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">Reading your document</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              Working out what kind of document <span className="font-medium text-foreground">{review.filename}</span> is and what to check.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={action.pending}
            onClick={() => void action.run(() => cancel({ reviewId: review.id }))}>Stop</Button>
        </div>
        <div role="status" className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {review.startRequested ? "Starting the review as soon as reading finishes…" : "This usually takes under a minute."}
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

function initialRole(review: DocumentReviewSummary): string {
  return review.suggestedRoleId && review.roleOptions.some((option) => option.id === review.suggestedRoleId)
    ? review.suggestedRoleId : NOT_SURE_ROLE.id;
}

function SetupCard({ review, onSummarise, busy }: { review: DocumentReviewSummary; onSummarise: CardProps["onSummarise"]; busy: boolean }) {
  const titleId = useId();
  const roleName = useId();
  const start = useMutation(api.documentReviews.start);
  const cancel = useMutation(api.documentReviews.cancel);
  const action = useReviewAction();
  const [roleId, setRoleId] = useState(() => initialRole(review));
  const [focusIds, setFocusIds] = useState<string[]>(() => review.suggestedFocusIds.filter((id) => review.focusOptions.some((option) => option.id === id)));
  const roles: DocumentReviewOption[] = review.roleOptions.length ? [...review.roleOptions, NOT_SURE_ROLE] : [];
  const legal = review.isLegalDocument !== false;
  const toggleFocus = (id: string) => setFocusIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);

  return (
    <CardShell labelledBy={titleId}>
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <DocumentIcon />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-[17px] font-semibold tracking-tight">
              {legal ? `This looks like ${documentTypePhrase(review.documentType)}` : "This may not be a legal document"}
            </h3>
            {review.summary && <p className="mt-1 text-sm leading-6 text-muted-foreground">{review.summary}</p>}
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {legal
                ? `We can check each part against the laws for ${review.jurisdictionName} in the library and point out anything that needs attention.${roles.length || review.focusOptions.length ? " A couple of quick choices help us focus." : ""}`
                : `We can still check it against the laws for ${review.jurisdictionName}, but there may be little to review.`}
            </p>
          </div>
        </div>

        {roles.length > 0 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2.5 p-0 text-[13px] font-medium">Which side are you on?</legend>
            <div className="flex flex-wrap gap-2">
              {roles.map((role) => (
                <label key={role.id} className={cn(
                  "relative inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-4 text-sm font-medium transition-colors",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1",
                  roleId === role.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
                )}>
                  <input type="radio" name={roleName} value={role.id} checked={roleId === role.id}
                    onChange={() => setRoleId(role.id)} className="sr-only" />
                  {role.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {review.focusOptions.length > 0 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2.5 p-0 text-[13px] font-medium">
              Anything you&apos;re worried about? <span className="font-normal text-muted-foreground">Optional</span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {review.focusOptions.map((option) => {
                const checked = focusIds.includes(option.id);
                return (
                  <label key={option.id} className={cn(
                    "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] transition-colors",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    checked ? "border-primary/60 bg-secondary" : "border-border bg-background hover:bg-muted",
                  )}>
                    <input type="checkbox" checked={checked} onChange={() => toggleFocus(option.id)}
                      className="size-3.5 accent-[hsl(var(--primary))]" />
                    {option.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-t pt-4">
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            Takes a minute or two. We only use laws in the library and say when something isn&apos;t covered. This is not a substitute for a lawyer.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="min-h-11" disabled={action.pending || busy}
              onClick={() => void action.run(async () => {
                await cancel({ reviewId: review.id });
                onSummarise(review);
              })}>
              Just summarise it
            </Button>
            <Button type="button" className="min-h-11" disabled={action.pending}
              onClick={() => void action.run(() => start({ reviewId: review.id, roleId: roles.length ? roleId : undefined, focusIds }))}>
              {action.pending ? <Spinner className="mr-2 size-4" /> : null}Review document
            </Button>
          </div>
        </div>
        {action.error && <p role="alert" className="-mt-2 text-sm text-destructive">{action.error}</p>}
      </div>
    </CardShell>
  );
}

type StepState = "done" | "active" | "waiting";

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CircleCheck className="size-[18px] shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />;
  if (state === "active") return <Spinner className="size-[18px] shrink-0" />;
  return <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border-2 border-muted-foreground/40" />;
}

function PreviewList({ items, label }: { items: DocumentReviewSummary["preview"]; label: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label={label} className="border-t bg-muted/40 py-1.5">
      {items.map((item, index) => (
        <li key={`${item.ref ?? ""}:${item.title}:${index}`} className="flex items-center gap-3 px-5 py-2.5 text-sm sm:px-6">
          <span className="w-11 shrink-0 truncate font-mono text-xs text-muted-foreground">{item.ref ?? "—"}</span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <FindingStatusBadge status={item.status} />
        </li>
      ))}
    </ul>
  );
}

function ProgressCard({ review }: { review: DocumentReviewSummary }) {
  const titleId = useId();
  const cancel = useMutation(api.documentReviews.cancel);
  const action = useReviewAction();
  const total = Math.max(review.checkTotal, 0);
  const checked = Math.min(review.checkedCount, total);
  const writing = total > 0 && checked >= total;
  const percent = total ? Math.round((checked / total) * 100) : 0;
  const meta = focusSummary(review);
  const steps: { label: string; state: StepState }[] = [
    { label: `Read ${review.filename}`, state: "done" },
    { label: review.segmentCount ? `Found ${review.segmentCount} ${review.segmentCount === 1 ? "part" : "parts"}, ${total} to check` : `${total} parts to check`, state: "done" },
    { label: `Checking against the law · ${checked} of ${total}`, state: writing ? "done" : "active" },
    { label: "Writing your summary", state: writing ? "active" : "waiting" },
  ];
  return (
    <div className="w-full space-y-3">
      <CardShell labelledBy={titleId}>
        <div className="flex flex-col gap-3.5 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 id={titleId} className="text-base font-semibold tracking-tight">Reviewing your {shortType(review.documentType)}</h3>
              {meta && <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>}
            </div>
            <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={action.pending}
              onClick={() => void action.run(() => cancel({ reviewId: review.id }))}>
              <Square className="mr-1.5 size-3 fill-current" aria-hidden="true" />Stop
            </Button>
          </div>
          <div role="progressbar" aria-label="Parts checked" aria-valuemin={0} aria-valuemax={total} aria-valuenow={checked}
            className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${writing ? 100 : percent}%` }} />
          </div>
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">
            {steps.map((step) => (
              <li key={step.label} className={cn("flex items-center gap-2.5",
                step.state === "active" ? "font-medium text-foreground" : "text-muted-foreground")}>
                <StepIcon state={step.state} />
                <span className="min-w-0 [overflow-wrap:anywhere]">{step.label}</span>
                {step.state === "active" && <span className="sr-only">(in progress)</span>}
              </li>
            ))}
          </ol>
          {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
        </div>
        <PreviewList items={review.preview} label="Latest findings" />
      </CardShell>
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        Findings appear as each part is checked. You can leave this page; the review keeps going.
      </p>
    </div>
  );
}

function CompletedCard({ review, onOpen }: { review: DocumentReviewSummary; onOpen: CardProps["onOpen"] }) {
  const titleId = useId();
  const counts = review.counts;
  const statuses = counts ? [...FINDING_STATUSES].sort((a, b) => FINDING_STATUS_ORDER[a] - FINDING_STATUS_ORDER[b]).filter((status) => counts[status] > 0) : [];
  const meta = focusSummary(review);
  return (
    <CardShell labelledBy={titleId}>
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <DocumentIcon icon={FileSearch} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground [overflow-wrap:anywhere]">
              Review of {review.filename}{meta ? ` · ${meta}` : ""}
            </p>
            <h3 id={titleId} className="mt-1 text-base font-semibold leading-6 tracking-tight">
              {review.headline ?? review.title ?? "Review complete"}
            </h3>
          </div>
        </div>
        {statuses.length > 0 ? (
          <ul aria-label="Findings by status" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {statuses.map((status) => <li key={status}><FindingStatusBadge status={status} count={counts![status]} /></li>)}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No findings were recorded for this document.</p>
        )}
      </div>
      <PreviewList items={review.preview} label="Most important findings" />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3.5 sm:px-6">
        <p className="text-xs text-muted-foreground">General legal information, not legal advice.</p>
        <Button type="button" className="min-h-10" onClick={() => onOpen(review.id)}>
          Open full review<ArrowRight className="ml-2 size-4" aria-hidden="true" />
        </Button>
      </div>
    </CardShell>
  );
}

function StoppedCard({ review }: { review: DocumentReviewSummary }) {
  const retry = useMutation(api.documentReviews.retry);
  const action = useReviewAction();
  const cancelled = review.status === "cancelled";
  const message = cancelled ? "You stopped this review." : DOCUMENT_REVIEW_FAILURE_MESSAGES[review.failure ?? "internal"];
  return (
    <CardShell label={`Review of ${review.filename}`} className="shadow-none">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{cancelled ? "Review stopped" : "Review didn't finish"} · <span className="font-normal text-muted-foreground">{review.filename}</span></p>
          <p role={cancelled ? undefined : "alert"} className="mt-0.5 text-sm text-muted-foreground">{message}</p>
          {action.error && <p role="alert" className="mt-1 text-sm text-destructive">{action.error}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={action.pending}
          onClick={() => void action.run(() => retry({ reviewId: review.id }))}>
          <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />{cancelled ? "Review again" : "Try again"}
        </Button>
      </div>
    </CardShell>
  );
}
