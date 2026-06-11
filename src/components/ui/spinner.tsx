import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden
      className={cn("h-8 w-8 animate-spin text-muted-foreground", className)}
    />
  );
}

export function PageLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-background">
      <Spinner />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
