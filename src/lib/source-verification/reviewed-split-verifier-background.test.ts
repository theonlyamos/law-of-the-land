// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createReviewedSplitVerifier } from "./reviewed-split-verifier";
import { caseInput } from "./test-fixtures/reviewed-request-catalog";
import { authoredStage } from "./test-fixtures/reviewed-answer-fixtures";
import type { Stage, StageRequest } from "./split-verification/contracts";
import type { SplitRunInput, StageExecutor } from "./split-verification/runner";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ORIGIN_WALL = 100_000, ORIGIN_MONOTONIC = 1_000;
type TimingPolicy = "standard" | "background";
function fixture(options: { policy?: TimingPolicy; elapsed?: number; finishAt?: Partial<Record<Stage, number>>;
  onStagePassed?: (request: StageRequest) => Promise<void> } = {}) {
  let wall = ORIGIN_WALL + (options.elapsed ?? 0), mono = ORIGIN_MONOTONIC + (options.elapsed ?? 0);
  const input = { ...caseInput("nine-month-control"), requestStartedAt: ORIGIN_WALL, requestStartedMonotonic: ORIGIN_MONOTONIC };
  const stages: Stage[] = [], deadlines: number[] = [], origins: SplitRunInput[] = [];
  const execute: StageExecutor = async request => {
    stages.push(request.stage); deadlines.push(request.deadlineAt);
    const finishAt = options.finishAt?.[request.stage];
    if (finishAt !== undefined) { wall = ORIGIN_WALL + finishAt; mono = ORIGIN_MONOTONIC + finishAt; }
    return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
      usage: { input: 10, output: 20, thought: 30 } };
  };
  const factory = vi.fn((value: SplitRunInput) => { origins.push(value); return execute; });
  const dependencies = { createExecutor: factory, clock: { wall: () => wall, monotonic: () => mono },
    ...(options.policy === undefined ? {} : { timingPolicy: options.policy }),
    ...(options.onStagePassed === undefined ? {} : { onStagePassed: options.onStagePassed }) };
  const verifier = createReviewedSplitVerifier(dependencies);
  return { input, stages, deadlines, origins, factory, verifier, dependencies,
    setClock(nextWall: number, nextMono: number) { wall = nextWall; mono = nextMono; } };
}

it("admits background requests beyond 85 seconds and preserves their original 240 second deadline across all stages", async () => {
  for (const elapsed of [85_001, 239_999]) {
    const f = fixture({ policy: "background", elapsed });
    const result = await f.verifier.verify(f.input);
    expect(result).toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3 });
    expect(f.stages).toEqual(["inventory", "consent", "overtime"]);
    expect(f.deadlines).toEqual([340_000, 340_000, 340_000]);
    expect(f.origins[0]).toMatchObject({ requestStartedAt: ORIGIN_WALL, requestStartedMonotonic: ORIGIN_MONOTONIC });
  }
});

it("captures the configured timing policy before callers can mutate the dependency object", async () => {
  const background = fixture({ policy: "background", elapsed: 90_000 });
  background.dependencies.timingPolicy = "standard";
  expect((await background.verifier.verify(background.input)).decision).toBe("pass");
  expect(background.deadlines).toEqual([340_000, 340_000, 340_000]);

  const standard = fixture({ policy: "standard", elapsed: 90_000 });
  standard.dependencies.timingPolicy = "background";
  expect((await standard.verifier.verify(standard.input)).decision).toBe("withhold");
  expect(standard.factory).not.toHaveBeenCalled();
});

it("withholds invalid trusted timing policies before creating an executor", async () => {
  const factory = vi.fn(() => async () => undefined);
  const input = { ...caseInput("nine-month-control"), requestStartedAt: ORIGIN_WALL, requestStartedMonotonic: ORIGIN_MONOTONIC };
  for (const timingPolicy of [null, "", "slow", 240_000, false, {}, []]) {
    const verifier = createReviewedSplitVerifier({ createExecutor: factory,
      clock: { wall: () => ORIGIN_WALL, monotonic: () => ORIGIN_MONOTONIC }, timingPolicy } as never);
    expect(await verifier.verify(input)).toMatchObject({ decision: "withhold", reason: "invalid_input", dispatchCount: 0 });
  }
  expect(factory).not.toHaveBeenCalled();
});

