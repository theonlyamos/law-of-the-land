// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseInput } from "../test-fixtures/reviewed-request-catalog";
import { authoredStage } from "../test-fixtures/reviewed-answer-fixtures";
import type { StageRequest } from "./contracts";
import { createSplitVerifier, type SplitRunInput, type StageExecutor } from "./runner";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  let wall = 100_000, mono = 1_000;
  const input: SplitRunInput = { ...caseInput("nine-month-control"), requestStartedAt: 100_000, requestStartedMonotonic: 1_000 };
  const requests: StageRequest[] = [];
  const reserveCase = vi.fn(async () => true), reserveStage = vi.fn(async () => true);
  const execute: StageExecutor = async request => { requests.push(request); return response(request); };
  const dependencies = { ledger: { reserveCase, reserveStage }, execute, clock: { wall: () => wall, monotonic: () => mono } };
  return { input, requests, reserveCase, reserveStage, dependencies, setClock(w: number, m: number) { wall = w; mono = m; } };
}
function response(request: StageRequest) {
  return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)), usage: { input: 10, output: 20, thought: 30 } };
}

describe("background split timing policy", () => {
  it("accepts verification after 85 seconds with one fixed 240-second deadline and unchanged stage settings", async () => {
    const f = fixture(); f.setClock(190_000, 91_000);
    const result = await createSplitVerifier({ ...f.dependencies, timingPolicy: "background", thinkingPolicy: "inventory_low" }).verify(f.input);
    expect(result).toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3, usage: { coverage: "complete" } });
    expect(f.requests.map(request => request.deadlineAt)).toEqual([340_000, 340_000, 340_000]);
    expect(f.requests.map(request => request.generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
    for (const request of f.requests) {
      expect(request.generation_config.max_output_tokens).toBe(8192);
      expect(request.data.context.candidate).toBe(f.input.candidate);
    }
  });
  it("does not renew the background window after inventory or between audits", async () => {
    const f = fixture(); f.setClock(220_000, 121_000);
    const result = await createSplitVerifier({ ...f.dependencies, timingPolicy: "background", execute: async request => {
      f.requests.push(request);
      if (request.stage === "inventory") f.setClock(339_999, 240_999);
      return response(request);
    } }).verify(f.input);
    expect(result).toMatchObject({ decision: "pass", dispatchCount: 3 });
    expect(f.requests.map(request => request.deadlineAt)).toEqual([340_000, 340_000, 340_000]);
  });
  it.each([undefined, "standard"] as const)("keeps the standard 85-second cutoff for policy %s", async timingPolicy => {
    const f = fixture(); f.setClock(185_000, 86_000);
    expect(await createSplitVerifier({ ...f.dependencies, timingPolicy }).verify(f.input))
      .toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 0 });
    expect(f.reserveCase).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
  });
  it.each([240_000, 240_001])("withholds before reservations at background elapsed %i", async elapsed => {
    const f = fixture(); f.setClock(100_000 + elapsed, 1_000 + elapsed);
    expect(await createSplitVerifier({ ...f.dependencies, timingPolicy: "background" }).verify(f.input))
      .toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 0 });
    expect(f.reserveCase).not.toHaveBeenCalled(); expect(f.reserveStage).not.toHaveBeenCalled();
  });
  it("keeps an earlier original deadline through every kernel stage", async () => {
    const f = fixture(); f.setClock(190_000, 91_000);
    expect(await createSplitVerifier({ ...f.dependencies, timingPolicy: "background" }).verify({ ...f.input, deadlineAt: 220_000 }))
      .toMatchObject({ decision: "pass", dispatchCount: 3 });
    expect(f.requests.map(request => request.deadlineAt)).toEqual([220_000, 220_000, 220_000]);
  });
  it("withholds after the earlier cutoff is consumed during inventory", async () => {
    const f = fixture();
    const result = await createSplitVerifier({ ...f.dependencies, timingPolicy: "background", execute: async request => {
      f.requests.push(request); f.setClock(220_000, 121_000); return response(request);
    } }).verify({ ...f.input, deadlineAt: 220_000 });
    expect(result).toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 1 });
    expect(f.requests.map(request => request.stage)).toEqual(["inventory"]);
  });
  it("keeps the background monotonic cap when the wall clock rolls backward after entry", async () => {
    const f = fixture();
    const result = await createSplitVerifier({ ...f.dependencies, timingPolicy: "background", execute: async request => {
      f.requests.push(request); f.setClock(99_000, 241_000); return response(request);
    } }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 1 });
    expect(f.requests).toHaveLength(1);
  });
  it("does not reserve or dispatch a pre-aborted background request", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(await createSplitVerifier({ ...f.dependencies, timingPolicy: "background" }).verify({ ...f.input, signal: controller.signal }))
      .toMatchObject({ decision: "withhold", reason: "aborted", dispatchCount: 0 });
    expect(f.reserveCase).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
  });
  it.each([null, "unknown", false, 240_000])("rejects invalid constructor timing policy %j before reservations or execution", async timingPolicy => {
    const f = fixture();
    expect(await createSplitVerifier({ ...f.dependencies, timingPolicy } as never).verify(f.input)).toMatchObject({ decision: "withhold", reason: "invalid_input", dispatchCount: 0 });
    expect(f.reserveCase).not.toHaveBeenCalled(); expect(f.reserveStage).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
  });
  it("captures the trusted timing policy before later dependency mutation", async () => {
    const f = fixture(), dependencies = { ...f.dependencies, timingPolicy: "background" as "standard" | "background" };
    const verifier = createSplitVerifier(dependencies); dependencies.timingPolicy = "standard";
    f.setClock(190_000, 91_000);
    expect(await verifier.verify(f.input)).toMatchObject({ decision: "pass", dispatchCount: 3 });
    expect(f.requests.map(request => request.deadlineAt)).toEqual([340_000, 340_000, 340_000]);
  });
  it("reads the trusted timing policy accessor exactly once", async () => {
    const f = fixture(); let reads = 0;
    const verifier = createSplitVerifier({ ...f.dependencies, get timingPolicy() { return ++reads === 1 ? "background" as const : "standard" as const; } });
    f.setClock(190_000, 91_000);
    expect((await verifier.verify(f.input)).decision).toBe("pass"); expect(reads).toBe(1);
  });
  it("does not let a request-selected policy enlarge the standard factory deadline", async () => {
    const f = fixture(); f.setClock(185_000, 86_000);
    expect(await createSplitVerifier(f.dependencies).verify({ ...f.input, timingPolicy: "background" } as never))
      .toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 0 });
    expect(f.reserveCase).not.toHaveBeenCalled();
  });
});

