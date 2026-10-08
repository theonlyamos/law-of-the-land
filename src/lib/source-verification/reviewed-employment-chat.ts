import { createHash } from "node:crypto";
import type { ValidatedCitation } from "../gemini-file-search-chat";
import type { ReviewedSourceAuthorityInput as LocalPilotAuthorityInput, ReviewedSourceAuthorityResult as LocalPilotAuthorityResult, ReviewedSourceManifest as LocalPilotManifest } from "./reviewed-authority-contract";
import type { createReviewedPassageDraft } from "./reviewed-passage-draft";
import { normalizeEvaluationResponseStatus, type createGeminiEvaluationVerifier,
  type EvaluationProviderUsage, type EvaluationResponseStatus, type EvaluationRunInput } from "./gemini-verifier";
import { resolveEvaluationEvidence, type EvaluationEvidence, type EvaluationEvidenceRequest } from "./evidence";
import { PILOT_CATALOG, PILOT_IDENTITY, PILOT_REGISTRY } from "./reviewed-source-cases";
import { createChatVerificationGate } from "./chat-verification-gate";
import { projectReviewedSplitDiagnostics, type ReviewedSplitDiagnostics, type ReviewedSplitRunInput, type ReviewedSplitVerifier } from "./reviewed-split-verifier";
import { sourceConditions } from "./source-conditions";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "./trusted-timing-policy";
import { captureReviewedEmploymentPolicy, REVIEWED_EMPLOYMENT_POLICY,
  type ReviewedEmploymentPolicy } from "../../../shared/reviewed-employment-policy";

type Environment = Readonly<Record<string, string | undefined>>;
export function localReviewedEmploymentEnabled(env: Environment): boolean {
  return env.NODE_ENV === "development" && env.LOCAL_REVIEWED_EMPLOYMENT_ENABLED === "1" && env.VERCEL === undefined
    && env.CONVEX_DEPLOYMENT === "dev:adventurous-hummingbird-244"
    && env.NEXT_PUBLIC_CONVEX_URL === "https://adventurous-hummingbird-244.eu-west-1.convex.cloud"
    && env.NEXT_PUBLIC_CONVEX_SITE_URL === "https://adventurous-hummingbird-244.eu-west-1.convex.site";
}
export function isLocalReviewedEmploymentRequest(request: Request, env: Environment): boolean {
  if (!localReviewedEmploymentEnabled(env) || request.method !== "POST") return false;
  try {
    const url = new URL(request.url);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1"].includes(url.hostname)
      && url.port === "3000" && !url.username && !url.password && request.headers.get("origin") === url.origin;
  } catch { return false; }
}
export type ReviewedEmploymentSelection = Readonly<{ status: "selected"; question: string; facts: string;
  requests: readonly EvaluationEvidenceRequest[]; evidence: EvaluationEvidence }>;
export type ReviewedEmploymentCompletion = Readonly<{ status: "completed"; outcome: "success"; answerKind: "legal";
  persisted: true;
  citations: readonly Readonly<{ label: string; jurisdictionId: string; jurisdictionName: string;
    jurisdictionKind: "geographic" | "organizational"; relation: "selected" | "geographic_ancestor" | "organizational_geography" }>[];
  partialCoverage: boolean; citationClaim: string; expiresAt: number }>;
export type ReviewedEmploymentDependencies = Readonly<{
  /** Exact catalog pinned at trusted deployment construction. */
  catalog?: ReviewedEmploymentPolicy;
  /** Trusted server construction only, captured before admission. */
  timingPolicy?: TrustedTimingPolicy;
  authority: { resolve(input: LocalPilotAuthorityInput & { externalId: string }): Promise<LocalPilotAuthorityResult> };
  draft: Pick<ReturnType<typeof createReviewedPassageDraft>, "draft">;
  verifier: Pick<ReturnType<typeof createGeminiEvaluationVerifier>, "evaluate"> | ReviewedSplitVerifier;
  /** One transaction reauthorizes the edition, completes governance and consumes the exact-answer claim while saving both messages. */
  commit(input: Readonly<{ answer: string; citations: readonly (ValidatedCitation & { pageNumber: number })[]; manifest: LocalPilotManifest; signal: AbortSignal }>): Promise<ReviewedEmploymentCompletion>;
}>;
type Reason = "invalid_request" | "calls_not_enabled" | "aborted" | "deadline_exceeded" | "authority_unavailable"
  | "evidence_unavailable" | "draft_blocked" | "verification_blocked" | "commit_failed";
