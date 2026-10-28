"use client";

import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

/** A quiet per-chat switch: turning memory off also forgets what this chat taught. */
export function ChatMemoryToggle({ chatId }: { chatId: string }) {
  const state = useQuery(api.profileMemory.chatMemory, { externalId: chatId });
  const setChatMemory = useMutation(api.profileMemory.setChatMemory);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!state?.available) return null;
  if (!state.enabled) {
    return (
      <Link href="/settings/memory" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        Memory paused
      </Link>
    );
  }

  const off = state.disabledForChat;
  async function toggle() {
    setBusy(true);
    setFailed(false);
    try { await setChatMemory({ externalId: chatId, disabled: !off }); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }

  return (
    <button type="button" disabled={busy} onClick={() => void toggle()} aria-pressed={!off}
      title={off ? "Turn memory back on for this chat" : "Don't remember anything from this chat"}
      className="rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
      {failed ? "Could not change memory. Try again." : off ? "Memory off for this chat" : "Memory on"}
    </button>
  );
}
