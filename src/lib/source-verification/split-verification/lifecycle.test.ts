// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { selectEmploymentEvidence } from "../employment-evidence";
import { createChatVerificationGate } from "../chat-verification-gate";
import { PILOT_IDENTITY, PILOT_REGISTRY } from "../reviewed-source-cases";
import { createSplitVerifier, createOfflineCompletion, type StageExecutor, type SplitRunInput, type SplitResult } from "./runner";
import { createReservationLedger } from "./ledger";
import { prepareSplitInput, type StageRequest } from "./contracts";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes("split-offline-test-")) throw new Error("unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "split-offline-test-")); directories.push(directory);
  const selected = selectEmploymentEvidence({ question: "Can my boss require overtime?", history: [], attachments: [] });
  if (selected.status !== "selected") throw new Error("missing fixture");
  const input: SplitRunInput = { question: selected.question, facts: "Nine months; pregnancy unknown.", candidate: "At nine months the child-age branch does not apply; pregnancy remains unknown.", evidence: selected.evidence,
    requestStartedAt: Date.now(), requestStartedMonotonic: performance.now() };
  const ledger = createReservationLedger({ directory, campaign: "split-verifier-offline-v1", caseId: "nine-month-control" });
  const requests: StageRequest[] = [];
  const execute: StageExecutor = async request => { requests.push(request); return response(request); };
  return { directory, input, ledger, requests, execute };
}
function response(request: StageRequest) {
  const governing = request.data.context.source_conditions[0].evidenceId;
  const value = request.stage === "inventory" ? { stage: "inventory", decision: "pass", segments: request.data.context.segments.map((s, i) => ({ segmentId: s.segmentId,
    claims: [{ claimId: `c${i}`, quote: s.text, status: "supported", evidenceIds: [governing] }] })) } : {
    stage: request.stage, decision: "pass", partition: "accepted", claims: request.data.inventory!.segments.flatMap(s => s.claims.map(c => ({ claimId: c.claimId,
      ...(request.stage === "consent" ? { assessment: "not_applicable", scope: "none" } : { assessment: "preserved", scope: "overtime", conclusion: "branch_only", alternatives: "unknown" }) }))) };
  return { binding: request.binding, status: "completed", json: JSON.stringify(value), usage: { input: 10, output: 20, thought: 30 } };
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe("durable experimental reservations", () => {
  it("consumes one fixed case across concurrent constructors, restart and ambiguous interruption", async () => {
    const f = await setup();
    const other = createReservationLedger({ directory: f.directory, campaign: "split-verifier-offline-v1", caseId: "nine-month-control" });
    const results = await Promise.all([f.ledger.reserveCase(), other.reserveCase()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const restarted = createReservationLedger({ directory: f.directory, campaign: "split-verifier-offline-v1", caseId: "nine-month-control" });
    expect(await restarted.reserveCase()).toBe(false);
    expect(await restarted.reserveStage("inventory")).toBe(false);
    const winner = results[0] ? f.ledger : other;
    expect(await winner.reserveStage("inventory")).toBe(true);
    expect(await winner.reserveStage("inventory")).toBe(false);
    expect(await winner.reserveStage("invented" as never)).toBe(false);
    const files = await readdir(f.directory, { recursive: true });
    expect(files.some(file => file.endsWith("inventory.reserved"))).toBe(true);
  });

  it("rejects request-selected namespace/path identifiers", async () => {
    const f = await setup();
    expect(() => createReservationLedger({ directory: f.directory, campaign: "new-run" as never, caseId: "../reset" as never })).toThrow();
    expect(await f.ledger.reserveStage("consent")).toBe(false);
  });
});

describe("fixed split execution", () => {
  it("publishes frozen stage diagnostics synchronously when a caller cancels pending audits", async () => {
    const f = await setup(), controller = new AbortController(), entered = deferred<void>(), late = deferred<void>();
    const snapshots: SplitResult[] = []; let time = 0, arrived = 0;
    // An integer origin keeps exact simulated durations independent of floating-point cancellation.
    const clock = { wall: () => f.input.requestStartedAt + time, monotonic: () => time };
    const pending = createSplitVerifier({ ledger: f.ledger, clock, execute: async request => {
      if (request.stage === "inventory") time = 400;
      else { if (++arrived === 2) entered.resolve(); await late.promise; }
      return response(request);
    } }).verify({ ...f.input, requestStartedMonotonic: 0, signal: controller.signal }, snapshot => { snapshots.push(snapshot); });
    await entered.promise; time = 1000; controller.abort();
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0], serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({ decision: "withhold", reason: "aborted", dispatchCount: 3, elapsedMs: 1000,
      stages: [{ stage: "inventory", status: "passed", elapsedMs: 400 }, { stage: "consent", status: "cancelled", elapsedMs: 600 },
        { stage: "overtime", status: "cancelled", elapsedMs: 600 }], usage: { coverage: "partial", knownStages: 1, dispatchedStages: 3 } });
    expect(Object.isFrozen(snapshot.stages[0].usage)).toBe(true); expect(Object.isFrozen(snapshot.stages[1])).toBe(true);
    expect(serialized).not.toMatch(/question|candidate|sourceId|binding|evidenceIds/);
    expect(await pending).toMatchObject({ decision: "withhold", reason: "aborted" });
    time = 2000; late.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(snapshots).toHaveLength(1); expect(JSON.stringify(snapshot)).toBe(serialized);
  });

  it("keeps cancellation unchanged when a diagnostics observer throws", async () => {
    const f = await setup(), controller = new AbortController(), observed = vi.fn((_snapshot: SplitResult) => { throw new Error("PRIVATE observer failure"); });
    let stageSignal: AbortSignal | undefined;
    const result = await createSplitVerifier({ ledger: f.ledger, execute: async (request, signal) => {
      stageSignal = signal; controller.abort(); return response(request);
    } }).verify({ ...f.input, signal: controller.signal }, observed);
    expect(observed).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ decision: "withhold", reason: "aborted", dispatchCount: 1 });
    expect(stageSignal?.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("does not publish a provisional pass before all enclosing deadline guards finish", async () => {
    const f = await setup(), controller = new AbortController(); let time = 0;
    const clock = { wall: () => f.input.requestStartedAt + time, monotonic: () => f.input.requestStartedMonotonic + time };
    const observed = vi.fn((_snapshot: SplitResult) => { time = 85000; controller.abort(); });
    const result = await createSplitVerifier({ ledger: f.ledger, execute: f.execute, clock }).verify({ ...f.input, signal: controller.signal }, observed);
    expect(result).toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3 });
    expect(observed).not.toHaveBeenCalled(); expect(controller.signal.aborted).toBe(false);
  });

  it("a real successful three-stage aggregate remains rejected by the current runtime gate", async () => {
    const f = await setup();
    const aggregate = await createSplitVerifier({ ledger: f.ledger, execute: f.execute }).verify(f.input);
    expect(aggregate.decision).toBe("pass");
    const selection = selectEmploymentEvidence({ question: f.input.question, history: [], attachments: [] });
    if (selection.status !== "selected") throw new Error("missing fixture");
    const gate = createChatVerificationGate({ registry: PILOT_REGISTRY,
      resolveAuthority: async () => ({ status: "authorized", identities: [PILOT_IDENTITY] }), verifier: { evaluate: async () => aggregate } });
    expect(await gate.verify({ ...f.input, kind: "legal", requests: selection.requests, deadlineAt: f.input.requestStartedAt + 85000 }))
      .toMatchObject({ status: "withhold", reason: "verification_rejected" });
  });

  it.each(["swapped-stage", "stale-envelope", "changed-inventory"])("rejects crossed server bindings: %s", async mode => {
    const f = await setup(); let earlier: ReturnType<typeof response> | undefined;
    const result = await createSplitVerifier({ ledger: f.ledger, execute: async request => {
      if (request.stage === "inventory") { earlier = response(request); return earlier; }
      if (mode === "stale-envelope") return earlier;
      const value = response(request);
      if (mode === "swapped-stage") value.json = value.json.replace(`"stage":"${request.stage}"`, `"stage":"${request.stage === "consent" ? "overtime" : "consent"}"`);
      else value.binding = { ...request.binding, inventorySha256: "0".repeat(64) };
      return value;
    } }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "invalid_response" });
    expect(result.dispatchCount).toBeLessThanOrEqual(3);
  });

  it("keeps every stage frozen while caller-owned candidate/facts mutate after admission", async () => {
    const f = await setup(), mutable = { ...f.input };
    const result = await createSplitVerifier({ ledger: f.ledger, execute: async request => {
      Object.assign(mutable, { candidate: "Changed after admission.", facts: "Changed facts." });
      expect(request.data.context.candidate).toBe(f.input.candidate);
      expect(request.data.context.facts).toBe(f.input.facts);
      expect(Object.isFrozen(request.data.context.evidence)).toBe(true);
      expect(() => Object.assign(request.data.context, { candidate: "forged" })).toThrow();
      if (request.data.inventory) expect(Object.isFrozen(request.data.inventory.segments[0].claims[0].evidenceIds)).toBe(true);
      return response(request);
    } }).verify(mutable);
    expect(result.decision).toBe("pass");
  });

  it("runs inventory then simultaneous audits exactly once with honest immutable usage", async () => {
    const f = await setup(), audits = deferred<void>(); let arrived = 0;
    const verifier = createSplitVerifier({ ledger: f.ledger, execute: async request => {
      f.requests.push(request);
      if (request.stage !== "inventory") { arrived++; if (arrived === 2) audits.resolve(); await audits.promise; }
      return response(request);
    } });
    const result = await verifier.verify(f.input);
    expect(result).toMatchObject({ purpose: "offline_split_verification_v1", productionEligible: false, runtimeEnabled: false, decision: "pass", dispatchCount: 3,
      usage: { coverage: "complete", knownStages: 3, dispatchedStages: 3, knownSubtotal: { input: 30, output: 60, thought: 90 } } });
    expect(result).not.toHaveProperty("attemptCount");
    expect(f.requests[0].stage).toBe("inventory");
    expect(f.requests.slice(1).map(r => r.stage).sort()).toEqual(["consent", "overtime"]);
    expect(new Set(f.requests.map(r => r.deadlineAt)).size).toBe(1);
    expect(f.requests[0].deadlineAt).toBe(f.input.requestStartedAt + 85000);
    expect(Object.isFrozen(result.stages[0])).toBe(true);
    expect((await verifier.verify(f.input)).dispatchCount).toBe(0);
  });

  it.each(["failed", "in_progress", "requires_action", "bad-json", "wrong-binding", "withhold"])("starts no audit after inventory %s", async mode => {
    const f = await setup();
    const result = await createSplitVerifier({ ledger: f.ledger, execute: async request => {
      f.requests.push(request); const value = response(request);
      if (["failed", "in_progress", "requires_action"].includes(mode)) value.status = mode;
      if (mode === "bad-json") value.json = "{";
      if (mode === "wrong-binding") value.binding = { ...value.binding };
      if (mode === "withhold") value.json = value.json.replace('"pass"', '"withhold"').replace('"supported"', '"insufficient_evidence"');
      return value;
    } }).verify(f.input);
    expect(result.decision).toBe("withhold");
    expect(result.dispatchCount).toBe(1);
    expect(f.requests).toHaveLength(1);
  });

  it("cancels an ignoring sibling, consumes late rejection and never mutates final accounting", async () => {
    const f = await setup(), late = deferred<ReturnType<typeof response>>(), started = deferred<void>();
    const running = createSplitVerifier({ ledger: f.ledger, execute: async request => {
      if (request.stage === "overtime") { started.resolve(); return late.promise; }
      if (request.stage === "consent") { await started.promise; throw new Error("private provider details"); }
      return response(request);
    } }).verify(f.input);
    const result = await running, frozen = JSON.stringify(result);
    expect(result).toMatchObject({ decision: "withhold", dispatchCount: 3, usage: { coverage: "partial", knownStages: 1 } });
    expect(frozen).not.toContain("private provider");
    late.reject(new Error("late private rejection")); await tick();
    expect(JSON.stringify(result)).toBe(frozen);
  });

  it("accepts late success only as ignored settlement after external cancellation", async () => {
    const f = await setup(), signal = new AbortController(), late = deferred<ReturnType<typeof response>>(), entered = deferred<StageRequest>();
    const pending = createSplitVerifier({ ledger: f.ledger, execute: request => { entered.resolve(request); return late.promise; } }).verify({ ...f.input, signal: signal.signal });
    const request = await entered.promise; signal.abort();
    const result = await pending;
    expect(result).toMatchObject({ decision: "withhold", reason: "aborted", dispatchCount: 1, usage: { coverage: "unknown", knownStages: 0 } });
    late.resolve(response(request)); await tick();
    expect(result.usage.knownStages).toBe(0);
  });

  it("does not dispatch after an ignoring reservation resolves following abort", async () => {
    const f = await setup(), reservation = deferred<boolean>(), entered = deferred<void>(), signal = new AbortController();
    const pending = createSplitVerifier({ ledger: { reserveCase: () => { entered.resolve(); return reservation.promise; }, reserveStage: async () => true }, execute: f.execute })
      .verify({ ...f.input, signal: signal.signal });
    await entered.promise; signal.abort();
    expect((await pending).dispatchCount).toBe(0);
    reservation.resolve(true); await tick(); expect(f.requests).toHaveLength(0);
  });

  it("enforces entry deadline, monotonic rollback cap, and no fresh stage window", async () => {
    const f = await setup(); let wall = 100000, monotonic = 90000;
    const result = await createSplitVerifier({ ledger: f.ledger, clock: { wall: () => wall, monotonic: () => monotonic }, execute: async request => {
      wall = 20000; monotonic += 85000; return response(request);
    } }).verify({ ...f.input, requestStartedAt: 100000, requestStartedMonotonic: 90000 });
    expect(result).toMatchObject({ reason: "deadline_exceeded", dispatchCount: 1 });
    const edge = await setup();
    expect(await createSplitVerifier({ ledger: edge.ledger, clock: { wall: () => 85000, monotonic: () => 85000 }, execute: edge.execute })
      .verify({ ...edge.input, requestStartedAt: 0, requestStartedMonotonic: 0 })).toMatchObject({ reason: "deadline_exceeded", dispatchCount: 0 });
  });

  it("timer bounds an executor that ignores abort", async () => {
    const f = await setup(); vi.useFakeTimers();
    const entered = deferred<void>();
    const pending = createSplitVerifier({ ledger: { reserveCase: async () => true, reserveStage: async () => true }, execute: async () => { entered.resolve(); return new Promise(() => {}); } })
      .verify({ ...f.input, requestStartedAt: Date.now(), requestStartedMonotonic: performance.now() });
    await entered.promise; await vi.advanceTimersByTimeAsync(85000);
    expect(await pending).toMatchObject({ reason: "deadline_exceeded", dispatchCount: 1 });
  });

  it.each([undefined, { input: 10 }, { input: -1, output: 20, thought: 30 }, { input: 1, output: 2, thought: 3, raw: "secret" }])("leaves missing/partial/invalid usage unknown", async usage => {
    const f = await setup();
    const result = await createSplitVerifier({ ledger: f.ledger, execute: async request => ({ ...response(request), usage }) }).verify(f.input);
    expect(result.usage).toEqual({ coverage: "unknown", knownStages: 0, dispatchedStages: 3, knownSubtotal: { input: 0, output: 0, thought: 0 } });
  });
});