it("uses one original background allowance while later stages consume the remaining time", async () => {
  const f = fixture({ policy: "background", elapsed: 90_000,
    finishAt: { inventory: 130_000, consent: 200_000, overtime: 239_999 } });
  expect((await f.verifier.verify(f.input)).decision).toBe("pass");
  expect(f.deadlines).toEqual([340_000, 340_000, 340_000]);
  expect(f.origins).toHaveLength(1);
});

it("does not restart the background allowance after inventory reaches the original deadline", async () => {
  const f = fixture({ policy: "background", elapsed: 90_000, finishAt: { inventory: 240_000 } });
  expect((await f.verifier.verify(f.input)).decision).toBe("withhold");
  expect(f.stages).toEqual(["inventory"]);
  expect(f.deadlines).toEqual([340_000]);
});

it("rejects background requests exhausted by either clock before constructing an executor", async () => {
  for (const kind of ["wall", "monotonic", "both"] as const) {
    const f = fixture({ policy: "background" });
    f.setClock(kind === "monotonic" ? 339_999 : 340_000,
      kind === "wall" ? ORIGIN_MONOTONIC : ORIGIN_MONOTONIC + 240_000);
    expect((await f.verifier.verify(f.input)).decision).toBe("withhold");
    expect(f.factory).not.toHaveBeenCalled();
  }
});

it("keeps the monotonic background cap when wall time rolls backward during a stage", async () => {
  let wall = 330_000, mono = 231_000;
  const stages: Stage[] = [], deadlines: number[] = [];
  const verifier = createReviewedSplitVerifier({ timingPolicy: "background",
    clock: { wall: () => wall, monotonic: () => mono }, createExecutor: () => async request => {
      stages.push(request.stage); deadlines.push(request.deadlineAt);
      wall = 100_500; mono = 241_000;
      return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
        usage: { input: 10, output: 20, thought: 30 } };
    } });
  const result = await verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: ORIGIN_WALL,
    requestStartedMonotonic: ORIGIN_MONOTONIC });
  expect(result.decision).toBe("withhold");
  expect(stages).toEqual(["inventory"]); expect(deadlines).toEqual([340_000]);
});

it("rejects a preaborted background request before constructing an executor", async () => {
  const f = fixture({ policy: "background", elapsed: 90_000 }), controller = new AbortController();
  controller.abort();
  expect((await f.verifier.verify({ ...f.input, signal: controller.signal })).decision).toBe("withhold");
  expect(f.factory).not.toHaveBeenCalled();
});

it("preserves the caller's earlier cutoff for every background stage", async () => {
  const f = fixture({ policy: "background", elapsed: 90_000 });
  expect((await f.verifier.verify({ ...f.input, deadlineAt: 200_000 })).decision).toBe("pass");
  expect(f.deadlines).toEqual([200_000, 200_000, 200_000]);
});

it("rejects an expired caller cutoff on monotonic time when wall time is earlier", async () => {
  const f = fixture({ policy: "background" });
  f.setClock(100_500, 2_000);
  expect((await f.verifier.verify({ ...f.input, deadlineAt: 101_000 })).decision).toBe("withhold");
  expect(f.factory).not.toHaveBeenCalled();
});

