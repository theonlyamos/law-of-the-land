import { createHash, randomUUID } from "node:crypto";
import { createPublicationFilterBinding, PUBLICATION_FILTER_PROTOCOL } from "../../../shared/gemini-publication-filter";
import type { Interactions } from "@google/genai";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ReviewedEmploymentCommitInput } from "../../../convex/reviewedEmploymentCompletion";
import { createTelemetryServiceProof, isOpaqueTelemetryToken } from "../../../convex/lib/telemetryProof";
import { MAX_CHAT_CONTEXT_FILES, MAX_CHAT_FILES } from "../../../shared/chat-attachments";
import { reviewedEmploymentJobProofParts, reviewedEmploymentSourceBundleCanonicalJson, type ReviewedEmploymentJobClaim, type ReviewedEmploymentJobError,
  type ReviewedEmploymentJobOperation, type ReviewedEmploymentJobReservation, type ReviewedEmploymentJobWorkerInput } from "../../../shared/reviewed-employment-jobs";
import { createEmploymentAuthority } from "./employment-authority";
import { PILOT_CATALOG, PILOT_IDENTITY } from "./reviewed-source-cases";
import { createReviewedEmploymentChat, localReviewedEmploymentEnabled,
  type ReviewedEmploymentCompletion, type ReviewedEmploymentSelection } from "./reviewed-employment-chat";
import { createReviewedPassageDraft, REVIEWED_DRAFT_LIMITS } from "./reviewed-passage-draft";
import { createReviewedSplitVerifier } from "./reviewed-split-verifier";
import { prepareSplitInput, type StageRequest } from "./split-verification/contracts";
import { assertNoCredential, GOOGLE_PROVIDER_SETTINGS, serializeGoogleBody, strictJson } from "./split-verification/google-wire";
import { createStreamingStageExecutor } from "./split-verification/streaming";
import { captureReviewedEmploymentPolicy, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, REVIEWED_EMPLOYMENT_POLICY,
  reviewedEmploymentNextPolicy, type ReviewedEmploymentPolicy, type ReviewedEmploymentPolicyId } from "../../../shared/reviewed-employment-policy";
import { isReviewedEmploymentBackgroundExecutionEnabled } from "./reviewed-employment-background-enabled";
import { reviewedEmploymentNextEnvironment } from "./reviewed-employment-next-environment";

type Reply = Readonly<{ status: "ok" | "ignored"; payload: string | null }>;
export type ReviewedEmploymentJobWorkerDependencies = Readonly<{
  catalog?: ReviewedEmploymentPolicy; policyId?: ReviewedEmploymentPolicyId;
  /** Native service proof adapter only; no user/browser token or admin client. */
  rpc(input: ReviewedEmploymentJobWorkerInput): Promise<Reply>;
  credential: string; fetch: typeof globalThis.fetch; workerId?: string; pollIntervalMs?: number;
}>;
type Submission = Readonly<{ query: string; messages: readonly { role: "user" | "assistant"; content: string }[];
  historyComplete: true; selection: ReviewedEmploymentSelection; facts: string; attachmentIds: string[];
  contextAttachmentIds: string[]; routeNonce: string }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
