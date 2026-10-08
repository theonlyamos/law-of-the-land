import { createHash } from "node:crypto";
import { z } from "zod";
import { EVALUATION_LIMITS, resolveEvaluationEvidence, type EvaluationEvidence,
  type EvaluationEvidenceRequest, type EvaluationRegistry, type SourceIdentity } from "./evidence";
import { buildEvaluationVerifierInput } from "./verdict";
import type { EvaluationRunInput } from "./gemini-verifier";
import { reviewedSplitPass, type ReviewedSplitRunInput } from "./reviewed-split-verifier";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "./trusted-timing-policy";

export type ChatVerificationInput = Readonly<{ kind: "policy" | "document" }> | Readonly<{
  kind: "legal"; question: string; facts?: string; candidate: string;
  requests: readonly EvaluationEvidenceRequest[];
  requestStartedAt: number; requestStartedMonotonic?: number; deadlineAt: number; signal?: AbortSignal;
}>;
export type ChatVerificationAuthority = Readonly<{ status: "unavailable" }> | Readonly<{
  status: "authorized"; identities: readonly SourceIdentity[];
}>;
export type ChatVerificationDependencies = Readonly<{
  timingPolicy?: TrustedTimingPolicy;
  registry: EvaluationRegistry;
  /** Trusted request-scoped server authority: authenticated access, selected jurisdiction,
   * current published version, and applicability. Deny future/revoked/unavailable sources.
   * A registry match or caller assertion is NOT authorization. Called again before pass. */
  resolveAuthority(input: Readonly<{ sources: readonly Readonly<{ sourceId: string; versionId: string }>[];
    deadlineAt: number; signal: AbortSignal }>): Promise<ChatVerificationAuthority>;
  /** Explicit single- or split-verifier contracts; neither accepts a batch campaign. */
  verifier: Readonly<{ evaluate(input: EvaluationRunInput): Promise<unknown> }>
    | Readonly<{ kind: "split"; verify(input: ReviewedSplitRunInput): Promise<unknown> }>;
}>;
type WithholdReason = "gate_disabled" | "invalid_input" | "invalid_deadline" | "deadline_exceeded" | "aborted"
  | "authority_unavailable" | "authority_changed" | "evidence_unavailable" | "evidence_changed"
  | "verification_unavailable" | "verification_rejected";
type Labels = Readonly<{ purpose: "local_chat_verification"; productionEligible: false }>;
export type ChatVerificationResult = Labels & (
  | Readonly<{ status: "not_applicable"; reason: "policy" | "document" }>
  | Readonly<{ status: "withhold"; reason: WithholdReason }>
  | Readonly<{ status: "pass"; reason: "verified"; reviewKind: "agent_reviewed_experimental";
    candidateSha256: string; passageCount: number; segmentCount: number; claimCount: number }>);

const labels = { purpose: "local_chat_verification", productionEligible: false } as const;
const withhold = (reason: WithholdReason): ChatVerificationResult => Object.freeze({ ...labels, status: "withhold", reason });
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.strictObject({ sourceId: id, versionId: id, originalSha256: digest,
  originalByteLength: count.positive(), pdfPageCount: count.positive(), derivativeRecipeSha256: digest });
const authoritySchema = z.strictObject({ status: z.literal("authorized"),
  identities: z.array(identitySchema).min(1).max(EVALUATION_LIMITS.maxSourceVersions) });
const contentSchema = z.object({ question: z.string().max(EVALUATION_LIMITS.maxQuestionFactsDraftBytes),
  facts: z.string().max(EVALUATION_LIMITS.maxQuestionFactsDraftBytes).optional(),
  candidate: z.string().max(EVALUATION_LIMITS.maxQuestionFactsDraftBytes),
  requests: z.array(z.strictObject({ sourceId: id, versionId: id, pdfOrdinal: count.positive().optional(),
    reviewedSpanId: id.optional(), exactAnchor: z.string().min(1).max(EVALUATION_LIMITS.maxEvidenceTextBytes).optional() })).min(1).max(64),
  requestStartedAt: count, requestStartedMonotonic: z.number().finite().nonnegative().optional(), deadlineAt: count });
