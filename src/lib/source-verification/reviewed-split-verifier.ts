import { z } from "zod";
import { createSplitVerifier, type Clock, type SplitResult, type SplitRunInput, type StageExecutor } from "./split-verification/runner";
import { deepFreeze, prepareSplitInput, STAGES, type Stage, type StageRequest, type SplitThinkingPolicy } from "./split-verification/contracts";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "./trusted-timing-policy";

export type ReviewedSplitRunInput = SplitRunInput;
export type ReviewedSplitVerifier = Readonly<{ kind: "split";
  verify(input: ReviewedSplitRunInput, onCancellationDiagnostics?: (snapshot: ReviewedSplitDiagnostics) => void): Promise<SplitResult> }>;
export type ReviewedSplitDependencies = Readonly<{ createExecutor(input: SplitRunInput): StageExecutor; clock?: Clock; thinkingPolicy?: SplitThinkingPolicy;
  timingPolicy?: TrustedTimingPolicy; onStagePassed?(request: StageRequest): Promise<void> }>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.strictObject({ input: count, output: count, thought: count });
const reasons = ["verified", "invalid_input", "invalid_deadline", "aborted", "deadline_exceeded", "reservation_failed", "provider_error",
  "invalid_response", "stage_rejected", "authority_unavailable", "authority_changed", "commit_failed", "request_mismatch"] as const;
const resultSchema = z.strictObject({ purpose: z.literal("offline_split_verification_v1"), productionEligible: z.literal(false),
  runtimeEnabled: z.literal(false), experimental: z.literal(true), decision: z.enum(["pass", "withhold"]), reason: z.enum(reasons),
  dispatchCount: count.max(3), segmentCount: count.max(64), claimCount: count.max(64), elapsedMs: count,
  stages: z.array(z.strictObject({ stage: z.enum(STAGES), status: z.enum(["not_started", "reserved", "passed", "withheld", "cancelled"]),
    dispatched: z.boolean(), elapsedMs: count, usage: usageSchema.optional() })).length(3),
  usage: z.strictObject({ coverage: z.enum(["complete", "partial", "unknown"]), knownStages: count.max(3), dispatchedStages: count.max(3), knownSubtotal: usageSchema }) });
export type ReviewedSplitDiagnostics = Readonly<{ kind: "split"; decision: SplitResult["decision"]; reason: SplitResult["reason"];
  /** Executor invocation counts do not establish native dispatch or provider acceptance. */
  executorInvocations: number; elapsedMs: number; stages: SplitResult["stages"]; usage: SplitResult["usage"] }>;
const diagnosticsSchema = z.strictObject({ kind: z.literal("split"), decision: resultSchema.shape.decision, reason: resultSchema.shape.reason,
  executorInvocations: count.max(3), elapsedMs: count, stages: resultSchema.shape.stages, usage: resultSchema.shape.usage });

/** Content-free, closed diagnostics; no result text, errors, source IDs or request IDs. */
export function projectReviewedSplitDiagnostics(value: unknown): ReviewedSplitDiagnostics | undefined {
  try {
    const projected = diagnosticsSchema.safeParse(value);
    if (projected.success) return deepFreeze(projected.data);
    const result = resultSchema.safeParse(value); if (!result.success) return;
    const data = result.data;
    return deepFreeze({ kind: "split", decision: data.decision, reason: data.reason, executorInvocations: data.dispatchCount,
      elapsedMs: data.elapsedMs, stages: data.stages, usage: data.usage });
  } catch { return; }
}

/** Check the complete split pass independently of the monolithic verifier's contract. */
export function reviewedSplitPass(value: unknown): Readonly<{ segmentCount: number; claimCount: number }> | undefined {
  const parsed = resultSchema.safeParse(value); if (!parsed.success) return;
  const result = parsed.data;
  if (result.decision !== "pass" || result.reason !== "verified" || result.dispatchCount !== 3 || result.segmentCount < 1
    || result.claimCount < result.segmentCount || result.usage.coverage !== "complete" || result.usage.knownStages !== 3
    || result.usage.dispatchedStages !== 3 || result.stages.some((stage, index) => stage.stage !== STAGES[index]
      || stage.status !== "passed" || !stage.dispatched || !stage.usage)) return;
  for (const key of ["input", "output", "thought"] as const) {
    const total = result.stages.reduce((sum, stage) => sum + stage.usage![key], 0);
    if (!Number.isSafeInteger(total) || total !== result.usage.knownSubtotal[key]) return;
  }
  return Object.freeze({ segmentCount: result.segmentCount, claimCount: result.claimCount });
}