class WorkerStopped extends Error {
  constructor(readonly reason: ReviewedEmploymentJobError) { super(reason); }
}
function readSubmission(raw: string): Submission {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 384 * 1024) throw new WorkerStopped("invalid_request");
  const value = strictJson(raw);
  const validIds = (ids: unknown, max: number): ids is string[] => Array.isArray(ids) && ids.length <= max
    && ids.every(identifier) && new Set(ids).size === ids.length;
  if (!object(value) || !exact(value, ["query", "messages", "historyComplete", "selection", "facts", "attachmentIds", "contextAttachmentIds", "routeNonce"])
    || typeof value.query !== "string" || !value.query.trim() || value.query.length > 4000 || value.historyComplete !== true
    || !Array.isArray(value.messages) || value.messages.length > 20 || value.messages.some(message => !object(message)
      || !exact(message, ["role", "content"]) || !["user", "assistant"].includes(String(message.role))
      || typeof message.content !== "string" || message.content.length > 16_000)
    || !object(value.selection) || !exact(value.selection, ["status", "question", "facts", "requests", "evidence",
      ...(Object.hasOwn(value.selection, "topics") ? ["topics"] : [])])
    || value.selection.status !== "selected" || value.selection.question !== value.query || typeof value.facts !== "string"
    || value.facts.length > 160_000 || value.selection.facts !== value.facts || !Array.isArray(value.selection.requests)
    || !object(value.selection.evidence) || !validIds(value.attachmentIds, MAX_CHAT_FILES)
    || !validIds(value.contextAttachmentIds, MAX_CHAT_CONTEXT_FILES) || value.attachmentIds.some(id => !(value.contextAttachmentIds as string[]).includes(id))
    || typeof value.routeNonce !== "string" || !isOpaqueTelemetryToken(value.routeNonce)) throw new WorkerStopped("invalid_request");
  return value as unknown as Submission;
}
function readClaim(raw: string | null, jobId: string, catalog: ReviewedEmploymentPolicy, policyId: ReviewedEmploymentPolicyId): ReviewedEmploymentJobClaim {
  const value = raw === null ? null : strictJson(raw);
  if (!object(value) || !exact(value, ["jobId", "submission", "createdAt", "verificationDeadlineAt", "terminalDeadlineAt",
    "externalId", "jurisdictionId", "userClientId", "assistantClientId", ...(Object.hasOwn(value, "policyId") ? ["policyId"] : [])])
    || value.jobId !== jobId || ![value.jobId, value.externalId, value.userClientId, value.assistantClientId].every(identifier)
    || value.userClientId === value.assistantClientId || value.jurisdictionId !== catalog.jurisdictionId
    || !(value.policyId === policyId || (policyId === "act651-s55-dev-v1" && !Object.hasOwn(value, "policyId")))
    || typeof value.submission !== "string" || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || (value.createdAt as number) > Date.now() || !Number.isSafeInteger((value.createdAt as number) + 270_000)
    || value.verificationDeadlineAt !== (value.createdAt as number) + 240_000
    || value.terminalDeadlineAt !== (value.createdAt as number) + 270_000) throw new WorkerStopped("invalid_request");
  return value as unknown as ReviewedEmploymentJobClaim;
}
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(signal.reason ?? new WorkerStopped("cancelled")); };
    signal.addEventListener("abort", cancel, { once: true });
    // Observe every late resolution/rejection, including an already-aborted call.
    void operation.then(value => { signal.removeEventListener("abort", cancel); signal.aborted ? cancel() : resolve(value); },
      error => { signal.removeEventListener("abort", cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}
async function boundedDraftResponse(response: Response, signal: AbortSignal, credential: string): Promise<Interactions.Interaction> {
  if (response.status !== 200 || response.redirected || !response.body
    || Number(response.headers.get("content-length")) > REVIEWED_DRAFT_LIMITS.responseBytes) throw new WorkerStopped("draft_blocked");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await raceAbort(reader.read(), signal); if (part.done) break;
      size += part.value.byteLength; if (size > REVIEWED_DRAFT_LIMITS.responseBytes) throw new WorkerStopped("draft_blocked"); chunks.push(part.value);
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    assertNoCredential(raw, credential); const parsed = strictJson(raw); signal.throwIfAborted();
    return parsed as Interactions.Interaction;
  } finally { signal.removeEventListener("abort", cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

/** One saved claim and four persisted dispatch reservations. Browser lifetime is
 * deliberately absent. No uncertain stage is retried or resumed by this worker. */
export function createReviewedEmploymentJobWorker(dependencies: ReviewedEmploymentJobWorkerDependencies) {
  const { rpc, fetch, credential } = dependencies;
  const catalog = captureReviewedEmploymentPolicy(dependencies.catalog ?? REVIEWED_EMPLOYMENT_POLICY);
  const expectedPolicyId: ReviewedEmploymentPolicyId = catalog === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY ? "act651-s55-prod-v1" : "act651-s55-dev-v1";
  const policyId = dependencies.policyId ?? expectedPolicyId;
  return Object.freeze({ async run(jobId: string): Promise<void> {
    const workerId = dependencies.workerId ?? randomUUID(), entryWall = Date.now(), entryMono = performance.now();
    const controller = new AbortController(); let claim: ReviewedEmploymentJobClaim | undefined;
    let failure: ReviewedEmploymentJobError = "invalid_request", sourceBinding: string | undefined, cachedBundle: Record<string, unknown> | undefined;
    let phase: "draft" | "verification" | "commit" = "draft";
    let queueAgeMs = 0;
    let pollingStopped = false, pollTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined, phaseTimer: ReturnType<typeof setTimeout> | undefined;
    const remaining = (windowMs = 270_000) => claim ? Math.min(claim.createdAt + windowMs - Date.now(),
      windowMs - queueAgeMs - (performance.now() - entryMono)) : windowMs - (performance.now() - entryMono);
    const guard = () => {
      controller.signal.throwIfAborted();
      if (remaining() <= 0 || (claim && remaining(phase === "draft" ? 60_000 : phase === "verification" ? 240_000 : 270_000) <= 0)) throw new WorkerStopped("deadline_exceeded");
    };
    const armPhase = (next: typeof phase) => {
      phase = next; if (phaseTimer !== undefined) clearTimeout(phaseTimer); guard();
      if (next !== "commit") phaseTimer = setTimeout(() => controller.abort(new WorkerStopped("deadline_exceeded")),
        Math.max(0, remaining(next === "draft" ? 60_000 : 240_000)));
    };
    const invoke = async (operation: ReviewedEmploymentJobOperation, body: unknown, signal = controller.signal): Promise<Reply> => {
      guard(); signal.throwIfAborted();
      const result = await raceAbort(rpc({ jobId, workerId, operation, body: JSON.stringify(body), issuedAt: Date.now(),
        publicationFilterProtocol: PUBLICATION_FILTER_PROTOCOL }), signal);
      guard(); signal.throwIfAborted();
      if (!object(result) || !["ok", "ignored"].includes(result.status) || (result.payload !== null && typeof result.payload !== "string")) throw new WorkerStopped(failure);
      return result;
    };
    const required = async (operation: ReviewedEmploymentJobOperation, body: unknown, signal = controller.signal): Promise<string | null> => {
      const result = await invoke(operation, body, signal);
      if (result.status !== "ok") throw new WorkerStopped(failure); return result.payload;
    };
    const stopPolling = () => { pollingStopped = true; if (pollTimer !== undefined) clearTimeout(pollTimer); };
    const poll = async () => {
      if (pollingStopped || controller.signal.aborted) return;
      try {
        const result = await invoke("state", {});
        if (pollingStopped) return;
        const state = result.payload === null ? null : strictJson(result.payload);
        if (result.status === "ignored" || !object(state) || !["queued", "running"].includes(String(state.status))) {
          controller.abort(new WorkerStopped(object(state) && state.status === "expired" ? "deadline_exceeded" : "cancelled")); return;
        }
      } catch (error) { if (!pollingStopped) controller.abort(error instanceof WorkerStopped ? error : new WorkerStopped("internal")); return; }
      if (!pollingStopped && !controller.signal.aborted) pollTimer = setTimeout(() => { void poll(); }, dependencies.pollIntervalMs ?? 1000);
    };
    const receipts = new WeakMap<object, ReviewedEmploymentJobReservation>();
    try {
      if (!catalog || policyId !== expectedPolicyId || !identifier(jobId) || !identifier(workerId) || typeof credential !== "string" || !credential.length
        || !Number.isFinite(entryMono) || entryMono < 0) throw new WorkerStopped("invalid_request");
      terminalTimer = setTimeout(() => controller.abort(new WorkerStopped("deadline_exceeded")), 270_000);
      const claimed = await invoke("claim", {}); if (claimed.status === "ignored") return;
      claim = readClaim(claimed.payload, jobId, catalog, policyId);
      queueAgeMs = Math.max(0, entryWall - claim.createdAt);
      const submission = readSubmission(claim.submission);
      clearTimeout(terminalTimer); guard();
      terminalTimer = setTimeout(() => controller.abort(new WorkerStopped("deadline_exceeded")), Math.max(0, remaining()));
      armPhase("draft");
      pollTimer = setTimeout(() => { void poll(); }, dependencies.pollIntervalMs ?? 1000);
      const authority = createEmploymentAuthority({ timingPolicy: "background", catalog,
        authorizeSource: async ({ signal }) => {
          const raw = await required("authority", {}, AbortSignal.any([signal, controller.signal]));
          const bundle = raw === null ? null : strictJson(raw);
          if (!object(bundle) || !exact(bundle, ["source", "manifest"])) throw new WorkerStopped("authority_unavailable");
          const binding = sha(reviewedEmploymentSourceBundleCanonicalJson({ source: bundle.source, manifest: bundle.manifest }));
          if (sourceBinding !== undefined && binding !== sourceBinding) throw new WorkerStopped("authority_unavailable");
          sourceBinding ??= binding; cachedBundle = bundle; return bundle.source;
        },
        loadManifest: async ({ signal }) => { guard(); signal.throwIfAborted(); if (!cachedBundle) throw new WorkerStopped("authority_unavailable"); return cachedBundle.manifest; },
      });
      const reservation = (stage: ReviewedEmploymentJobReservation["stage"], body: string, candidateSha256: string | null): ReviewedEmploymentJobReservation => {
        if (!sourceBinding) throw new WorkerStopped("authority_unavailable");
        assertNoCredential(body, credential); return Object.freeze({ stage, requestSha256: sha(body), candidateSha256, sourceBinding });
      };
      let draftReceipt: ReviewedEmploymentJobReservation | undefined;
      const draft = createReviewedPassageDraft({ interactions: { create: async (request, options) => {
        failure = "draft_blocked"; const signal = AbortSignal.any([options.signal, controller.signal]);
        guard(); signal.throwIfAborted(); const body = JSON.stringify(request);
        draftReceipt = reservation("draft", body, null); await required("reserve", draftReceipt, signal);
        guard(); signal.throwIfAborted();
        const response = await raceAbort(fetch(GOOGLE_PROVIDER_SETTINGS.endpoint, { method: "POST", body, redirect: "error",
          headers: { "content-type": "application/json", "x-goog-api-key": credential }, signal }), signal);
        return await boundedDraftResponse(response, signal, credential);
      } } });
      const verifier = createReviewedSplitVerifier({ thinkingPolicy: "inventory_low", timingPolicy: "background",
        createExecutor: runInput => {
          const prepared = prepareSplitInput(runInput); if (!prepared) throw new WorkerStopped("verification_blocked");
          const dispatches = new Map<string, StageRequest>();
          const reservedFetch: typeof globalThis.fetch = async (url, init) => {
            const dispatchSignal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
            guard(); dispatchSignal.throwIfAborted();
            if (url !== GOOGLE_PROVIDER_SETTINGS.endpoint || init?.method !== "POST" || typeof init.body !== "string") throw new WorkerStopped("verification_blocked");
            const request = dispatches.get(sha(init.body)); if (!request) throw new WorkerStopped("verification_blocked");
            const receipt = reservation(request.stage, init.body, prepared.candidateSha256);
            await required("reserve", receipt, dispatchSignal); guard(); dispatchSignal.throwIfAborted();
            receipts.set(request.binding, receipt);
            return await raceAbort(fetch(url, { ...init, signal: dispatchSignal }), dispatchSignal);
          };
          // Preserve the adapter's accepted inventory and request ID across all
          // three stages. Exact wire hashes select each concurrent audit's own
          // binding without a mutable shared "current request" variable.
          const execute = createStreamingStageExecutor({ prepared, credential, fetch: reservedFetch,
            thinkingPolicy: "inventory_low", timingPolicy: "background", entered: { wall: runInput.requestStartedAt,
              mono: runInput.requestStartedMonotonic } });
          return async (request, signal) => {
            failure = "verification_blocked";
            const wire = JSON.parse(serializeGoogleBody(request, "inventory_low")); wire.stream = true;
            const hash = sha(JSON.stringify(wire)); if (dispatches.has(hash)) throw new WorkerStopped("verification_blocked");
            dispatches.set(hash, request);
            try { return await execute(request, signal); } finally { dispatches.delete(hash); }
          };
        },
        onStagePassed: async (request: StageRequest) => {
          guard(); const receipt = receipts.get(request.binding); if (!receipt) throw new WorkerStopped("verification_blocked");
          await required("passed", receipt); guard();
        },
      });
      const result = await createReviewedEmploymentChat({ authority, timingPolicy: "background", verifier, catalog,
        draft: { draft: async input => {
          const result = await draft.draft(input);
          if (result.status === "drafted") {
            guard(); if (!draftReceipt) throw new WorkerStopped("draft_blocked");
            await required("passed", { ...draftReceipt, candidateSha256: sha(result.candidate) }, input.signal);
            armPhase("verification");
          }
          return result;
        } },
        commit: async ({ answer, citations, manifest, signal }) => {
          failure = "commit_failed"; guard(); signal.throwIfAborted(); armPhase("commit");
          const publicationFilterBinding = await createPublicationFilterBinding(manifest.stores);
          guard(); signal.throwIfAborted();
          // The atomic commit checks current persisted cancellation. Stop the
          // observer so our own successful state cannot abort its response.
          stopPolling();
          const value: ReviewedEmploymentCommitInput = {
            completion: { routeNonce: submission.routeNonce, externalId: claim!.externalId, jurisdictionId: claim!.jurisdictionId,
              publicationFilterProtocol: PUBLICATION_FILTER_PROTOCOL,
              ...(publicationFilterBinding === undefined ? {} : { publicationFilterBinding }),
              assistantClientId: claim!.assistantClientId, finalAnswer: answer, answerKind: "legal", citations: [...citations],
              model: GOOGLE_PROVIDER_SETTINGS.model, elapsedMs: Math.min(270_000, Math.max(0, Math.round(Math.max(Date.now() - claim!.createdAt,
                queueAgeMs + performance.now() - entryMono)))), outcome: "success",
              authorizedScopeSize: manifest.authorizedScopeSize, readyStoreCount: manifest.stores.length, partialCoverage: manifest.partialCoverage,
              jurisdictionCoverage: manifest.stores.map((store, ordinal) => ({ ordinal, relation: store.relation,
                coverage: citations.some(citation => citation.jurisdictionId === store.jurisdictionId) ? "evidence" : "not_searched" })),
              attachmentIds: submission.contextAttachmentIds as Id<"chatAttachments">[] },
            source: { jurisdictionId: catalog.jurisdictionId as Id<"jurisdictions">, resourceId: catalog.resourceId as Id<"legalResources">,
              versionId: catalog.versionId as Id<"documentVersions">, expectedSha256: PILOT_IDENTITY.originalSha256,
              expectedByteSize: PILOT_IDENTITY.originalByteLength, asOfDate: new Date().toISOString().slice(0, 10) },
            user: { clientId: claim!.userClientId, content: submission.query, attachmentIds: submission.attachmentIds as Id<"chatAttachments">[] },
          };
          const committed = await required("commit", value, AbortSignal.any([signal, controller.signal]));
          if (committed === null) throw new WorkerStopped("commit_failed");
          return strictJson(committed) as ReviewedEmploymentCompletion;
        },
      }).run({ externalId: claim.externalId, jurisdictionId: claim.jurisdictionId, callsApproved: true,
        selection: submission.selection, requestStartedAt: claim.createdAt, requestStartedMonotonic: entryMono, signal: controller.signal });
      if (result.status !== "verified") throw new WorkerStopped(result.reason === "aborted" ? "cancelled"
        : result.reason === "evidence_unavailable" || result.reason === "calls_not_enabled" ? "invalid_request" : result.reason);
    } catch (error) {
      const reason = controller.signal.reason instanceof WorkerStopped ? controller.signal.reason.reason
        : error instanceof WorkerStopped ? error.reason : failure;
      // Failure persistence is a separate transaction after any commit rollback.
      // A bounded waiter observes late errors without retrying an uncertain RPC.
      const failController = new AbortController(); const timer = setTimeout(() => failController.abort(), 5000);
      try { await raceAbort(rpc({ jobId, workerId, operation: "fail", body: JSON.stringify({ reason }), issuedAt: Date.now() }), failController.signal); } catch {}
      finally { clearTimeout(timer); }
    } finally { stopPolling(); if (terminalTimer !== undefined) clearTimeout(terminalTimer);
      if (phaseTimer !== undefined) clearTimeout(phaseTimer); controller.abort(); }
  } });
}

/** Called only by the gated Next after hook. Existing native credentials stay in
 * process; the service client never receives browser auth or an admin token. */
export async function runReviewedEmploymentJob(jobId: string): Promise<void> {
  const environment = reviewedEmploymentNextEnvironment();
  const catalog = reviewedEmploymentNextPolicy(environment);
  if (!catalog || !isReviewedEmploymentBackgroundExecutionEnabled(environment)) return;
  const credential = process.env.GOOGLE_AI_API_KEY, url = environment.NEXT_PUBLIC_CONVEX_URL;
  if (!credential || !url || !process.env.TELEMETRY_INGEST_SECRET) return;
  const client = new ConvexHttpClient(url);
  const reference = makeFunctionReference<"mutation", ReviewedEmploymentJobWorkerInput & { jobId: Id<"reviewedEmploymentJobs">; serviceProof: string }, Reply>("reviewedEmploymentJobs:worker");
  await createReviewedEmploymentJobWorker({ credential, fetch: globalThis.fetch, catalog,
    policyId: catalog === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY ? "act651-s55-prod-v1" : "act651-s55-dev-v1", rpc: async input => {
    const serviceProof = await createTelemetryServiceProof(await reviewedEmploymentJobProofParts(input));
    return await client.mutation(reference, { ...input, jobId: input.jobId as Id<"reviewedEmploymentJobs">, serviceProof });
  } }).run(jobId);
}