const diagnosticStages = ["admission", "evidence", "initial_authority", "draft", "verification_gate",
  "verification_authority_before", "verifier", "verification_authority_after", "commit", "complete"] as const;
const gateReasons = ["gate_disabled", "invalid_input", "invalid_deadline", "deadline_exceeded", "aborted",
  "authority_unavailable", "authority_changed", "evidence_unavailable", "evidence_changed", "verification_unavailable", "verification_rejected"] as const;
const diagnosticReasons = [...gateReasons, "invalid_request", "calls_not_enabled", "invalid_evidence", "limit_exceeded",
  "provider_error", "invalid_response", "incomplete_response", "catalog_mismatch", "source_not_applicable", "manifest_invalid",
  "no_requests", "source_not_registered", "identity_mismatch", "invalid_bundle", "invalid_utf8", "integrity_mismatch",
  "invalid_span", "missing_context", "unreviewed_span", "missing_locator", "locator_not_found", "ambiguous_locator",
  "verified", "unsupported_claim", "invalid_segments", "invalid_verdict", "missing_segment", "duplicate_segment", "unknown_segment",
  "duplicate_claim", "unknown_evidence", "missing_support", "duplicate_reference", "decision_mismatch", "invalid_candidate", "empty_candidate",
  "dependency_failed", "invalid_result", "candidate_mismatch", "authority_mismatch", "reservation_failed", "stage_rejected", "request_mismatch", "commit_failed"] as const;
