// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createReviewedSplitVerifier } from "./reviewed-split-verifier";
import { caseInput } from "./test-fixtures/reviewed-request-catalog";
import { authoredStage } from "./test-fixtures/reviewed-answer-fixtures";
import type { SplitRunInput, StageExecutor } from "./split-verification/runner";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  let wall = 100_000, mono = 1_000;
  const input = { ...caseInput("nine-month-control"), requestStartedAt: wall, requestStartedMonotonic: mono };
  const stages: string[] = [], origins: SplitRunInput[] = [];
  const execute: StageExecutor = async request => { stages.push(request.stage); return { binding: request.binding, status: "completed",
    json: JSON.stringify(authoredStage(request)), usage: { input: 10, output: 20, thought: 30 } }; };
  const factory = vi.fn((value: SplitRunInput) => { origins.push(value); return execute; });
  const verifier = createReviewedSplitVerifier({ createExecutor: factory, clock: { wall: () => wall, monotonic: () => mono } });
  return { input, stages, origins, factory, verifier, setClock(w: number, m: number) { wall = w; mono = m; } };
}
it("lazily admits one request and returns the real three-stage result without single-call relabeling", async () => {
  const f = fixture(); expect(f.factory).not.toHaveBeenCalled();
  const result = await f.verifier.verify(f.input);
  expect(result).toMatchObject({ purpose: "offline_split_verification_v1", runtimeEnabled: false, productionEligible: false,
    decision: "pass", reason: "verified", dispatchCount: 3, usage: { coverage: "complete", knownStages: 3 } });
  expect(result).not.toHaveProperty("attemptCount"); expect(f.stages).toEqual(["inventory", "consent", "overtime"]);
  expect(f.factory).toHaveBeenCalledTimes(1); expect(f.origins[0]).toMatchObject({ requestStartedAt: 100_000, requestStartedMonotonic: 1_000 });
});
it("consumes its request once across duplicate or concurrent verification attempts", async () => {
  const f = fixture(); const results = await Promise.all([f.verifier.verify(f.input), f.verifier.verify(f.input)]);
  expect(results.filter(result => result.decision === "pass")).toHaveLength(1);
  expect(results.filter(result => result.reason === "reservation_failed")).toHaveLength(1);
  expect(f.factory).toHaveBeenCalledTimes(1); expect(f.stages).toHaveLength(3);
});
it("rejects invalid or already exhausted origins before constructing an executor", async () => {
  for (const kind of ["future", "expired", "aborted"] as const) {
    const f = fixture(), controller = new AbortController();
    if (kind === "future") f.input.requestStartedMonotonic = 2_000;
    if (kind === "expired") f.setClock(185_000, 86_000);
    if (kind === "aborted") controller.abort();
    expect((await f.verifier.verify({ ...f.input, signal: controller.signal })).decision).toBe("withhold");
    expect(f.factory).not.toHaveBeenCalled();
  }
});
it("does not let a malformed first input reopen the same request adapter", async () => {
  const f = fixture(); expect((await f.verifier.verify({ ...f.input, candidate: "" })).decision).toBe("withhold");
  expect((await f.verifier.verify(f.input)).decision).toBe("withhold"); expect(f.factory).not.toHaveBeenCalled();
});
it("passes a detached input snapshot to the lazy executor factory", async () => {
  const f = fixture(), original = f.input.candidate, pending = f.verifier.verify(f.input);
  f.input.candidate = "PRIVATE changed candidate";
  expect((await pending).decision).toBe("pass"); expect(f.origins[0].candidate).toBe(original);
  expect(Object.isFrozen(f.origins[0])).toBe(true);
});
it("checks an earlier caller cutoff against monotonic time even if wall time rolls backward", async () => {
  const f = fixture(); f.setClock(99_000, 2_000);
  expect((await f.verifier.verify({ ...f.input, deadlineAt: 101_000 })).decision).toBe("withhold");
  expect(f.factory).not.toHaveBeenCalled();
});
it("aborts an uncooperative stage at the earlier caller cutoff", async () => {
  vi.useFakeTimers(); let mono = 0; const controller = new AbortController(); let signal: AbortSignal | undefined;
  const verifier = createReviewedSplitVerifier({ clock: { wall: () => 100_000 + mono, monotonic: () => mono },
    createExecutor: () => async (_request, current) => { signal = current; return new Promise(() => {}); } });
  const pending = verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: 100_000,
    requestStartedMonotonic: 0, deadlineAt: 100_020, signal: controller.signal });
  await vi.advanceTimersByTimeAsync(0); mono = 20; await vi.advanceTimersByTimeAsync(20);
  expect((await pending).decision).toBe("withhold"); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it("carries an earlier cutoff to the executor's immediate dispatch guard after synchronous preparation", async () => {
  let mono = 0, dispatches = 0;
  const deadlines: number[] = [];
  const verifier = createReviewedSplitVerifier({ clock: { wall: () => 100_000 + mono, monotonic: () => mono },
    createExecutor: () => async request => {
      deadlines.push(request.deadlineAt);
      // Preparation can consume the remaining time before the timeout callback runs.
      mono = 20;
      if (100_000 + mono >= request.deadlineAt || mono >= request.deadlineAt - 100_000) throw new Error("deadline_exceeded");
      dispatches++;
      return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
        usage: { input: 10, output: 20, thought: 30 } };
    } });
  expect((await verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: 100_000,
    requestStartedMonotonic: 0, deadlineAt: 100_020 })).decision).toBe("withhold");
  expect(deadlines).toEqual([100_020]); expect(dispatches).toBe(0);
});
it("withholds when the final executor settles after the earlier cutoff before its timer callback", async () => {
  let mono = 0;
  const verifier = createReviewedSplitVerifier({ clock: { wall: () => 100_000 + mono, monotonic: () => mono },
    createExecutor: () => async request => {
      if (request.stage === "overtime") mono = 20;
      return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
        usage: { input: 10, output: 20, thought: 30 } };
    } });
  expect((await verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: 100_000,
    requestStartedMonotonic: 0, deadlineAt: 100_020 })).decision).toBe("withhold");
});
