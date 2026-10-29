"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ArrowRight, Check } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MAX_BLANK_VALUE_CHARACTERS, blankLabel, cleanBlankValue, splitBlanks } from "../../../shared/document-draft";
import { clauseParagraphs } from "@/lib/document-export/model";
import { useDraftAction } from "./document-draft-card";
import type { DraftData } from "./draft-export";

type Clause = DraftData["clauses"][number];
type BlankPart = Extract<Clause["parts"][number], { kind: "blank" }>;

/** The blank being typed into, shown in the document before it is saved. */
export type ActiveBlank = { key: string; clauseId: Id<"documentDraftClauses">; value: string; everywhere: boolean };

/** A currency written just before a blank, shown beside its field. */
const CURRENCY_BEFORE = /(GH₵|₵|GHS|USD|US\$|\$|€|EUR|£|GBP|₦|NGN|KES|ZAR|R)\s?$/u;

export function blankParts(clause: Pick<Clause, "parts">): BlankPart[] {
  return clause.parts.filter((part): part is BlankPart => part.kind === "blank");
}

/** Each blank in a clause once, in reading order. */
export function uniqueBlanks(clause: Pick<Clause, "parts">): BlankPart[] {
  const seen = new Set<string>();
  return blankParts(clause).filter((part) => !seen.has(part.key) && seen.add(part.key));
}

export function hasOpenBlank(clause: Pick<Clause, "parts">): boolean {
  return blankParts(clause).some((part) => !part.value);
}

/** What a blank shows in a clause right now, including what is being typed. */
function shownValue(part: BlankPart, clauseId: string, active: ActiveBlank | null): string | undefined {
  if (active && active.key === part.key && (active.everywhere || active.clauseId === clauseId)) return cleanBlankValue(active.value) || undefined;
  return part.value;
}

/** A clause's wording with blanks highlighted and filled values marked. */
export function ClauseParts({ clause, active }: { clause: Pick<Clause, "id" | "parts">; active: ActiveBlank | null }) {
  const byKey = new Map(blankParts(clause).map((part) => [part.key, part]));
  const raw = clause.parts.map((part) => part.kind === "text" ? part.text : part.placeholder).join("");
  return (
    <span className="block">
      {clauseParagraphs(raw).map((paragraph, index) => (
        <span key={index} className={cn("mb-1.5 block whitespace-pre-wrap [overflow-wrap:anywhere] last:mb-0", paragraph.indent && "pl-6")}>
          {splitBlanks(paragraph.text).map((piece, pieceIndex) => {
            if (piece.kind === "text") return <span key={pieceIndex}>{piece.text}</span>;
            const part = byKey.get(piece.key) ?? { ...piece, own: false };
            const value = shownValue(part, clause.id, active);
            const editing = active?.key === piece.key && (active.everywhere || active.clauseId === clause.id);
            return value ? (
              <span key={pieceIndex} data-blank={piece.key}
                className={cn("rounded-sm bg-primary/10 px-0.5 font-medium", editing && "ring-2 ring-brand")}>{value}</span>
            ) : (
              <mark key={pieceIndex} data-blank={piece.key}
                className={cn("rounded-sm bg-amber-100 px-0.5 text-amber-950 dark:bg-amber-900/50 dark:text-amber-100", editing && "ring-2 ring-brand")}>
                {piece.placeholder}
              </mark>
            );
          })}
        </span>
      ))}
    </span>
  );
}

type NumberedClause = { clause: Clause; line: string };

