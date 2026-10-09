import type { Interactions } from "@google/genai";
import { EVALUATION_LIMITS } from "./evidence";
import { buildEvaluationVerifierInput, validateEvaluationVerdict,
  type EvaluationDecision, type EvaluationVerifierInput, type VerifierInputInvalidReason } from "./verdict";

/** Structurally accepts GoogleGenAI without constructing a client or reading credentials. */
export type GeminiEvaluationClient = Readonly<{ interactions: {
  create(params: Interactions.CreateModelInteractionParamsNonStreaming & { stream: false },
    options: { maxRetries: 0; signal: AbortSignal; timeout: number }): Promise<Interactions.Interaction>;
} }>;
export type EvaluationRunReason = EvaluationDecision["reason"] | VerifierInputInvalidReason
  | "invalid_deadline" | "deadline_exceeded" | "aborted" | "provider_error" | "invalid_response" | "incomplete_response";
export type EvaluationProviderUsage = Readonly<Partial<Record<
  "total_input_tokens" | "total_output_tokens" | "total_thought_tokens" | "total_cached_tokens" | "total_tokens" | "total_tool_use_tokens", number>>>;
export type EvaluationResponseStatus = "completed" | "in_progress" | "requires_action" | "failed" | "cancelled"
  | "incomplete" | "budget_exceeded" | "queued" | "missing" | "unknown";
/** Normalize one snapshotted status primitive; never retain arbitrary provider strings. */
export function normalizeEvaluationResponseStatus(value: unknown): EvaluationResponseStatus {
  switch (value) {
    case "completed": return "completed";
    case "in_progress": return "in_progress";
    case "requires_action": return "requires_action";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "incomplete": return "incomplete";
    case "budget_exceeded": return "budget_exceeded";
    case "queued": return "queued";
    case undefined: return "missing";
    default: return "unknown";
  }
}
export type EvaluationRunResult = Readonly<{
  purpose: "offline_evaluation"; productionEligible: false; decision: "pass" | "withhold";
  reason: EvaluationRunReason;
  /** True only for structurally complete verified/unsupported_claim verdicts. */
  evaluated: boolean; attemptCount: 0 | 1; segmentCount: number; claimCount: number;
  timingMs: Readonly<{ preparation: number; provider: number; validation: number; total: number }>;
  /** Reported counters only; absence is unknown, never zero or a billing estimate. */
  usage?: EvaluationProviderUsage;
  /** Present only after a response arrived; not a finish reason or token-limit diagnosis. */
  responseStatus?: EvaluationResponseStatus;
}>;
export type EvaluationRunInput = EvaluationVerifierInput & Readonly<{ deadlineAt: number; signal?: AbortSignal }>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const duration = (start: number, end: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(end - start)));
function readUsage(value: unknown): EvaluationProviderUsage | undefined {
  if (!object(value)) return;
  const usage: Partial<Record<keyof EvaluationProviderUsage, number>> = {};
  const keys = ["total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_cached_tokens", "total_tokens", "total_tool_use_tokens"] as const;
  for (const key of keys) {
    const count = value[key];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return;
    usage[key] = count;
  }
  return Object.keys(usage).length ? Object.freeze(usage) : undefined;
}

/** Parse actual non-streaming steps, never SDK output_text or legacy outputs. */
function verdictText(response: unknown, status: unknown): { text: string } | { reason: EvaluationRunReason } {
  if (!object(response)) return { reason: "invalid_response" };
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) return { reason: "provider_error" };
  if (status !== "completed") return { reason: "incomplete_response" };
  if (!Array.isArray(response.steps) || !response.steps.length) return { reason: "invalid_response" };
  if (response.steps.length > 128) return { reason: "limit_exceeded" };
  let text: string | undefined;
  for (const step of response.steps) {
    if (!object(step)) return { reason: "invalid_response" };
    if (step.error !== undefined) return { reason: "provider_error" };
    if (step.type === "thought") {
      // Thought has optional signature/summary, not model_output.content. Never copy these.
      if ((step.signature !== undefined && typeof step.signature !== "string")
        || (step.summary !== undefined && !Array.isArray(step.summary))) return { reason: "invalid_response" };
      continue;
    }
    if (step.type === "user_input") {
      if (step.content !== undefined && !Array.isArray(step.content)) return { reason: "invalid_response" };
      continue;
    }
    // Every tool call/result (including processing) and unknown future step fails closed.
    if (step.type !== "model_output" || text !== undefined || !Array.isArray(step.content) || step.content.length !== 1) return { reason: "invalid_response" };
    const part: unknown = step.content[0];
    if (!object(part) || part.type !== "text" || typeof part.text !== "string") return { reason: "invalid_response" };
    if (part.text.length > EVALUATION_LIMITS.maxResponseJsonBytes || Buffer.byteLength(part.text, "utf8") > EVALUATION_LIMITS.maxResponseJsonBytes) return { reason: "limit_exceeded" };
    text = part.text;
  }
  return text === undefined ? { reason: "invalid_response" } : { text };
}