type DiagnosticStage = typeof diagnosticStages[number];
type DiagnosticReason = typeof diagnosticReasons[number];
const timingKeys = ["preparation", "provider", "validation", "total"] as const;
const usageKeys = ["total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_cached_tokens", "total_tokens", "total_tool_use_tokens"] as const;
export type ReviewedEmploymentProviderDiagnostics = Readonly<{
  /** Dependency invocation does not prove an SDK attempt. Null is unknown. */
  attemptCount: 0 | 1 | null;
  /** Closed provider status only; absence means no response status was retained. */
  responseStatus?: EvaluationResponseStatus;
  timingMs?: Readonly<Record<typeof timingKeys[number], number>>;
  /** Provider-reported counters only; omitted means unknown, never zero or cost. */
  usage?: EvaluationProviderUsage;
}>;
export type ReviewedEmploymentDiagnostics = Readonly<{
  version: 1; stage: DiagnosticStage; reason: DiagnosticReason;
  gateReason?: typeof gateReasons[number];
  callCounts: Readonly<{ draftInvocations: 0 | 1; verifierInvocations: 0 | 1 }>;
  draft: ReviewedEmploymentProviderDiagnostics; verifier: ReviewedEmploymentProviderDiagnostics;
  /** Separate three-stage executor accounting, never a fabricated single provider attempt. */
  splitVerifier?: ReviewedSplitDiagnostics;
}>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function allowed<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function providerDiagnostics(value: unknown): ReviewedEmploymentProviderDiagnostics {
  if (!object(value)) return Object.freeze({ attemptCount: null });
  const attemptCount = value.attemptCount === 0 || value.attemptCount === 1 ? value.attemptCount : null;
  const rawStatus = value.responseStatus;
  const responseStatus = rawStatus === undefined ? undefined
    : rawStatus === "missing" || rawStatus === "unknown" ? rawStatus : normalizeEvaluationResponseStatus(rawStatus);
  const timing = value.timingMs, reportedUsage = value.usage;
  const timingMs = object(timing) && timingKeys.every(key => count(timing[key]))
    ? Object.fromEntries(timingKeys.map(key => [key, timing[key]])) as Record<typeof timingKeys[number], number> : undefined;
  const usage = object(reportedUsage) && usageKeys.every(key => reportedUsage[key] === undefined || count(reportedUsage[key]))
    ? Object.fromEntries(usageKeys.filter(key => reportedUsage[key] !== undefined).map(key => [key, reportedUsage[key]])) as EvaluationProviderUsage : undefined;
  return freeze({ attemptCount, ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(timingMs ? { timingMs } : {}), ...(usage && Object.keys(usage).length ? { usage } : {}) });
}
/** Closed logging projection. Never forward callback strings, errors, text, identifiers or extra fields. */
export function projectReviewedEmploymentDiagnostics(value: unknown): ReviewedEmploymentDiagnostics | undefined {
  try {
    if (!object(value) || value.version !== 1 || !allowed(diagnosticStages, value.stage) || !allowed(diagnosticReasons, value.reason)
      || (value.gateReason !== undefined && !allowed(gateReasons, value.gateReason))) return;
    const calls = value.callCounts;
    if (!object(calls) || (calls.draftInvocations !== 0 && calls.draftInvocations !== 1)
      || (calls.verifierInvocations !== 0 && calls.verifierInvocations !== 1)) return;
    const splitVerifier = value.splitVerifier === undefined ? undefined : projectReviewedSplitDiagnostics(value.splitVerifier);
    if (value.splitVerifier !== undefined && !splitVerifier) return;
    return freeze({ version: 1, stage: value.stage, reason: value.reason,
      ...(value.gateReason === undefined ? {} : { gateReason: value.gateReason }),
      callCounts: { draftInvocations: calls.draftInvocations, verifierInvocations: calls.verifierInvocations },
      draft: providerDiagnostics(value.draft), verifier: providerDiagnostics(value.verifier), ...(splitVerifier ? { splitVerifier } : {}) });
  } catch { return; }
}

type Metadata = Readonly<{ purpose: "local_reviewed_employment_chat"; productionEligible: false;
  callCounts: Readonly<{ draftInvocations: number; verifierInvocations: number }>; diagnostics: ReviewedEmploymentDiagnostics }>;
export type ReviewedEmploymentResult = Metadata & (Readonly<{ status: "blocked"; reason: Reason }>
  | Readonly<{ status: "verified"; answer: string; completion: ReviewedEmploymentCompletion; persisted: true }>);
class Stopped extends Error { constructor(readonly reason: "aborted" | "deadline_exceeded") { super(reason); } }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Experimental reviewed seven-span path. One private draft and one selected verifier orchestration, no retries or fallback.
 * Deadlines are measured from the original request/job entry under a captured server policy.
 * A late remote mutation may settle after cancellation, but cannot cause local answer release.
 */
