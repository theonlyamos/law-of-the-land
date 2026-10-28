import { describe, expect, it } from "vitest";
import { createChatTimingTrace } from "./chat-timing";

describe("chat timing trace", () => {
  it("records research, writing and completion times relative to the request", () => {
    let clock = 1_000;
    const trace = createChatTimingTrace(1_000, () => clock);
    clock = 3_000; trace.searches(1);
    clock = 3_500; trace.searches(1);
    clock = 9_000; trace.searches(3);
    clock = 12_000; trace.output();
    clock = 13_000; trace.output();
    clock = 20_000; trace.streamComplete();
    expect(trace.snapshot()).toEqual({
      searchCalls: 3, firstSearchMs: 2_000, lastSearchMs: 8_000, longestSearchGapMs: 6_000,
      firstOutputMs: 11_000, streamCompleteMs: 19_000,
    });
  });

  it("keeps the first resume cause and returns copies", () => {
    const trace = createChatTimingTrace(0, () => 0);
    trace.resumeUnavailable("missing_event_cursor");
    trace.resumeUnavailable("already_resumed");
    const snapshot = trace.snapshot();
    snapshot.searchCalls = 99;
    expect(trace.snapshot()).toEqual({ searchCalls: 0, resumeUnavailable: "missing_event_cursor" });
  });
});
