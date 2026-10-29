import { CLAUSE_BASIS_LABELS, type ClauseBasis } from "../../../shared/document-draft";
import { cn } from "@/lib/utils";

/** Badge colours for why a clause is in the document. Text keeps AA contrast in both themes. */
export const CLAUSE_BASIS_BADGE_CLASSES: Record<ClauseBasis, string> = {
  required: "bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200",
  protects: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  common: "bg-muted text-muted-foreground",
  choice: "bg-violet-50 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
};

export const CLAUSE_BASIS_MARKER_CLASSES: Record<ClauseBasis, string> = {
  required: "bg-blue-600 dark:bg-blue-400",
  protects: "bg-emerald-600 dark:bg-emerald-400",
  common: "bg-muted-foreground/60",
  choice: "bg-violet-600 dark:bg-violet-400",
};

export const CLAUSE_BASIS_ORDER: readonly ClauseBasis[] = ["required", "protects", "choice", "common"];

export function ClauseBasisBadge({ basis, className, count }: { basis: ClauseBasis; className?: string; count?: number }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
      CLAUSE_BASIS_BADGE_CLASSES[basis], className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {CLAUSE_BASIS_LABELS[basis]}
      {count === undefined ? null : <span className="tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