export function createReviewedEmploymentChat(deps: ReviewedEmploymentDependencies) {
  const catalog = captureReviewedEmploymentPolicy(deps.catalog ?? REVIEWED_EMPLOYMENT_POLICY);
  const timing = captureTrustedTimingPolicy(deps.timingPolicy);
  const splitVerifier = "kind" in deps.verifier && deps.verifier.kind === "split" ? deps.verifier : undefined;
  const singleVerifier = "evaluate" in deps.verifier ? deps.verifier : undefined;
  return Object.freeze({ async run(input: Readonly<{ externalId: string; jurisdictionId: string; callsApproved: boolean;
    selection: ReviewedEmploymentSelection; requestStartedAt: number; requestStartedMonotonic?: number; signal?: AbortSignal }>): Promise<ReviewedEmploymentResult> {
    const enteredAt = Date.now(), enteredMono = performance.now();
    const calls: { draftInvocations: 0 | 1; verifierInvocations: 0 | 1 } = { draftInvocations: 0, verifierInvocations: 0 };
    let stage: DiagnosticStage = "admission", detail: DiagnosticReason | undefined;
    let gateReason: ReviewedEmploymentDiagnostics["gateReason"];
    let draftDiagnostics = providerDiagnostics(undefined), verifierDiagnostics = providerDiagnostics(undefined);
    let splitDiagnostics: ReviewedSplitDiagnostics | undefined, diagnosticsClosed = false;
    const retainSplitDiagnostics = (value: unknown) => {
      if (!diagnosticsClosed && !splitDiagnostics) splitDiagnostics = projectReviewedSplitDiagnostics(value);
    };
    const enter = (next: DiagnosticStage) => { stage = next; detail = undefined; };
    const describe = (reason: unknown) => { detail = allowed(diagnosticReasons, reason) ? reason : "invalid_result"; };
    const metadata = (): Metadata => { diagnosticsClosed = true; return { purpose: "local_reviewed_employment_chat", productionEligible: false, callCounts: Object.freeze({ ...calls }),
      diagnostics: freeze({ version: 1, stage, reason: detail ?? "dependency_failed", ...(gateReason ? { gateReason } : {}),
        callCounts: { ...calls }, draft: draftDiagnostics, verifier: verifierDiagnostics, ...(splitDiagnostics ? { splitVerifier: splitDiagnostics } : {}) }) }; };
    const blocked = (reason: Reason, diagnosticReason?: DiagnosticReason): ReviewedEmploymentResult => {
      if (diagnosticReason) detail = diagnosticReason;
      return Object.freeze({ ...metadata(), status: "blocked", reason });
    };
    const controller = new AbortController(); let onAbort: (() => void) | undefined;
    let failure: Reason = "invalid_request";
    try {
      if (!timing || !catalog) return blocked("invalid_request", "invalid_request");
      if (input.callsApproved !== true) return blocked("calls_not_enabled", "calls_not_enabled");
      const origin = input.requestStartedAt;
      const originMono = input.requestStartedMonotonic;
      if (!Number.isSafeInteger(origin) || origin < 0 || origin > enteredAt || !Number.isSafeInteger(origin + timing.terminalMs)
        || (splitVerifier && (originMono === undefined || !Number.isFinite(originMono) || originMono < 0 || originMono > enteredMono))
        || input.jurisdictionId !== catalog.jurisdictionId || typeof input.externalId !== "string"
        || !input.externalId.trim() || input.externalId.length > 200 || input.selection?.status !== "selected") return blocked("invalid_request", "invalid_request");
      const initialElapsed = enteredAt - origin;
      const remaining = (deadline: number) => Math.min(deadline - Date.now(), deadline - origin
        - (splitVerifier && timing.verificationMs !== 240000 ? performance.now() - originMono! : initialElapsed + (performance.now() - enteredMono)));
      const guard = (deadline: number) => {
        if (remaining(deadline) <= 0) throw new Stopped("deadline_exceeded");
        if (input.signal?.aborted || controller.signal.aborted) throw new Stopped("aborted");
      };
      onAbort = () => controller.abort(); input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) controller.abort();
      const wait = <T>(action: () => Promise<T>, deadline: number): Promise<T> => {
        guard(deadline);
        return new Promise((resolve, reject) => {
          let done = false; let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (ok: boolean, value: unknown) => {
            if (done) return; done = true; if (timer !== undefined) clearTimeout(timer);
            controller.signal.removeEventListener("abort", cancel); if (ok) resolve(value as T); else reject(value);
          };
          const cancel = () => { finish(false, new Stopped(remaining(deadline) <= 0 ? "deadline_exceeded" : "aborted")); controller.abort(); };
          controller.signal.addEventListener("abort", cancel, { once: true });
          timer = setTimeout(cancel, Math.max(0, Math.ceil(remaining(deadline))));
          Promise.resolve().then(() => { guard(deadline); return action(); }).then(value => {
            if (done) return; try { guard(deadline); finish(true, value); } catch (error) { finish(false, error); }
          }, error => finish(false, error));
        });
      };
      const draftDeadline = origin + timing.draftMs, verificationDeadline = origin + timing.verificationMs, terminalDeadline = origin + timing.terminalMs;
      guard(draftDeadline);
      // Capture the shared context before handing it to any asynchronous dependency.
      const selection: ReviewedEmploymentSelection = freeze(JSON.parse(JSON.stringify(input.selection)));
      failure = "evidence_unavailable";
      enter("evidence");
      const resolved = resolveEvaluationEvidence(PILOT_REGISTRY, selection.requests);
      if (resolved.status !== "resolved") { describe(resolved.reason); return blocked("evidence_unavailable"); }
      if (JSON.stringify(resolved.evidence) !== JSON.stringify(selection.evidence)) return blocked("evidence_unavailable", "evidence_changed");
      if (splitVerifier) {
        const conditions = sourceConditions(resolved.evidence);
        if (conditions === "invalid_evidence" || conditions.length !== 2 || conditions[0].conditionId !== "s55-consent"
          || conditions[1].conditionId !== "s55-overtime-alternatives") return blocked("evidence_unavailable", "invalid_input");
      }
      const sources = [{ sourceId: PILOT_IDENTITY.sourceId, versionId: PILOT_IDENTITY.versionId }];
      failure = "authority_unavailable";
      enter("initial_authority");
      const initial = await wait(() => deps.authority.resolve({ externalId: input.externalId, jurisdictionId: input.jurisdictionId,
        sources, deadlineAt: draftDeadline, signal: controller.signal }), draftDeadline);
      if (initial.status !== "authorized") { describe(initial.reason); return blocked("authority_unavailable"); }
      if (initial.productionEligible !== false || initial.applicability !== "source_edition_only"
        || initial.requiresFinalAtomicCompletion !== true || JSON.stringify(initial.identities) !== JSON.stringify([PILOT_IDENTITY])
        || initial.citationIdentity.jurisdictionId !== catalog.jurisdictionId || initial.citationIdentity.resourceId !== catalog.resourceId
        || initial.citationIdentity.versionId !== catalog.versionId) return blocked("authority_unavailable", "authority_mismatch");
      const authoritySnapshot = JSON.stringify(initial);
      const authority = freeze(JSON.parse(authoritySnapshot) as typeof initial);
      failure = "draft_blocked";
      enter("draft");
      const draft = await wait(async () => { calls.draftInvocations = 1;
        const result = await deps.draft.draft({ question: selection.question, facts: selection.facts, evidence: resolved.evidence,
          sourceDisplayTitle: "Labour Act, 2003 (Act 651)", requestStartedAt: origin, signal: controller.signal });
        // A result may arrive just as the outer deadline guard withholds it.
        // Retain only its safe metadata; an already-returned snapshot stays frozen.
        draftDiagnostics = providerDiagnostics(result);
        return result;
      }, draftDeadline);
      if (draft.status === "blocked") { describe(draft.reason); return blocked("draft_blocked"); }
      if (draft.status !== "drafted" || draft.productionEligible !== false || draft.attemptCount !== 1
        || typeof draft.candidate !== "string" || !draft.candidate.trim() || Buffer.byteLength(draft.candidate, "utf8") > 16 * 1024) return blocked("draft_blocked", "invalid_result");
      const candidate = draft.candidate;
      failure = "verification_blocked";
      enter("verification_gate");
      const invokeVerifier = async (value: EvaluationRunInput | ReviewedSplitRunInput): Promise<unknown> => {
        enter("verifier");
        try {
          guard(verificationDeadline); if (calls.verifierInvocations !== 0) throw new Error("duplicate_verifier_invocation");
          calls.verifierInvocations = 1;
          const verdict = splitVerifier ? await splitVerifier.verify(value as ReviewedSplitRunInput, retainSplitDiagnostics)
            : await singleVerifier!.evaluate(value as EvaluationRunInput);
          if (splitVerifier) retainSplitDiagnostics(verdict);
          else verifierDiagnostics = providerDiagnostics(verdict);
          if (verdict.decision === "withhold") describe(verdict.reason);
          else enter("verification_gate");
          return verdict;
        } catch (error) { describe(error instanceof Stopped ? error.reason : "dependency_failed"); throw error; }
      };
      const gate = createChatVerificationGate({ registry: PILOT_REGISTRY, timingPolicy: timing.verificationMs === 240000 ? "background" : "standard",
        resolveAuthority: async ({ sources: selected, deadlineAt, signal }) => {
          enter(calls.verifierInvocations ? "verification_authority_after" : "verification_authority_before");
          try {
            guard(verificationDeadline);
            const current = await deps.authority.resolve({ externalId: input.externalId, jurisdictionId: input.jurisdictionId, sources: selected, deadlineAt, signal });
            guard(verificationDeadline);
            if (current.status !== "authorized") { describe(current.reason); return { status: "unavailable" }; }
            if (JSON.stringify(current) !== authoritySnapshot) { describe("authority_changed"); return { status: "unavailable" }; }
            enter("verification_gate");
            return { status: "authorized", identities: authority.identities };
          } catch (error) { describe(error instanceof Stopped ? error.reason : "dependency_failed"); throw error; }
        }, verifier: splitVerifier ? { kind: "split", verify: invokeVerifier } : { evaluate: invokeVerifier },
      });
      const verified = await wait(() => gate.verify({ kind: "legal", question: selection.question, facts: selection.facts, candidate,
        requests: selection.requests, requestStartedAt: origin, ...(originMono === undefined ? {} : { requestStartedMonotonic: originMono }),
        deadlineAt: verificationDeadline, signal: controller.signal }), verificationDeadline);
      if (verified.status !== "pass") {
        if (allowed(gateReasons, verified.reason)) gateReason = verified.reason;
        if (!detail) describe(verified.reason);
        return blocked("verification_blocked");
      }
      if (verified.candidateSha256 !== createHash("sha256").update(candidate, "utf8").digest("hex")) return blocked("verification_blocked", "candidate_mismatch");
      const citations = freeze([...new Set(resolved.evidence.passages.map(passage => passage.pdfOrdinal))].sort((a, b) => a - b)
        .map(pageNumber => ({ ...authority.citationIdentity, pageNumber })));
      failure = "commit_failed";
      enter("commit");
      const completion = await wait(() => deps.commit({ answer: candidate, citations, manifest: authority.manifest, signal: controller.signal }), terminalDeadline);
      if (completion.status !== "completed" || completion.outcome !== "success" || completion.answerKind !== "legal" || completion.persisted !== true
        || !Number.isFinite(completion.expiresAt) || completion.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{43}$/u.test(completion.citationClaim)
        || completion.partialCoverage !== authority.manifest.partialCoverage || completion.citations.length !== citations.length
        || completion.citations.some(citation => citation.jurisdictionId !== input.jurisdictionId || citation.jurisdictionKind !== "geographic"
          || citation.relation !== "selected" || !citation.label.trim())) return blocked("commit_failed", "invalid_result");
      const savedCompletion: ReviewedEmploymentCompletion = freeze(JSON.parse(JSON.stringify(completion)));
      guard(terminalDeadline);
      enter("complete"); describe("verified");
      return Object.freeze({ ...metadata(), status: "verified", answer: candidate, completion: savedCompletion, persisted: true });
    } catch (error) { return blocked(error instanceof Stopped ? error.reason : failure, error instanceof Stopped ? error.reason : "dependency_failed"); }
    finally { if (onAbort) input.signal?.removeEventListener("abort", onAbort); controller.abort(); }
  } });
}
