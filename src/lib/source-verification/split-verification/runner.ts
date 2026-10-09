import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvaluationVerifierInput } from "../verdict";
import { STAGES, buildStageRequest, deepFreeze, joinSplitVerdict, prepareSplitInput, validateAudit, validateInventory,
  type Audit, type ConsentAudit, type Inventory, type OvertimeAudit, type PreparedSplitInput, type SplitThinkingPolicy, type Stage, type StageRequest } from "./contracts";
import type { ReservationLedger } from "./ledger";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "../trusted-timing-policy";

export type SplitRunInput = EvaluationVerifierInput & Readonly<{ requestStartedAt: number; requestStartedMonotonic: number; deadlineAt?: number; signal?: AbortSignal }>;
export type StageExecutor = (request: StageRequest, signal: AbortSignal) => Promise<unknown>;
export type Clock = Readonly<{ wall(): number; monotonic(): number }>;
const defaultClock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
type FailureReason = "invalid_input" | "invalid_deadline" | "aborted" | "deadline_exceeded" | "reservation_failed" | "provider_error"
  | "invalid_response" | "stage_rejected" | "authority_unavailable" | "authority_changed" | "commit_failed" | "request_mismatch";
class Failure extends Error { constructor(readonly reason: FailureReason) { super(reason); } }
const elapsed = (start: number, end: number) => Number.isFinite(end - start) ? Math.max(0, Math.floor(end - start)) : 0;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.strictObject({ input: count, output: count, thought: count });
type Usage = z.infer<typeof usageSchema>;
type StageStatus = "not_started" | "reserved" | "passed" | "withheld" | "cancelled";
type StageDiagnostic = { stage: Stage; status: StageStatus; dispatched: boolean; elapsedMs: number; usage?: Usage };
const labels = { purpose: "offline_split_verification_v1", productionEligible: false, runtimeEnabled: false, experimental: true } as const;

/** One absolute entry budget plus monotonic cap. Waiting never trusts a callback
 * to observe abort. Race handlers consume late rejections without retaining data. */
function createScope(input: Pick<SplitRunInput, "requestStartedAt" | "requestStartedMonotonic" | "signal">, clock: Clock, allowance: number,
  onCancel?: (reason: FailureReason) => void, requestedDeadlineAt?: number) {
  const entered = input.requestStartedAt, enteredMono = input.requestStartedMonotonic, caller = input.signal;
  const now = clock.wall(), mono = clock.monotonic(), deadlineAt = requestedDeadlineAt ?? entered + allowance;
  const duration = deadlineAt - entered;
  if (!Number.isSafeInteger(entered) || entered < 0 || !Number.isFinite(enteredMono) || enteredMono < 0
    || !Number.isFinite(now) || !Number.isFinite(mono) || entered > now || enteredMono > mono
    || !Number.isSafeInteger(deadlineAt) || duration <= 0 || duration > allowance) throw new Failure("invalid_deadline");
  // Capture the wall allowance once; a restarted worker may have a current-process monotonic origin.
  const monotonicLimit = mono + Math.min(deadlineAt - now, duration - (mono - enteredMono));
  const controller = new AbortController();
  let reason: FailureReason | undefined;
  let settle!: (reason: FailureReason) => void;
  const cancelled = new Promise<FailureReason>(resolve => { settle = resolve; });
  const cancel = (next: FailureReason) => { if (!reason) {
    reason = next; settle(next); try { onCancel?.(next); } catch {} controller.abort();
  } };
  const check = () => {
    if (!reason) {
      const wallNow = clock.wall(), monoNow = clock.monotonic();
      if (!Number.isFinite(wallNow) || !Number.isFinite(monoNow) || monoNow < mono) cancel("invalid_deadline");
      else if (wallNow >= deadlineAt || monoNow >= monotonicLimit) cancel("deadline_exceeded");
      else if (caller?.aborted) cancel("aborted");
    }
    if (reason) throw new Failure(reason);
  };
  const onAbort = () => cancel("aborted");
  caller?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => cancel("deadline_exceeded"), Math.max(0, Math.min(deadlineAt - now, monotonicLimit - mono)));
  return { deadlineAt, signal: controller.signal, check, cancel,
    async wait<T>(operation: () => Promise<T>, failure: FailureReason): Promise<T> {
      check();
      // Invoke only after the synchronous cancellation check. Promise assimilation
      // also makes misbehaving thenables settle at most once.
      let promise: Promise<T>;
      try { promise = Promise.resolve(operation()); } catch { throw new Failure(failure); }
      const outcome = await Promise.race([
        promise.then(value => ({ kind: "value" as const, value }), () => ({ kind: "error" as const })),
        cancelled.then(value => ({ kind: "cancel" as const, value })),
      ]);
      check();
      if (outcome.kind === "cancel") throw new Failure(outcome.value);
      if (outcome.kind === "error") throw new Failure(failure);
      return outcome.value;
    },
    close() { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); },
  };
}

