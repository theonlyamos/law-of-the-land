"use client";

import { FilePen } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A pressed button in the composer footer. It turns on by itself when the
 * message asks for a document to be drafted, and the person can switch it either way.
 */
export function DraftModeToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}
      title={checked ? "Drafting a document. Select to ask a question instead." : "Draft a legal document from the law library"}
      className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground")}>
      <FilePen className="size-3.5" aria-hidden="true" />
      Draft a document
    </button>
  );
}

/** A note above the composer while draft mode is on. */
export function DraftModeNote({ fileCount }: { fileCount: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/70 px-1 py-2.5">
      <FilePen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Drafting a document <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Beta</span></p>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {fileCount > 0
            ? `Describe what you need. ${fileCount > 1 ? "The first file" : "Your file"} will be used as background, and a few questions follow before drafting.`
            : "Describe the document you need. A few questions follow, then each clause is drafted from the law library."}
        </p>
      </div>
    </div>
  );
}