/** Fields for each blank in the selected clause. A blank used in other clauses is filled there too, unless the person turns that off. */
export function BlankFields({ clause, numbered, onPreview, onSelect }: {
  clause: Clause;
  numbered: NumberedClause[];
  onPreview: (active: ActiveBlank | null) => void;
  /** Opens another clause, focusing one of its blanks when given. */
  onSelect: (clause: Clause, blankKey?: string) => void;
}) {
  const setBlank = useMutation(api.documentDrafts.setBlank);
  const action = useDraftAction();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const blanks = uniqueBlanks(clause);
  if (!blanks.length) return null;

  const filled = blanks.filter((blank) => blank.value).length;
  const index = numbered.findIndex((entry) => entry.clause.id === clause.id);
  const others = [...numbered.slice(index + 1), ...numbered.slice(0, Math.max(index, 0))];
  const next = others.find((entry) => hasOpenBlank(entry.clause));
  const openElsewhere = others.reduce((total, entry) => total + blankParts(entry.clause).filter((part) => !part.value).length, 0);

  const save = (key: string, value: string, everywhere: boolean) =>
    void action.run(() => setBlank({ clauseId: clause.id, key, value, everywhere }));
  const focusNext = (from: HTMLInputElement) => {
    const inputs = [...(sectionRef.current?.querySelectorAll<HTMLInputElement>("input[data-blank-input]") ?? [])];
    const after = inputs[inputs.indexOf(from) + 1];
    if (after) after.focus(); else from.blur();
  };

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="flex flex-col rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3.5">
        <h4 id={headingId} className="text-sm font-semibold">Fill in the blanks</h4>
        <span className="text-xs tabular-nums text-muted-foreground">{filled} of {blanks.length} filled</span>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4 pt-2.5">
        {blanks.map((blank) => (
          <BlankField key={`${clause.id}:${blank.key}`} clause={clause} blank={blank}
            uses={numbered.filter((entry) => blankParts(entry.clause).some((part) => part.key === blank.key))}
            onPreview={onPreview} onSave={save} onSelect={onSelect} onEnter={focusNext} />
        ))}
        {action.error && <p role="alert" className="text-sm text-destructive">{action.error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-4 py-3">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {action.pending ? "Saving…" : openElsewhere ? `${openElsewhere} ${openElsewhere === 1 ? "blank" : "blanks"} left in other clauses` : "Saved as you go"}
        </span>
        {next && (
          <Button type="button" variant="outline" size="sm" className="min-h-9"
            onClick={() => onSelect(next.clause, blankParts(next.clause).find((part) => !part.value)?.key)}>
            Next clause with blanks<ArrowRight className="ml-1.5 size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </section>
  );
}

function BlankField({ clause, blank, uses, onPreview, onSave, onSelect, onEnter }: {
  clause: Clause;
  blank: BlankPart;
  uses: NumberedClause[];
  onPreview: (active: ActiveBlank | null) => void;
  onSave: (key: string, value: string, everywhere: boolean) => void;
  onSelect: (clause: Clause, blankKey?: string) => void;
  onEnter: (input: HTMLInputElement) => void;
}) {
  const inputId = useId();
  const usesId = useId();
  const [value, setValue] = useState(blank.value ?? "");
  const [everywhere, setEverywhere] = useState(!blank.own);
  const focused = useRef(false);
  const saved = blank.value ?? "";
  const shared = uses.length > 1;
  const elsewhere = uses.filter((entry) => entry.clause.id !== clause.id);

  // Take the saved value when it changes elsewhere, unless the person is typing here.
  useEffect(() => {
    if (!focused.current) setValue(blank.value ?? "");
  }, [blank.value]);
  useEffect(() => {
    if (!focused.current) setEverywhere(!blank.own);
  }, [blank.own]);

  const firstIndex = clause.parts.findIndex((part) => part.kind === "blank" && part.key === blank.key);
  const before = clause.parts[firstIndex - 1];
  const currency = before?.kind === "text" ? CURRENCY_BEFORE.exec(before.text)?.[1] : undefined;
  const preview = (next: string, nextEverywhere = everywhere) => onPreview({ key: blank.key, clauseId: clause.id, value: next, everywhere: nextEverywhere });
  const commit = (nextEverywhere = everywhere) => {
    const clean = cleanBlankValue(value);
    if (clean !== value) setValue(clean);
    if (clean !== saved || nextEverywhere !== !blank.own) onSave(blank.key, clean, shared ? nextEverywhere : true);
  };

  const input = (
    <input id={inputId} data-blank-input={blank.key} value={value} maxLength={MAX_BLANK_VALUE_CHARACTERS}
      aria-describedby={shared ? usesId : undefined} autoComplete="off"
      onFocus={() => { focused.current = true; preview(value); }}
      onChange={(event) => { setValue(event.target.value); preview(event.target.value); }}
      onBlur={() => { focused.current = false; onPreview(null); commit(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); onEnter(event.currentTarget); }
        if (event.key === "Escape" && value !== saved) { event.preventDefault(); event.stopPropagation(); setValue(saved); preview(saved); }
      }}
      className={cn("h-10 min-w-0 flex-1 bg-transparent px-2.5 text-sm focus-visible:outline-none",
        !currency && "rounded-md border bg-background focus-visible:ring-2 focus-visible:ring-ring")} />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="flex items-center gap-1.5 text-[13px] font-medium [overflow-wrap:anywhere]">
        {blankLabel(blank.placeholder)}
        {blank.value && <Check className="size-3.5 shrink-0 text-primary" aria-label="Filled" />}
      </label>
      {currency ? (
        <div className="flex h-10 items-stretch overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
          <span aria-hidden="true" className="flex items-center border-r bg-muted px-2.5 text-[13px] text-muted-foreground">{currency}</span>
          {input}
        </div>
      ) : input}
      {shared && (
        <div id={usesId} className="flex flex-col gap-1.5">
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" checked={everywhere} className="size-4 accent-[hsl(var(--primary))]"
              onChange={(event) => { setEverywhere(event.target.checked); commit(event.target.checked); }} />
            Use in all {uses.length} clauses it appears in
          </label>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Also in
            {elsewhere.map((entry) => (
              <button key={entry.clause.id} type="button" onClick={() => onSelect(entry.clause, blank.key)}
                className="inline-flex min-h-7 max-w-full items-center rounded-full bg-muted px-2.5 text-xs text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="truncate">{entry.line || entry.clause.heading || "Untitled part"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
