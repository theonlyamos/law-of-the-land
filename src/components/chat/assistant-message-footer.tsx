"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatCitation } from "@/lib/countries";

export function AssistantMessageFooter({ content, citations = [], completedAt, savedAt, durationMs }: {
  content: string;
  citations?: ChatCitation[];
  completedAt?: number;
  savedAt: number;
  durationMs?: number;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(resetTimer.current); };
  }, []);

  async function copy() {
    clearTimeout(resetTimer.current);
    setCopyState("copying");
    const sources = citations.length
      ? `\n\nSources\n${citations.map((citation, index) => `${index + 1}. ${citation.label} — ${citation.jurisdictionName}`).join("\n")}`
      : "";
    try {
      await navigator.clipboard.writeText(content + sources);
      if (!mounted.current) return;
      setCopyState("copied");
      resetTimer.current = setTimeout(() => setCopyState("idle"), 2200);
    } catch {
      if (mounted.current) setCopyState("failed");
    }
  }

  const date = new Date(completedAt ?? savedAt);
  const seconds = durationMs === undefined ? undefined : Math.max(0, durationMs / 1000);
  const roundedSeconds = Math.round(seconds ?? 0);
  const duration = seconds === undefined ? "—" : seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;

  return (
    <footer aria-label="Reply actions and timing" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground">
      <Button type="button" variant="ghost" size="sm" className="h-9 gap-1.5 px-2 text-muted-foreground"
        onClick={() => void copy()} disabled={copyState === "copying"}
        aria-label={copyState === "copied" ? "Copied" : "Copy reply"} title="Copy reply">
        {copyState === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        <span aria-live="polite">{copyState === "copied" ? "Copied" : ""}</span>
      </Button>
      <time dateTime={date.toISOString()} title={`${completedAt === undefined ? "Saved" : "Finished"} ${date.toLocaleString()}`} className="tabular-nums">
        {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
      <span aria-hidden="true" className="h-3 w-px bg-border" />
      <span className="inline-flex items-center gap-1.5 tabular-nums" aria-label={seconds === undefined ? "Duration unavailable" : `Response duration: ${duration}`} title={seconds === undefined ? "Duration was not recorded for this reply" : "Response duration"}>
        <Timer className="size-3.5" aria-hidden="true" />{duration}
      </span>
      {copyState === "failed" && <span role="status" className="text-destructive">Could not copy. Try again.</span>}
    </footer>
  );
}