describe("offline authority and atomic commit orchestration", () => {
  it("requires the second authority result by entry +85s and reserves +110s for commit", async () => {
    const f = await setup(); let wall = 0, monotonic = 0, checks = 0, commits = 0;
    const deadlines: number[] = [], signals: AbortSignal[] = [];
    const result = await createOfflineCompletion({ ledger: f.ledger, execute: f.execute, clock: { wall: () => wall, monotonic: () => monotonic },
      authority: async snapshot => { deadlines.push(snapshot.deadlineAt); signals.push(snapshot.signal); if (++checks === 2) { wall = 85000; monotonic = 85000; } return { authorized: true, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; },
      commit: async () => { commits++; return {}; } }).complete({ ...f.input, requestStartedAt: 0, requestStartedMonotonic: 0 });
    expect(commits).toBe(0);
    expect(deadlines).toEqual([85000, 85000]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(result).toMatchObject({ status: "withhold", reason: "deadline_exceeded" });
  });

  it("a cached completion never blesses a different candidate, facts, source, timing or signal", async () => {
    const f = await setup(); let checks = 0, commits = 0;
    const completion = createOfflineCompletion({ ledger: f.ledger, execute: f.execute,
      authority: async snapshot => { checks++; return { authorized: true, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; },
      commit: async snapshot => { commits++; return { saved: true, candidateSha256: snapshot.candidateSha256, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; } });
    expect((await completion.complete(f.input)).status).toBe("saved");
    const afterSuccess = { authorityChecks: checks, executions: f.requests.length, commits };
    expect(afterSuccess).toEqual({ authorityChecks: 2, executions: 3, commits: 1 });
    const detachedEvidence = structuredClone(f.input.evidence);
    const changedSource = { ...f.input, evidence: { ...detachedEvidence, passages: [...detachedEvidence.passages].reverse() } };
    const alternate = prepareSplitInput(changedSource);
    expect(alternate).toBeDefined();
    expect(alternate?.sourceSnapshotSha256).not.toBe(prepareSplitInput(f.input)?.sourceSnapshotSha256);
    for (const changed of [{ ...f.input, candidate: "Different candidate." }, { ...f.input, facts: "Pregnancy known." },
      changedSource,
      { ...f.input, requestStartedAt: f.input.requestStartedAt - 1 }, { ...f.input, requestStartedMonotonic: f.input.requestStartedMonotonic - 1 },
      { ...f.input, signal: new AbortController().signal }]) {
      expect(await completion.complete(changed)).toMatchObject({ status: "withhold", reason: "request_mismatch" });
      expect({ authorityChecks: checks, executions: f.requests.length, commits }).toEqual(afterSuccess);
    }
    expect(commits).toBe(1);
  });
  it("checks authority twice, commits exact frozen bytes once and permits exact fake reload", async () => {
    const f = await setup(); let checks = 0, commits = 0; const saved: unknown[] = [];
    const completion = createOfflineCompletion({ ledger: f.ledger, execute: f.execute,
      authority: async snapshot => { checks++; expect(snapshot.deadlineAt).toBe(f.input.requestStartedAt + 85000); return { authorized: true, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; },
      commit: async snapshot => { commits++; expect(snapshot.deadlineAt).toBe(f.input.requestStartedAt + 110000); saved.push({ question: snapshot.question, candidate: snapshot.candidate, evidence: snapshot.evidence }); return { saved: true, candidateSha256: snapshot.candidateSha256, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; } });
    const first = completion.complete(f.input), duplicate = completion.complete(f.input);
    expect(await first).toMatchObject({ status: "saved", runtimeEnabled: false });
    expect(await duplicate).toEqual(await first);
    expect(checks).toBe(2); expect(commits).toBe(1);
    expect(saved).toEqual([{ question: f.input.question, candidate: f.input.candidate, evidence: f.input.evidence }]);
  });

  it.each(["before", "after", "commit"])("withholds on %s authority/commit failure without partial save", async mode => {
    const f = await setup(); let checks = 0, commits = 0;
    const result = await createOfflineCompletion({ ledger: f.ledger, execute: f.execute,
      authority: async snapshot => { checks++; if (checks === (mode === "before" ? 1 : mode === "after" ? 2 : -1)) return { authorized: false }; return { authorized: true, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; },
      commit: async () => { commits++; throw new Error("private transaction failure"); } }).complete(f.input);
    expect(result.status).toBe("withhold"); expect(commits).toBe(mode === "commit" ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("private transaction");
  });

  it("blocks commit after an ignoring authority callback settles following cancellation", async () => {
    const f = await setup(), signal = new AbortController(), entered = deferred<void>(), late = deferred<{ authorized: false }>(); let commits = 0;
    const pending = createOfflineCompletion({ ledger: f.ledger, execute: f.execute,
      authority: async () => { entered.resolve(); return late.promise; }, commit: async () => { commits++; return {}; } }).complete({ ...f.input, signal: signal.signal });
    await entered.promise; signal.abort(); expect((await pending).status).toBe("withhold");
    late.resolve({ authorized: false }); await tick(); expect(commits).toBe(0); expect(f.requests).toHaveLength(0);
  });

  it("an already dispatched atomic fake may finish after abort, without duplicate dispatch", async () => {
    const f = await setup(), signal = new AbortController(), entered = deferred<void>(), finish = deferred<void>(); let saves = 0;
    const completion = createOfflineCompletion({ ledger: f.ledger, execute: f.execute,
      authority: async snapshot => ({ authorized: true, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }),
      commit: async snapshot => { entered.resolve(); await finish.promise; saves++; return { saved: true, candidateSha256: snapshot.candidateSha256, sourceSnapshotSha256: snapshot.sourceSnapshotSha256 }; } });
    const pending = completion.complete({ ...f.input, signal: signal.signal });
    await entered.promise; signal.abort(); const result = await pending;
    expect(result).toMatchObject({ status: "withhold", reason: "aborted", commitDispatched: true });
    finish.resolve(); await tick(); expect(saves).toBe(1);
    expect(await completion.complete({ ...f.input, signal: signal.signal })).toEqual(result); expect(saves).toBe(1);
  });
});

describe("server-owned inventory thinking policy", () => {
  it("runs inventory low and both audits medium without changing stage deadlines or candidate binding", async () => {
    const f = await setup();
    const result = await createSplitVerifier({ ledger: f.ledger, execute: f.execute, thinkingPolicy: "inventory_low" }).verify(f.input);
    expect(result).toMatchObject({ decision: "pass", reason: "verified", dispatchCount: 3 });
    expect(f.requests.map(request => request.generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
    for (const request of f.requests) {
      expect(request.deadlineAt).toBe(f.input.requestStartedAt + 85000);
      expect(request.data.context.candidate).toBe(f.input.candidate);
      expect(request.generation_config.max_output_tokens).toBe(8192);
    }
    expect(f.requests[1].binding.inventorySha256).toBe(f.requests[2].binding.inventorySha256);
    expect(f.requests[0].binding.inventorySha256).toBeNull();
  });
  it("captures its policy before later mutation of the dependency object", async () => {
    const f = await setup(), dependencies = { ledger: f.ledger, execute: f.execute, thinkingPolicy: "inventory_low" as "medium" | "inventory_low" };
    const verifier = createSplitVerifier(dependencies);
    dependencies.thinkingPolicy = "medium";
    expect((await verifier.verify(f.input)).decision).toBe("pass");
    expect(f.requests.map(request => request.generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
  });
  it("rejects an unknown policy without consuming reservations or invoking the executor", async () => {
    const f = await setup(), reserveCase = vi.fn(async () => true), reserveStage = vi.fn(async () => true);
    const result = await createSplitVerifier({ ledger: { reserveCase, reserveStage }, execute: f.execute, thinkingPolicy: "globally_low" as never }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "invalid_input", dispatchCount: 0 });
    expect(reserveCase).not.toHaveBeenCalled(); expect(reserveStage).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
  });
  it("withholds at the original 85-second cutoff after inventory low without starting audits", async () => {
    const f = await setup(); let time = 0;
    const result = await createSplitVerifier({ ledger: f.ledger, thinkingPolicy: "inventory_low",
      clock: { wall: () => f.input.requestStartedAt + time, monotonic: () => f.input.requestStartedMonotonic + time },
      execute: async request => { f.requests.push(request); time = 85000; return response(request); } }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "deadline_exceeded", dispatchCount: 1 });
    expect(f.requests).toHaveLength(1); expect(f.requests[0].generation_config.thinking_level).toBe("low");
  });
  it("still withholds a mandatory audit failure after a passing low inventory", async () => {
    const f = await setup(), auditEntered = deferred<void>();
    const result = await createSplitVerifier({ ledger: f.ledger, thinkingPolicy: "inventory_low", execute: async request => {
      f.requests.push(request); const output = response(request);
      if (request.stage === "overtime") auditEntered.resolve();
      if (request.stage === "consent") { await auditEntered.promise; const verdict = JSON.parse(output.json); verdict.decision = "withhold"; verdict.partition = "rejected"; output.json = JSON.stringify(verdict); }
      return output;
    } }).verify(f.input);
    expect(result).toMatchObject({ decision: "withhold", reason: "stage_rejected", dispatchCount: 3 });
    expect(f.requests.map(request => request.generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
  });
});

describe("single-read kernel policy capture", () => {
  it("reads a kernel policy accessor exactly once before reserving a case", async () => {
    const f = await setup(); let reads = 0;
    const verifier = createSplitVerifier({ ledger: f.ledger, execute: f.execute, get thinkingPolicy() { return ++reads === 1 ? "inventory_low" as const : "medium" as const; } });
    expect((await verifier.verify(f.input)).decision).toBe("pass");
    expect(reads).toBe(1);
    expect(f.requests.map(request => request.generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
  });
});
