"use client";

import { useId } from "react";
import { FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "../../../shared/chat-attachments";

const KIND_PRIORITY: Record<ChatAttachment["kind"], number> = { document: 0, text: 1, image: 2 };

/** The file a review reads: the first document, else the first text file, else the first image. */
export function pickReviewAttachment(attachments: readonly ChatAttachment[]): ChatAttachment | null {
  let best: ChatAttachment | null = null;
  for (const attachment of attachments) {
    if (!best || KIND_PRIORITY[attachment.kind] < KIND_PRIORITY[best.kind]) best = attachment;
  }
  return best;
}

/**
 * Shown under attached files. It turns on by itself when the question asks for
 * a review, and the person can switch it either way.
 */
export function ReviewModeToggle({ checked, onChange, disabled, fileCount }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  fileCount: number;
}) {
  const hintId = useId();
  return (
    <div className="flex items-center gap-3 border-b border-border/70 px-1 py-2.5">
      <FileSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Review against the law</p>
        <p id={hintId} className="text-[11px] leading-4 text-muted-foreground">
          {checked
            ? `Checks each part of ${fileCount > 1 ? "the first document" : "the document"} and flags anything that needs attention.`
            : "Off: you'll get an answer or summary instead."}
        </p>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label="Review against the law" aria-describedby={hintId}
        disabled={disabled} onClick={() => onChange(!checked)}
        className={cn("relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border-2 border-transparent transition-colors before:absolute before:-inset-2.5 before:content-['']",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50",
          checked ? "bg-primary" : "bg-input")}>
        <span aria-hidden="true" className={cn("block size-5 rounded-full bg-background shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
      </button>
    </div>
  );
}