describe("trusted passing-stage persistence hook", () => {
  it("awaits the passing inventory hook before starting either audit and reports only validated requests", async () => {
    const f = fixture(), order: string[] = [], passed: StageRequest[] = [];
    let inventoryEntered!: () => void, finishInventory!: () => void;
    const entered = new Promise<void>(resolve => { inventoryEntered = resolve; });
    const inventorySaved = new Promise<void>(resolve => { finishInventory = resolve; });
    const onStagePassed = async (request: StageRequest) => {
      passed.push(request); order.push(`passed:${request.stage}`);
      if (request.stage === "inventory") { inventoryEntered(); await inventorySaved; order.push("inventory-saved"); }
    };
    const pending = createSplitVerifier({ ...f.dependencies, onStagePassed, execute: async request => {
      f.requests.push(request); order.push(`execute:${request.stage}`); return response(request);
    } }).verify(f.input);
    await Promise.race([entered, pending]);
    const stagesBeforeSave = f.requests.map(request => request.stage);
    finishInventory(); const result = await pending;
    expect(stagesBeforeSave).toEqual(["inventory"]);
    expect(result).toMatchObject({ decision: "pass", dispatchCount: 3 });
    expect(passed.map(request => request.stage)).toEqual(["inventory", "consent", "overtime"]);
    expect(passed[0]).toBe(f.requests[0]); expect(Object.isFrozen(passed[0])).toBe(true);
    expect(order.indexOf("inventory-saved")).toBeLessThan(order.indexOf("execute:consent"));
    expect(order.indexOf("inventory-saved")).toBeLessThan(order.indexOf("execute:overtime"));
  });
  it.each(["wrong-binding", "bad-schema", "negative-inventory"] as const)("does not run the passing hook for %s", async kind => {
    const f = fixture(), passed: string[] = [];
    const result = await createSplitVerifier({ ...f.dependencies, onStagePassed: async request => { passed.push(request.stage); },
      execute: async request => {
        f.requests.push(request); const output = response(request);
        if (kind === "wrong-binding") return { ...output, binding: { ...request.binding } };
        if (kind === "bad-schema") return { ...output, json: '{"stage":"inventory","decision":"pass"}' };
        const verdict = JSON.parse(output.json); verdict.decision = "withhold"; verdict.segments[0].claims[0].status = "insufficient_evidence";
        return { ...output, json: JSON.stringify(verdict) };
      } }).verify(f.input);
    expect(result.decision).toBe("withhold"); expect(result.dispatchCount).toBe(1);
    expect(passed).toEqual([]); expect(f.requests.map(request => request.stage)).toEqual(["inventory"]);
  });
  it("withholds a passing inventory when its persistence hook rejects and never dispatches an audit", async () => {
    const f = fixture(), passed: string[] = [];
    const result = await createSplitVerifier({ ...f.dependencies, onStagePassed: async request => {
      passed.push(request.stage); throw new Error("PRIVATE persistence failure");
    } }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "reservation_failed", dispatchCount: 1 });
    expect(f.requests.map(request => request.stage)).toEqual(["inventory"]); expect(passed).toEqual(["inventory"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("cancels an ignoring persistence hook on caller abort without starting audits", async () => {
    const f = fixture(), controller = new AbortController();
    let hookEntered!: () => void; const entered = new Promise<void>(resolve => { hookEntered = resolve; });
    const pending = createSplitVerifier({ ...f.dependencies, onStagePassed: async () => {
      hookEntered(); return new Promise<void>(() => {});
    } }).verify({ ...f.input, signal: controller.signal });
    await Promise.race([entered, pending]); controller.abort();
    expect(await pending).toMatchObject({ decision: "withhold", reason: "aborted", dispatchCount: 1 });
    expect(f.requests.map(request => request.stage)).toEqual(["inventory"]);
  });
});

it("bounds an ignoring background executor by the remaining original allowance rather than a fresh stage window", async () => {
  vi.useFakeTimers(); const f = fixture(); f.setClock(190_000, 91_000);
  let entered!: () => void, stageSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = createSplitVerifier({ ...f.dependencies, timingPolicy: "background", execute: async (_request, signal) => {
    stageSignal = signal; entered(); return new Promise(() => {});
  } }).verify(f.input);
  await vi.advanceTimersByTimeAsync(0); await Promise.race([started, pending]);
  f.setClock(340_000, 241_000); await vi.advanceTimersByTimeAsync(150_000);
  expect(await pending).toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 1 });
  expect(stageSignal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("rejects a background caller deadline beyond the original 240-second cap before reservation", async () => {
  const f = fixture();
  expect(await createSplitVerifier({ ...f.dependencies, timingPolicy: "background" }).verify({ ...f.input, deadlineAt: 340_001 }))
    .toMatchObject({ decision: "withhold", reason: "invalid_deadline", dispatchCount: 0 });
  expect(f.reserveCase).not.toHaveBeenCalled(); expect(f.reserveStage).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
});

it("consumes persisted wall-clock queue time before starting a new-process background monotonic allowance", async () => {
  const f = fixture(); f.setClock(140_000, 1_000);
  const result = await createSplitVerifier({ ...f.dependencies, timingPolicy: "background", execute: async request => {
    f.requests.push(request); f.setClock(100_000, 201_000); return response(request);
  } }).verify(f.input);
  expect(result).toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 1 });
  expect(f.requests.map(request => request.deadlineAt)).toEqual([340_000]);
});

it("clamps an oversized standard caller cutoff to the original 85-second kernel deadline", async () => {
  const f = fixture(); f.setClock(120_000, 21_000);
  expect(await createSplitVerifier({ ...f.dependencies, timingPolicy: "standard" }).verify({ ...f.input, deadlineAt: 190_000 }))
    .toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3 });
  expect(f.requests.map(request => request.deadlineAt)).toEqual([185_000, 185_000, 185_000]);
});
