import { LogoMark } from "@/components/brand/logo-mark";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function Bar({ className }: { className?: string }) {
  return <span className={cn("skeleton-bar block h-2.5", className)} />;
}

function AnswerBars() {
  return (
    <div aria-hidden="true" className="mt-5 grid gap-6">
      <div className="grid gap-2.5">
        <Bar className="h-3 w-40" />
        <Bar className="w-full" />
        <Bar className="w-11/12" />
        <Bar className="w-3/5" />
      </div>
      <div className="grid gap-2.5">
        <Bar className="h-3 w-32" />
        <Bar className="w-full" />
        <Bar className="w-4/5" />
      </div>
      <div className="grid gap-3 border-t pt-4">
        <Bar className="h-2 w-20" />
        {["w-2/3", "w-1/2"].map((width) => (
          <div key={width} className="flex items-center gap-3">
            <span className="skeleton-bar size-5 shrink-0" />
            <Bar className={width} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Placeholder for a saved conversation while it opens: a question and its answer. */
export function ConversationSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col py-6 sm:py-8", className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex justify-end">
        <span className="skeleton-bar block h-11 w-3/5 rounded-2xl rounded-br-md sm:w-2/5" />
      </div>
      <div className="mt-7">
        <div aria-hidden="true" className="flex items-center gap-2">
          <span className="skeleton-bar block size-5" />
          <Bar className="w-24" />
        </div>
        <AnswerBars />
      </div>
    </div>
  );
}

/**
 * Placeholder in the shape of an answer while it is researched: a heading,
 * two short sections and the sources list. The label says what is happening.
 */
export function AnswerSkeleton({ label }: { label: string }) {
  return (
    <div className="min-w-0 w-full text-sm leading-7">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
        <LogoMark className="h-5 w-5" />
        Law of the Land
      </div>
      <div role="status" aria-label="Preparing answer" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        {label}
      </div>
      <AnswerBars />
    </div>
  );
}