/** One request-owned admission and three stage reservations. No campaign, filesystem,
 * source catalogue, transport creation or credential discovery is performed here. */
export function createReviewedSplitVerifier(dependencies: ReviewedSplitDependencies): ReviewedSplitVerifier {
  const clock = dependencies.clock ?? { wall: Date.now, monotonic: () => performance.now() };
  const suppliedTimingPolicy = dependencies.timingPolicy;
  const timing = captureTrustedTimingPolicy(suppliedTimingPolicy), onStagePassed = dependencies.onStagePassed;
  const timingPolicy = suppliedTimingPolicy === undefined ? "standard" : suppliedTimingPolicy;
  const suppliedThinkingPolicy = dependencies.thinkingPolicy;
  const thinkingPolicy = suppliedThinkingPolicy === undefined ? "medium" : suppliedThinkingPolicy;
  let used = false, reserved = false;
  const stages = new Set<Stage>();
  return Object.freeze({ kind: "split" as const, async verify(input: ReviewedSplitRunInput,
    onCancellationDiagnostics?: (snapshot: ReviewedSplitDiagnostics) => void): Promise<SplitResult> {
    const first = !used; used = true;
    const { requestStartedAt, requestStartedMonotonic, signal, deadlineAt } = input;
    const prepared = prepareSplitInput(input);
    const snapshot = Object.freeze({ ...(prepared?.input ?? input), requestStartedAt, requestStartedMonotonic, signal,
      ...(deadlineAt === undefined ? {} : { deadlineAt }) });
    const controller = new AbortController();
    const duration = Math.min(timing?.verificationMs ?? 0, deadlineAt === undefined ? timing?.verificationMs ?? 0 : deadlineAt - requestStartedAt);
    const enteredWall = clock.wall(), enteredMono = clock.monotonic();
    const monotonicLimit = enteredMono + Math.min(requestStartedAt + duration - enteredWall, duration - (enteredMono - requestStartedMonotonic));
    const remaining = () => Math.min(requestStartedAt + duration - clock.wall(), monotonicLimit - clock.monotonic());
    const validTiming = !!timing && Number.isSafeInteger(requestStartedAt) && requestStartedAt >= 0 && Number.isFinite(requestStartedMonotonic)
      && requestStartedMonotonic >= 0 && requestStartedAt <= clock.wall() && requestStartedMonotonic <= clock.monotonic()
      && Number.isFinite(enteredWall) && Number.isFinite(enteredMono) && Number.isFinite(duration) && duration > 0
      && (deadlineAt === undefined || (Number.isSafeInteger(deadlineAt) && (timing.verificationMs === 85000 || deadlineAt - requestStartedAt <= timing.verificationMs)));
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted || !validTiming || remaining() <= 0) cancel();
    const timer = validTiming && !controller.signal.aborted ? setTimeout(cancel, Math.max(0, remaining())) : undefined;
    let execute: StageExecutor | undefined;
    const check = () => { if (controller.signal.aborted || !validTiming || remaining() <= 0) { cancel(); throw new Error("split_request_stopped"); } };
    const ledger = {
      async reserveCase() { if (!first || reserved) return false; reserved = true; return true; },
      async reserveStage(stage: Stage) { if (!first || !reserved || !STAGES.includes(stage) || stages.has(stage)) return false; stages.add(stage); return true; },
    };
    try {
      const result = await createSplitVerifier({ ledger, clock, thinkingPolicy, timingPolicy, onStagePassed, execute: async (request, stageSignal) => {
        check();
        execute ??= dependencies.createExecutor(Object.freeze({ ...snapshot, signal: controller.signal }));
        check();
        // Carry the earlier cutoff through preparation to the transport's final dispatch check.
        // Preserve the kernel binding object; only the request's available time is reduced.
        const response = await execute(Object.freeze({ ...request, deadlineAt: Math.min(request.deadlineAt, requestStartedAt + duration) }), stageSignal);
        check();
        return response;
      } }).verify({ ...snapshot, signal: controller.signal }, value => {
        const diagnostic = projectReviewedSplitDiagnostics(value);
        if (diagnostic) try { onCancellationDiagnostics?.(diagnostic); } catch {}
      });
      const expired = remaining() <= 0;
      if (result.decision === "pass" && (expired || controller.signal.aborted)) {
        return deepFreeze({ ...result, decision: "withhold", reason: expired ? "deadline_exceeded" : "aborted" });
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel); controller.abort();
    }
  } });
}