it("aborts an uncooperative background stage at an earlier caller cutoff and clears its timers", async () => {
  vi.useFakeTimers(); let mono = 90_000, stageSignal: AbortSignal | undefined;
  const deadlines: number[] = [];
  const verifier = createReviewedSplitVerifier({ timingPolicy: "background",
    clock: { wall: () => ORIGIN_WALL + mono, monotonic: () => ORIGIN_MONOTONIC + mono },
    createExecutor: () => async (request, signal) => {
      deadlines.push(request.deadlineAt); stageSignal = signal; return new Promise(() => {});
    } });
  const pending = verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: ORIGIN_WALL,
    requestStartedMonotonic: ORIGIN_MONOTONIC, deadlineAt: 190_020 });
  await vi.advanceTimersByTimeAsync(0);
  mono = 90_020; await vi.advanceTimersByTimeAsync(20);
  expect((await pending).decision).toBe("withhold");
  expect(deadlines).toEqual([190_020]); expect(stageSignal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("retains the 85 second deadline for omitted and explicit standard timing policies", async () => {
  for (const policy of [undefined, "standard"] as const) {
    const admitted = fixture({ policy, elapsed: 84_999 });
    expect((await admitted.verifier.verify(admitted.input)).decision).toBe("pass");
    expect(admitted.deadlines).toEqual([185_000, 185_000, 185_000]);
    const expired = fixture({ policy, elapsed: 85_000 });
    expect((await expired.verifier.verify(expired.input)).decision).toBe("withhold");
    expect(expired.factory).not.toHaveBeenCalled();
  }
});

it("does not let a request-owned timing policy widen the default standard allowance", async () => {
  const f = fixture({ elapsed: 90_000 });
  expect((await f.verifier.verify({ ...f.input, ...{ timingPolicy: "background" } })).decision).toBe("withhold");
  expect(f.factory).not.toHaveBeenCalled();
});


it("notifies the trusted stage callback about inventory before either audit and all three validated stages", async () => {
  const passed: Stage[] = [], dispatchesAtCallback: Stage[][] = [];
  const f = fixture({ policy: "background", onStagePassed: async request => {
    passed.push(request.stage); dispatchesAtCallback.push([...f.stages]);
  } });
  expect((await f.verifier.verify(f.input)).decision).toBe("pass");
  expect(passed[0]).toBe("inventory");
  expect([...passed].sort()).toEqual(["consent", "inventory", "overtime"]);
  expect(dispatchesAtCallback[0]).toEqual(["inventory"]);
});

it("withholds when the inventory stage callback rejects and never dispatches either audit", async () => {
  const passed: Stage[] = [];
  const f = fixture({ policy: "background", onStagePassed: async request => {
    passed.push(request.stage); throw new Error("trusted_checkpoint_failed");
  } });
  expect(await f.verifier.verify(f.input)).toMatchObject({ decision: "withhold", reason: "reservation_failed", dispatchCount: 1 });
  expect(passed).toEqual(["inventory"]);
  expect(f.stages).toEqual(["inventory"]);
});


it("reads an accessor-backed trusted timing policy once and captures its first value", async () => {
  let reads = 0;
  const deadlines: number[] = [];
  const verifier = createReviewedSplitVerifier({
    get timingPolicy(): TimingPolicy { reads++; return reads === 1 ? "background" : "standard"; },
    clock: { wall: () => ORIGIN_WALL + 90_000, monotonic: () => ORIGIN_MONOTONIC + 90_000 },
    createExecutor: () => async request => {
      deadlines.push(request.deadlineAt);
      return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
        usage: { input: 10, output: 20, thought: 30 } };
    } });
  expect(reads).toBe(1);
  expect((await verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: ORIGIN_WALL,
    requestStartedMonotonic: ORIGIN_MONOTONIC })).decision).toBe("pass");
  expect(reads).toBe(1); expect(deadlines).toEqual([340_000, 340_000, 340_000]);
});

it("keeps queued wall time spent before a worker restart in the monotonic background allowance", async () => {
  let wall = 140_000, mono = 1_000;
  const stages: Stage[] = [], deadlines: number[] = [];
  const verifier = createReviewedSplitVerifier({ timingPolicy: "background",
    clock: { wall: () => wall, monotonic: () => mono }, createExecutor: () => async request => {
      stages.push(request.stage); deadlines.push(request.deadlineAt);
      wall = 100_000; mono = 201_000;
      return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
        usage: { input: 10, output: 20, thought: 30 } };
    } });
  const result = await verifier.verify({ ...caseInput("nine-month-control"), requestStartedAt: 100_000,
    requestStartedMonotonic: 1_000 });
  expect(result.decision).toBe("withhold");
  expect(stages).toEqual(["inventory"]); expect(deadlines).toEqual([340_000]);
});

it("clamps an oversized standard caller cutoff to the original 85-second reviewed deadline", async () => {
  const f = fixture({ policy: "standard", elapsed: 20_000 });
  expect(await f.verifier.verify({ ...f.input, deadlineAt: 190_000 }))
    .toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3 });
  expect(f.deadlines).toEqual([185_000, 185_000, 185_000]);
});
