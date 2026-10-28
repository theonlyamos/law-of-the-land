import { FINDING_STATUS_LABELS, type FindingStatus } from "../../../shared/document-review";
import { cn } from "@/lib/utils";

/** Badge colours for each finding status. Text keeps AA contrast in both themes. */
export const FINDING_BADGE_CLASSES: Record<FindingStatus, string> = {
  attention: "bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  check: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  fine: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  unconfirmed: "bg-muted text-muted-foreground",
};

/** Highlight colours for a passage in the document. */
export const FINDING_HIGHLIGHT_CLASSES: Record<FindingStatus, string> = {
  attention: "bg-red-100/80 ring-red-600 dark:bg-red-900/40 dark:ring-red-400",
  check: "bg-amber-100/80 ring-amber-600 dark:bg-amber-900/35 dark:ring-amber-400",
  fine: "bg-emerald-50 ring-emerald-600 dark:bg-emerald-900/30 dark:ring-emerald-400",
  unconfirmed: "bg-muted ring-muted-foreground",
};

/** Solid markers used for passage numbers and dots. */
export const FINDING_MARKER_CLASSES: Record<FindingStatus, string> = {
  attention: "bg-red-600 text-white dark:bg-red-400 dark:text-red-950",
  check: "bg-amber-600 text-white dark:bg-amber-400 dark:text-amber-950",
  fine: "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950",
  unconfirmed: "bg-muted-foreground text-background",
};

export function FindingStatusBadge({ status, className, count }: { status: FindingStatus; className?: string; count?: number }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
      FINDING_BADGE_CLASSES[status], className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {FINDING_STATUS_LABELS[status]}
      {count === undefined ? null : <span className="tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