// Validate only the complete pass shape; never forward arbitrary callback fields/reasons.
const passSchema = z.strictObject({ purpose: z.literal("offline_evaluation"), productionEligible: z.literal(false),
  decision: z.literal("pass"), reason: z.literal("verified"), evaluated: z.literal(true), attemptCount: z.literal(1),
  responseStatus: z.literal("completed").optional(),
  segmentCount: count.positive().max(EVALUATION_LIMITS.maxSegments), claimCount: count.positive().max(EVALUATION_LIMITS.maxClaims),
  timingMs: z.strictObject({ preparation: count, provider: count, validation: count, total: count }),
  usage: z.strictObject({ total_input_tokens: count.optional(), total_output_tokens: count.optional(),
    total_thought_tokens: count.optional(), total_cached_tokens: count.optional(), total_tokens: count.optional(),
    total_tool_use_tokens: count.optional() }).optional() });
const identityFields = ["sourceId", "versionId", "originalSha256", "originalByteLength", "pdfPageCount", "derivativeRecipeSha256"] as const;
function authorityMatches(identities: readonly SourceIdentity[], evidence: EvaluationEvidence,
  requests: readonly EvaluationEvidenceRequest[]): boolean {
  const granted = new Map(identities.map((identity) => [identity.sourceId, identity]));
  const requested = new Set(requests.map((request) => request.sourceId));
  return granted.size === identities.length && granted.size === requested.size
    && requests.every((request) => granted.get(request.sourceId)?.versionId === request.versionId)
    && evidence.passages.every((passage) => {
      const identity = granted.get(passage.sourceId);
      return identity !== undefined && identityFields.every((field) => identity[field] === passage[field]);
    });
}

/** Bounded LOCAL integration seam, deliberately not wired into the live handler.
 * Call after canonical draft/citation validation and before governed completion/first delta.
 * Bind a pass to the exact candidate SHA; retain final auth, billing and citation checks.
 * `kind` is trusted server classification: mixed/legal requests stay legal; documents and
 * attachments are never registered as law merely because this gate is not applicable.
 * No dependencies means legal answers withhold. No credential, transport or client factory.
 * Agent review and a model verdict are experimental, not human review or legal correctness.
 */
