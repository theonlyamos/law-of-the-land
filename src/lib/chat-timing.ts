// Content-free timing for one ordinary chat request. It is written to server
// logs only, so long generations can be traced to research, writing, or a
// dropped stream before anyone changes the time limits.

export type ResumeUnavailableCause =
  | "single_attempt" | "already_resumed" | "missing_interaction" | "missing_event_cursor" | "resume_not_stream";

export type ChatTimingSnapshot = {
  searchCalls: number;
  firstSearchMs?: number;
  lastSearchMs?: number;
  firstOutputMs?: number;
  streamCompleteMs?: number;
  /** Longest gap between consecutive search calls. */
  longestSearchGapMs?: number;
  resumeUnavailable?: ResumeUnavailableCause;
};

export function createChatTimingTrace(startedAt: number, now: () => number = Date.now) {
  const state: ChatTimingSnapshot = { searchCalls: 0 };
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  return {
    searches(count: number) {
      if (!Number.isSafeInteger(count) || count <= state.searchCalls) return;
      const at = elapsed();
      if (state.lastSearchMs !== undefined) {
        state.longestSearchGapMs = Math.max(state.longestSearchGapMs ?? 0, at - state.lastSearchMs);
      }
      state.firstSearchMs ??= at;
      state.lastSearchMs = at;
      state.searchCalls = count;
    },
    output() { state.firstOutputMs ??= elapsed(); },
    streamComplete() { state.streamCompleteMs ??= elapsed(); },
    resumeUnavailable(cause: ResumeUnavailableCause) { state.resumeUnavailable ??= cause; },
    snapshot(): ChatTimingSnapshot { return { ...state }; },
  };
}