function aggregate(stages: readonly StageDiagnostic[], started: number, clock: Clock, reason: "verified" | FailureReason, segmentCount = 0, claimCount = 0) {
  const settled = stages.map(stage => ({ ...stage, ...(stage.usage ? { usage: { ...stage.usage } } : {}) }));
  const dispatched = settled.filter(stage => stage.dispatched);
  const known = dispatched.filter(stage => stage.usage);
  const subtotal = { input: 0, output: 0, thought: 0 };
  let safe = true;
  for (const stage of known) for (const key of ["input", "output", "thought"] as const) {
    subtotal[key] += stage.usage![key]; safe &&= Number.isSafeInteger(subtotal[key]);
  }
  // Even valid individual counters can overflow an aggregate; never invent a
  // rounded total. Coverage describes complete known stages, not an invoice.
  return deepFreeze({ ...labels, decision: reason === "verified" ? "pass" as const : "withhold" as const, reason,
    dispatchCount: dispatched.length, segmentCount, claimCount, elapsedMs: elapsed(started, clock.monotonic()), stages: settled,
    usage: { coverage: safe && known.length === dispatched.length && dispatched.length > 0 ? "complete" as const
      : safe && known.length > 0 ? "partial" as const : "unknown" as const,
      knownStages: safe ? known.length : 0, dispatchedStages: dispatched.length,
      knownSubtotal: safe ? subtotal : { input: 0, output: 0, thought: 0 } } });
}
export type SplitResult = ReturnType<typeof aggregate>;
export type SplitDependencies = Readonly<{ ledger: ReservationLedger; execute: StageExecutor; clock?: Clock; thinkingPolicy?: SplitThinkingPolicy;
  timingPolicy?: TrustedTimingPolicy;
  /** Trusted persistence hook after full semantic acceptance, before dependent stages dispatch. */
  onStagePassed?(request: StageRequest): Promise<void> }>;

/** No transport/provider factory, runtime imports, retries, retrieval or fallback.
 * The injected executor is a trusted offline adapter. Its binding object is
 * server-owned and must be returned by identity, outside model-authored JSON. */