export function createChatVerificationGate(dependencies?: ChatVerificationDependencies) {
  const timing = captureTrustedTimingPolicy(dependencies?.timingPolicy);
  const registry = dependencies?.registry, resolveAuthority = dependencies?.resolveAuthority;
  const verifier = dependencies?.verifier;
  const split = verifier && "kind" in verifier && verifier.kind === "split" ? verifier : undefined;
  const evaluate = verifier && !split && "evaluate" in verifier && typeof verifier.evaluate === "function" ? verifier.evaluate.bind(verifier) : undefined;
  const verifySplit = typeof split?.verify === "function" ? split.verify.bind(split) : undefined;
  return Object.freeze({ async verify(input: ChatVerificationInput): Promise<ChatVerificationResult> {
    if (!timing) return withhold("invalid_input");
    if (input?.kind === "policy" || input?.kind === "document") {
      return Object.freeze({ ...labels, status: "not_applicable", reason: input.kind });
    }
    if (input?.kind !== "legal") return withhold("invalid_input");
    if (!registry || typeof resolveAuthority !== "function" || (!evaluate && !verifySplit)) return withhold("gate_disabled");
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    const callerSignal = input.signal, controller = new AbortController();
    let failure: WithholdReason = "invalid_input";
    // Capture deadline and every private text/locator before the first asynchronous call.
    const parsed = contentSchema.safeParse(input);
    if (!parsed.success) return withhold("invalid_input");
    const { question, facts, candidate, requestStartedAt, requestStartedMonotonic, deadlineAt } = parsed.data;
    const requests = Object.freeze(parsed.data.requests.map((request) => Object.freeze(request)));
    if (requestStartedAt > Date.now() || deadlineAt <= requestStartedAt || deadlineAt - requestStartedAt > (split ? timing.verificationMs : timing.gateMs)
      || (split && (requestStartedMonotonic === undefined || requestStartedMonotonic > performance.now()))) return withhold("invalid_deadline");
    const admittedWall = Date.now(), admittedMono = performance.now();
    const monotonicLimit = admittedMono + Math.min(deadlineAt - admittedWall, split
      ? deadlineAt - requestStartedAt - (admittedMono - requestStartedMonotonic!) : Infinity);
    const remaining = () => Math.min(deadlineAt - Date.now(), split || timing.verificationMs === 240000
      ? monotonicLimit - performance.now() : Infinity);
    const stopped = (): "deadline_exceeded" | "aborted" | undefined => remaining() <= 0
      ? "deadline_exceeded" : callerSignal?.aborted || controller.signal.aborted ? "aborted" : undefined;
    const before = stopped(); if (before) return withhold(before);
    const sources = Object.freeze([...new Map(requests.map(({ sourceId, versionId }) => [sourceId, Object.freeze({ sourceId, versionId })])).values()]);
    const authorityInput = Object.freeze({ sources, deadlineAt, signal: controller.signal });
    try {
      const cancelled = new Promise<ChatVerificationResult>((resolve) => {
        const cancel = () => { resolve(withhold(stopped() ?? "aborted")); controller.abort(); };
        onAbort = cancel; callerSignal?.addEventListener("abort", cancel, { once: true });
        // Always from the caller's original absolute deadline; no per-stage reset.
        timer = setTimeout(cancel, Math.max(0, remaining()));
        if (callerSignal?.aborted) cancel();
      });
      const work = async (): Promise<ChatVerificationResult> => {
        try {
          let stop = stopped(); if (stop) return withhold(stop);
          failure = "authority_unavailable";
          const grant = authoritySchema.safeParse(await resolveAuthority(authorityInput));
          stop = stopped(); if (stop) return withhold(stop);
          if (!grant.success) return withhold("authority_unavailable");
          failure = "evidence_unavailable";
          const resolved = resolveEvaluationEvidence(registry, requests);
          if (resolved.status !== "resolved" || resolved.evidence.passages.some((passage) =>
            passage.sourceKind !== "authorized_local_original" || passage.review.kind !== "agent_reviewed_experimental")) return withhold("evidence_unavailable");
          const evidence = resolved.evidence;
          if (!authorityMatches(grant.data.identities, evidence, requests)) return withhold("authority_unavailable");
          const evaluationInput = Object.freeze({ question, ...(facts === undefined ? {} : { facts }), candidate, evidence,
            deadlineAt, signal: controller.signal });
          const prepared = buildEvaluationVerifierInput(evaluationInput);
          stop = stopped(); if (stop) return withhold(stop);
          if (prepared.status !== "ready") return withhold("invalid_input");
          const evidenceSha256 = hash(JSON.stringify(evidence)), candidateSha256 = hash(candidate);
          failure = "verification_unavailable";
          stop = stopped(); if (stop) return withhold(stop);
          const raw = verifySplit ? await verifySplit({ ...evaluationInput, requestStartedAt, requestStartedMonotonic: requestStartedMonotonic! })
            : await evaluate!(evaluationInput);
          const single = verifySplit ? undefined : passSchema.safeParse(raw);
          const verdict = verifySplit ? reviewedSplitPass(raw) : single?.success ? single.data : undefined;
          stop = stopped(); if (stop) return withhold(stop);
          if (!verdict || verdict.segmentCount !== prepared.segments.length
            || verdict.claimCount < verdict.segmentCount) return withhold("verification_rejected");
          failure = "authority_changed";
          const current = authoritySchema.safeParse(await resolveAuthority(authorityInput));
          stop = stopped(); if (stop) return withhold(stop);
          if (!current.success || !authorityMatches(current.data.identities, evidence, requests)) return withhold("authority_changed");
          failure = "evidence_changed";
          const checked = resolveEvaluationEvidence(registry, requests);
          if (checked.status !== "resolved" || hash(JSON.stringify(checked.evidence)) !== evidenceSha256) return withhold("evidence_changed");
          stop = stopped(); if (stop) return withhold(stop);
          return Object.freeze({ ...labels, status: "pass", reason: "verified", reviewKind: "agent_reviewed_experimental",
            candidateSha256, passageCount: evidence.passages.length,
            segmentCount: verdict.segmentCount, claimCount: verdict.claimCount });
        } catch { return withhold(stopped() ?? failure); }
      };
      // Consumes late rejection, even when trusted callbacks ignore cancellation. This
      // releases our waiter; it cannot interrupt blocking synchronous code or remote work.
      return await Promise.race([work(), cancelled]);
    } catch { return withhold(stopped() ?? failure); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) callerSignal?.removeEventListener("abort", onAbort);
    }
  } });
}