/** Single evaluation-only generation. No tools, persistence, retries, logs, or fresh deadline. */
export function createGeminiEvaluationVerifier(client: GeminiEvaluationClient) {
  return Object.freeze({ async evaluate(input: EvaluationRunInput): Promise<EvaluationRunResult> {
    const startedAt = Date.now();
    // Capture the caller's original deadline once, before any input preparation.
    const deadlineAt = input.deadlineAt, callerSignal = input.signal;
    let preparation = 0, provider = 0, validation = 0, segmentCount = 0, claimCount = 0;
    let attemptCount: 0 | 1 = 0, usage: EvaluationProviderUsage | undefined;
    let responseStatus: EvaluationResponseStatus | undefined;
    let providerStartedAt: number | undefined, validationStartedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCallerAbort: (() => void) | undefined;
    const controller = new AbortController();
    const stopped = (): "deadline_exceeded" | "aborted" | undefined =>
      Date.now() >= deadlineAt ? "deadline_exceeded" : callerSignal?.aborted ? "aborted" : undefined;
    const finish = (reason: EvaluationRunReason): EvaluationRunResult => {
      const now = Date.now();
      if (validationStartedAt !== undefined) validation = duration(validationStartedAt, now);
      else if (providerStartedAt !== undefined) provider = duration(providerStartedAt, now);
      else preparation = duration(startedAt, now);
      return Object.freeze({ purpose: "offline_evaluation", productionEligible: false,
        decision: reason === "verified" ? "pass" : "withhold", reason,
        evaluated: reason === "verified" || reason === "unsupported_claim", attemptCount, segmentCount, claimCount,
        timingMs: Object.freeze({ preparation, provider, validation, total: duration(startedAt, now) }),
        ...(usage === undefined ? {} : { usage }),
        ...(responseStatus === undefined ? {} : { responseStatus }) });
    };
    try {
      if (!Number.isSafeInteger(deadlineAt)) return finish("invalid_deadline");
      const before = stopped(); if (before) return finish(before);
      const prepared = buildEvaluationVerifierInput(input);
      const afterPreparation = stopped(); if (afterPreparation) return finish(afterPreparation);
      if (prepared.status !== "ready") return finish(prepared.reason);
      segmentCount = prepared.segments.length;
      const request: Interactions.CreateModelInteractionParamsNonStreaming & { stream: false } = {
        model: "gemini-3.8-flash", input: prepared.prompt, system_instruction: prepared.systemInstruction,
        tools: [], store: false, stream: false,
        generation_config: { thinking_level: "medium", thinking_summaries: "none", tool_choice: "none", max_output_tokens: EVALUATION_LIMITS.maxOutputTokens },
        response_format: { type: "text", mime_type: "application/json", schema: prepared.verdictSchema },
      };
      // Prepared strings are already <=128 KiB combined. Bound the entire SDK JSON
      // envelope again, including nested escaping, schema and generation configuration.
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > EVALUATION_LIMITS.maxSerializedInputBytes) return finish("limit_exceeded");
      const beforeCall = stopped(); if (beforeCall) return finish(beforeCall);
      preparation = duration(startedAt, Date.now());
      const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
        const cancel = () => { resolve({ kind: "cancelled" }); controller.abort(); };
        onCallerAbort = cancel;
        callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
        const arm = () => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) { cancel(); return; }
          // Avoid Node's timeout overflow; rearm against the SAME absolute deadline.
          timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
        };
        arm();
        if (callerSignal?.aborted) cancel();
      });
      const beforeDispatch = stopped(); if (beforeDispatch) return finish(beforeDispatch);
      providerStartedAt = Date.now();
      const remaining = deadlineAt - providerStartedAt;
      if (remaining <= 0) return finish("deadline_exceeded");
      attemptCount = 1;
      // The race releases our waiter even when the injected provider ignores abort.
      // Both branches handle settlement, so a late provider rejection is consumed.
      const pending = client.interactions.create(request, { maxRetries: 0, signal: controller.signal, timeout: remaining })
        .then((value) => ({ kind: "response" as const, value }), () => ({ kind: "error" as const }));
      const settled = await Promise.race([pending, cancelled]);
      provider = duration(providerStartedAt, Date.now());
      // Snapshot once before a deadline can withhold an already-arrived response.
      // Validation still requires the exact original completed status.
      const rawStatus = settled.kind === "response" && object(settled.value) ? settled.value.status : undefined;
      if (settled.kind === "response") responseStatus = normalizeEvaluationResponseStatus(rawStatus);
      const afterAwait = stopped(); if (afterAwait) return finish(afterAwait);
      if (settled.kind === "cancelled") return finish("aborted");
      if (settled.kind === "error") return finish("provider_error");
      validationStartedAt = Date.now();
      usage = object(settled.value) ? readUsage(settled.value.usage) : undefined;
      const parsed = verdictText(settled.value, rawStatus);
      let reason: EvaluationRunReason;
      if ("reason" in parsed) reason = parsed.reason;
      else {
        const decision = validateEvaluationVerdict(parsed.text, prepared.segments, input.evidence);
        claimCount = decision.claimCount; reason = decision.reason;
      }
      return finish(stopped() ?? reason);
    } catch {
      return finish(stopped() ?? (attemptCount ? "provider_error" : "invalid_input"));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onCallerAbort) callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  } });
}