export function createSplitVerifier(dependencies: SplitDependencies) {
  const clock = dependencies.clock ?? defaultClock, ledger = dependencies.ledger, execute = dependencies.execute;
  const timing = captureTrustedTimingPolicy(dependencies.timingPolicy), onStagePassed = dependencies.onStagePassed;
  const suppliedThinkingPolicy = dependencies.thinkingPolicy;
  const thinkingPolicy = suppliedThinkingPolicy === undefined ? "medium" : suppliedThinkingPolicy;
  return Object.freeze({ async verify(input: SplitRunInput, onCancellationDiagnostics?: (snapshot: SplitResult) => void): Promise<SplitResult> {
    const started = clock.monotonic();
    const stages: StageDiagnostic[] = STAGES.map(stage => ({ stage, status: "not_started", dispatched: false, elapsedMs: 0 }));
    const activeStages = new Map<Stage, number>(); let published = false;
    const publish = (snapshot: SplitResult) => {
      if (!published) { published = true; try { onCancellationDiagnostics?.(snapshot); } catch {} }
    };
    const prepared = prepareSplitInput(input);
    const suppliedDeadlineAt = input.deadlineAt;
    // Ordinary callers retain the original 85-second cap even when their terminal deadline is later.
    const deadlineAt = timing?.verificationMs === 85000 && Number.isSafeInteger(suppliedDeadlineAt)
      ? Math.min(suppliedDeadlineAt!, input.requestStartedAt + timing.verificationMs) : suppliedDeadlineAt;
    if (!prepared || !timing || (onStagePassed !== undefined && typeof onStagePassed !== "function") || (thinkingPolicy !== "medium" && thinkingPolicy !== "inventory_low")) return aggregate(stages, started, clock, "invalid_input");
    let budget: ReturnType<typeof createScope> | undefined;
    let claimCount = 0;
    try {
      budget = createScope(input, clock, timing.verificationMs, reason => {
        const cutoff = clock.monotonic();
        const snapshot = stages.map(stage => {
          const stageStarted = activeStages.get(stage.stage);
          return stageStarted === undefined ? stage : { ...stage, elapsedMs: elapsed(stageStarted, cutoff),
            status: stage.dispatched && stage.status === "reserved" ? "cancelled" as const : stage.status };
        });
        publish(aggregate(snapshot, started, { ...clock, monotonic: () => cutoff }, reason, prepared.segments.length, claimCount));
      }, deadlineAt); const scope = budget;
      scope.check();
      if (!await scope.wait(() => ledger.reserveCase(), "reservation_failed")) throw new Failure("reservation_failed");
      const requestId = randomUUID();
      async function run(stage: Stage, inventory?: Inventory): Promise<Inventory | Audit> {
        const diagnostic = stages[STAGES.indexOf(stage)], stageStarted = clock.monotonic();
        activeStages.set(stage, stageStarted);
        try {
          scope.check();
          const request = buildStageRequest(prepared!, stage, requestId, scope.deadlineAt, inventory, thinkingPolicy);
          if (!request) throw new Failure("invalid_input");
          if (!await scope.wait(() => ledger.reserveStage(stage), "reservation_failed")) throw new Failure("reservation_failed");
          diagnostic.status = "reserved";
          const output = await scope.wait(() => { diagnostic.dispatched = true; return execute(request, scope.signal); }, "provider_error");
          if (!output || typeof output !== "object" || Array.isArray(output)) throw new Failure("invalid_response");
          const value = output as Record<string, unknown>;
          if (value.binding !== request.binding || Object.keys(value).some(key => !["binding", "status", "json", "usage"].includes(key))) throw new Failure("invalid_response");
          const usage = usageSchema.safeParse(value.usage);
          if (usage.success) diagnostic.usage = usage.data;
          if (value.status !== "completed" || typeof value.json !== "string") throw new Failure("invalid_response");
          const checked = stage === "inventory" ? validateInventory(value.json, prepared!) : validateAudit(stage, value.json, prepared!, inventory!);
          if (!checked) throw new Failure("invalid_response");
          if (checked.decision !== "pass") throw new Failure("stage_rejected");
          if (onStagePassed) await scope.wait(() => onStagePassed(request), "reservation_failed");
          diagnostic.status = "passed";
          return checked;
        } catch (error) {
          const reason = error instanceof Failure ? error.reason : "invalid_response";
          diagnostic.status = scope.signal.aborted ? "cancelled" : "withheld";
          scope.cancel(reason);
          throw new Failure(reason);
        } finally { diagnostic.elapsedMs = elapsed(stageStarted, clock.monotonic()); activeStages.delete(stage); }
      }
      const inventory = await run("inventory") as Inventory;
      claimCount = inventory.segments.reduce((n, s) => n + s.claims.length, 0);
      // AllSettled guarantees sibling bookkeeping is complete before the immutable
      // aggregate is made, while each wait remains cancellation/deadline bounded.
      const audited = await Promise.allSettled([run("consent", inventory), run("overtime", inventory)]);
      for (const result of audited) if (result.status === "rejected") throw result.reason;
      scope.check();
      const consent = (audited[0] as PromiseFulfilledResult<ConsentAudit>).value;
      const overtime = (audited[1] as PromiseFulfilledResult<OvertimeAudit>).value;
      const verdict = joinSplitVerdict(prepared, inventory, consent, overtime);
      if (!verdict || verdict.decision !== "pass") throw new Failure("stage_rejected");
      scope.check();
      return aggregate(stages, started, clock, "verified", verdict.segmentCount, verdict.claimCount);
    } catch (error) {
      const reason = error instanceof Failure ? error.reason : "invalid_input";
      budget?.cancel(reason);
      return aggregate(stages, started, clock, reason, prepared.segments.length, claimCount);
    } finally { budget?.close(); }
  } });
}

export type CompletionSnapshot = Readonly<{ question: string; facts?: string; candidate: string; evidence: PreparedSplitInput["input"]["evidence"];
  candidateSha256: string; sourceSnapshotSha256: string; deadlineAt: number; signal: AbortSignal }>;
export type CompletionDependencies = SplitDependencies & Readonly<{
  /** Trusted authority dependency must check the exact edition/source snapshot. */
  authority(snapshot: CompletionSnapshot): Promise<unknown>;
  /** One real atomic transaction belongs to the caller. Tests inject a fake; this
   * module implements neither persistence nor a simulated production transaction. */
  commit(snapshot: CompletionSnapshot): Promise<unknown>;
}>;
const authorizedSchema = z.strictObject({ authorized: z.literal(true), sourceSnapshotSha256: z.string() });
const savedSchema = z.strictObject({ saved: z.literal(true), candidateSha256: z.string(), sourceSnapshotSha256: z.string() });
type CompletionResult = Readonly<typeof labels & { status: "saved" | "withhold"; reason: "saved" | FailureReason;
  commitDispatched: boolean; verification?: SplitResult }>;

/** Request-scoped offline completion only. Duplicate calls may reuse one result;
 * mismatched snapshots/timing/signals never inherit a previous pass. */
export function createOfflineCompletion(dependencies: CompletionDependencies) {
  const clock = dependencies.clock ?? defaultClock;
  let firstKey: string | undefined, firstSignal: AbortSignal | undefined, once: Promise<CompletionResult> | undefined;
  const withhold = (reason: FailureReason, commitDispatched = false, verification?: SplitResult): CompletionResult =>
    deepFreeze({ ...labels, status: "withhold", reason, commitDispatched, ...(verification ? { verification } : {}) });
  async function completePrepared(prepared: PreparedSplitInput, input: SplitRunInput): Promise<CompletionResult> {
    let scope: ReturnType<typeof createScope> | undefined, terminal: ReturnType<typeof createScope> | undefined;
    let verification: SplitResult | undefined, commitDispatched = false;
    try {
      scope = createScope(input, clock, 85000); const budget = scope;
      budget.check();
      const snapshot: CompletionSnapshot = Object.freeze({ ...prepared.input, candidateSha256: prepared.candidateSha256,
        sourceSnapshotSha256: prepared.sourceSnapshotSha256, signal: budget.signal, deadlineAt: budget.deadlineAt });
      const before = authorizedSchema.safeParse(await budget.wait(() => dependencies.authority(snapshot), "authority_unavailable"));
      if (!before.success || before.data.sourceSnapshotSha256 !== prepared.sourceSnapshotSha256) throw new Failure("authority_unavailable");
      verification = await budget.wait(() => createSplitVerifier({ ...dependencies, timingPolicy: "standard" }).verify({ ...prepared.input,
        requestStartedAt: input.requestStartedAt, requestStartedMonotonic: input.requestStartedMonotonic, signal: budget.signal }), "stage_rejected");
      if (verification.decision !== "pass") throw new Failure(verification.reason === "verified" ? "stage_rejected" : verification.reason);
      const after = authorizedSchema.safeParse(await budget.wait(() => dependencies.authority(snapshot), "authority_changed"));
      if (!after.success || after.data.sourceSnapshotSha256 !== prepared.sourceSnapshotSha256) throw new Failure("authority_changed");
      budget.check();
      terminal = createScope(input, clock, 110000);
      const commitSnapshot: CompletionSnapshot = Object.freeze({ ...snapshot, signal: terminal.signal, deadlineAt: terminal.deadlineAt });
      budget.close();
      const receipt = savedSchema.safeParse(await terminal.wait(() => {
        commitDispatched = true;
        return dependencies.commit(commitSnapshot);
      }, "commit_failed"));
      if (!receipt.success || receipt.data.candidateSha256 !== prepared.candidateSha256 || receipt.data.sourceSnapshotSha256 !== prepared.sourceSnapshotSha256) throw new Failure("commit_failed");
      return deepFreeze({ ...labels, status: "saved", reason: "saved", commitDispatched, verification });
    } catch (error) {
      const reason = error instanceof Failure ? error.reason : "invalid_input";
      scope?.cancel(reason);
      terminal?.cancel(reason);
      return withhold(reason, commitDispatched, verification);
    } finally { scope?.close(); terminal?.close(); }
  }
  return Object.freeze({ complete(input: SplitRunInput): Promise<CompletionResult> {
    const prepared = prepareSplitInput(input);
    if (!prepared) return Promise.resolve(withhold("invalid_input"));
    const timing = { requestStartedAt: input.requestStartedAt, requestStartedMonotonic: input.requestStartedMonotonic, signal: input.signal };
    const key = JSON.stringify([prepared.contextSha256, timing.requestStartedAt, timing.requestStartedMonotonic]);
    if (once) return key === firstKey && timing.signal === firstSignal ? once : Promise.resolve(withhold("request_mismatch"));
    firstKey = key; firstSignal = timing.signal;
    once = completePrepared(prepared, { ...prepared.input, ...timing });
    return once;
  } });
}
