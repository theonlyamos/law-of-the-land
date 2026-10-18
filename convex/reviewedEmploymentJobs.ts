import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canAccessSession, requireReviewedEmploymentJobPrincipal } from "./chats";
import { authorizeSourceForJobPrincipal } from "./reviewedEmployment";
import { commitReviewedEmploymentForJobPrincipal, reviewedEmploymentCommitProofParts, type ReviewedEmploymentCommitInput } from "./reviewedEmploymentCompletion";
import { resolveChatResearchStoresForJurisdiction } from "./jurisdictions";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { createTelemetryServiceProof, isOpaqueTelemetryToken, verifyTelemetryServiceProof } from "./lib/telemetryProof";
import { MAX_CONTEXT_ATTACHMENTS, MAX_MESSAGE_ATTACHMENTS } from "./lib/chatAttachmentContracts";
import { reviewedEmploymentBackendPolicy, reviewedEmploymentBackendPolicyId,
  reviewedEmploymentBackendAdmissionAllowed, reviewedEmploymentBackendExecutionAllowed,
  reviewedEmploymentBackendJobPolicyMatches } from "../shared/reviewed-employment-policy";
import { REVIEWED_EMPLOYMENT_JOB_ERRORS, REVIEWED_EMPLOYMENT_JOB_STAGES, REVIEWED_EMPLOYMENT_JOB_PROOF_WINDOW_MS,
  REVIEWED_EMPLOYMENT_VERIFICATION_WINDOW_MS, REVIEWED_EMPLOYMENT_TERMINAL_WINDOW_MS,
  reviewedEmploymentJobProofParts, reviewedEmploymentJobSubmitProofParts, reviewedEmploymentSourceBundleCanonicalJson,
  type ReviewedEmploymentJobProjection, type ReviewedEmploymentJobReservation } from "../shared/reviewed-employment-jobs";

const statusValidator = v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("blocked"), v.literal("cancelled"), v.literal("expired"));
const progressValidator = v.union(v.literal("queued"), v.literal("draft"), v.literal("inventory"), v.literal("consent"), v.literal("overtime"), v.literal("commit"), v.literal("complete"));
const errorValidator = v.union(v.literal("invalid_request"), v.literal("authority_unavailable"), v.literal("draft_blocked"), v.literal("verification_blocked"), v.literal("commit_failed"), v.literal("deadline_exceeded"), v.literal("cancelled"), v.literal("internal"));
const projectionValidator = v.object({ jobId: v.id("reviewedEmploymentJobs"), externalId: v.string(), userClientId: v.string(), assistantClientId: v.string(), question: v.string(),
  status: statusValidator, progress: progressValidator, createdAt: v.number(), verificationDeadlineAt: v.number(), terminalDeadlineAt: v.number(), errorReason: v.union(v.null(), errorValidator) });
const resultValidator = v.object({ status: v.union(v.literal("ok"), v.literal("ignored")), payload: v.union(v.string(), v.null()) });
const expireRef = makeFunctionReference<"mutation", { jobId: Id<"reviewedEmploymentJobs"> }, null>("reviewedEmploymentJobs:expire");
const usageRef = makeFunctionReference<"mutation">("usage:recordQuestion");
const sourceRef = makeFunctionReference<"query">("reviewedEmployment:authorizeSource");
const MAX_BODY_BYTES = 384 * 1024;
const ignored = () => ({ status: "ignored" as const, payload: null });
const ok = (value: unknown) => ({ status: "ok" as const, payload: JSON.stringify(value) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim();
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function active(job: Doc<"reviewedEmploymentJobs">): boolean { return job.status === "queued" || job.status === "running"; }
function fresh(issuedAt: number, now: number): boolean {
  return Number.isSafeInteger(issuedAt) && issuedAt >= 0 && issuedAt <= now + 5_000 && now - issuedAt <= REVIEWED_EMPLOYMENT_JOB_PROOF_WINDOW_MS;
}
async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
type Submission = { query: string; messages: Array<{ role: "user" | "assistant"; content: string }>; historyComplete: true;
  selection: Record<string, unknown>; facts: string; attachmentIds: string[]; contextAttachmentIds: string[]; routeNonce: string };
function submissionFrom(body: string): Submission {
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_INVALID");
  let input: unknown; try { input = JSON.parse(body); } catch { throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_INVALID"); }
  if (!object(input) || !exact(input, ["query", "messages", "historyComplete", "selection", "facts", "attachmentIds", "contextAttachmentIds", "routeNonce"])
    || typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000 || input.historyComplete !== true
    || !Array.isArray(input.messages) || input.messages.length > 20
    || input.messages.some(message => !object(message) || !exact(message, ["role", "content"])
      || !["user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" || message.content.length > 16_000)
    || !object(input.selection) || input.selection.status !== "selected" || input.selection.question !== input.query
    || typeof input.facts !== "string" || input.facts.length > 160_000 || input.selection.facts !== input.facts
    || !Array.isArray(input.attachmentIds) || input.attachmentIds.length > MAX_MESSAGE_ATTACHMENTS || input.attachmentIds.some(id => !identifier(id))
    || !Array.isArray(input.contextAttachmentIds) || input.contextAttachmentIds.length > MAX_CONTEXT_ATTACHMENTS || input.contextAttachmentIds.some(id => !identifier(id))
    || new Set(input.attachmentIds).size !== input.attachmentIds.length || new Set(input.contextAttachmentIds).size !== input.contextAttachmentIds.length
    || input.attachmentIds.some(id => !(input.contextAttachmentIds as unknown[]).includes(id))
    || typeof input.routeNonce !== "string" || !isOpaqueTelemetryToken(input.routeNonce)) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_INVALID");
  return input as unknown as Submission;
}
/** The production proof must bind exactly the reviewed section 55 request. The
 * worker separately resolves and compares the complete canonical evidence before
 * any model call; labels or arbitrary supplied source text never grant scope. */
function productionSection55Selection(selection: Record<string, unknown>): boolean {
  if (!Array.isArray(selection.topics) || selection.topics.length !== 1 || selection.topics[0] !== "overtime"
    || !Array.isArray(selection.requests) || selection.requests.length !== 1) return false;
  const request: unknown = selection.requests[0];
  return object(request) && exact(request, ["sourceId", "versionId", "pdfOrdinal", "reviewedSpanId"])
    && request.sourceId === "local-act651-experimental"
    && request.versionId === "sha256-125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a"
    && request.pdfOrdinal === 18 && request.reviewedSpanId === "p18-s55-1-2";
}
function project(job: Doc<"reviewedEmploymentJobs">): ReviewedEmploymentJobProjection & { jobId: Id<"reviewedEmploymentJobs"> } {
  const expired = active(job) && Date.now() >= job.terminalDeadlineAt;
  return { jobId: job._id, externalId: job.externalId, userClientId: job.userClientId, assistantClientId: job.assistantClientId,
    question: job.question, status: expired ? "expired" : job.status, progress: job.progress, createdAt: job.createdAt,
    verificationDeadlineAt: job.verificationDeadlineAt, terminalDeadlineAt: job.terminalDeadlineAt,
    errorReason: expired ? "deadline_exceeded" : job.errorReason ?? null };
}
function sourceArgs(job: { externalId: string }, publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL) {
  const policy = reviewedEmploymentBackendPolicy(process.env);
  if (!policy) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE");
  return { externalId: job.externalId, jurisdictionId: policy.jurisdictionId as Id<"jurisdictions">,
    ...(publicationFilterProtocol ? { publicationFilterProtocol } : {}),
    resourceId: policy.resourceId as Id<"legalResources">, versionId: policy.versionId as Id<"documentVersions">,
    expectedSha256: policy.expectedSha256, expectedByteSize: policy.expectedByteSize,
    asOfDate: new Date(Date.now()).toISOString().slice(0, 10) };
}
async function ownerSession(ctx: QueryCtx | MutationCtx, externalId: string) {
  const ownerId = await optionalUserId(ctx); if (!ownerId) return null;
  const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q => q.eq("userId", ownerId).eq("externalId", externalId)).unique();
  return session && await canAccessSession(ctx, session) ? { ownerId, session } : null;
}
async function currentPrincipal(ctx: MutationCtx, job: Doc<"reviewedEmploymentJobs">) {
  return await requireReviewedEmploymentJobPrincipal(ctx, { ownerId: job.ownerId, nativeAuthSessionId: job.nativeAuthSessionId,
    sessionId: job.sessionId, externalId: job.externalId, jurisdictionId: job.jurisdictionId });
}
async function sourceAuthority(ctx: MutationCtx, job: Doc<"reviewedEmploymentJobs">, publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL) {
  const policy = reviewedEmploymentBackendPolicy(process.env);
  if (!policy || !reviewedEmploymentBackendJobPolicyMatches(process.env, job.policyId)
    || job.jurisdictionId !== policy.jurisdictionId) return null;
  const principal = await currentPrincipal(ctx, job);
  const source = await authorizeSourceForJobPrincipal(ctx, sourceArgs(job, publicationFilterProtocol), principal);
  if (source.status !== "authorized") return null;
  const manifest = await resolveChatResearchStoresForJurisdiction(ctx, job.jurisdictionId, publicationFilterProtocol);
  return { principal, source, manifest };
}

/** Only the authenticated server route can enqueue an admitted fixed review. The
 * proof is separate from worker authority and includes the complete submission. */
export const submit = mutation({
  args: { submissionId: v.string(), externalId: v.string(), jurisdictionId: v.id("jurisdictions"), userClientId: v.string(), assistantClientId: v.string(),
    publicationFilterProtocol: v.optional(v.literal(PUBLICATION_FILTER_PROTOCOL)),
    submission: v.string(), issuedAt: v.number(), serviceProof: v.string() },
  returns: projectionValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!fresh(args.issuedAt, now) || !await verifyTelemetryServiceProof(args.serviceProof, await reviewedEmploymentJobSubmitProofParts(args)))
      throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_SERVICE_PROOF_INVALID");
    const policy = reviewedEmploymentBackendPolicy(process.env), policyId = reviewedEmploymentBackendPolicyId(process.env);
    if (!policy || !policyId || !reviewedEmploymentBackendAdmissionAllowed(process.env))
      throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_ADMISSION_UNAVAILABLE");
    if (![args.submissionId, args.externalId, args.userClientId, args.assistantClientId].every(identifier)
      || args.submissionId !== args.assistantClientId || args.userClientId === args.assistantClientId
      || args.jurisdictionId !== policy.jurisdictionId) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_INVALID");
    const ownerId = await requireUserId(ctx), identity = await ctx.auth.getUserIdentity();
    if (!identity || typeof identity.sessionId !== "string" || !identifier(identity.sessionId)) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE");
    const selection = submissionFrom(args.submission), { routeNonce: _nonce, ...immutable } = selection;
    if (policyId === "act651-s55-prod-v1" && !productionSection55Selection(selection.selection))
      throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_INVALID");
    const submissionDigest = await sha256(canonical({ externalId: args.externalId, jurisdictionId: args.jurisdictionId,
      userClientId: args.userClientId, assistantClientId: args.assistantClientId, submission: immutable }));
    const owned = await ownerSession(ctx, args.externalId);
    if (!owned || owned.ownerId !== ownerId || owned.session.jurisdictionId !== args.jurisdictionId) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE");    await requireReviewedEmploymentJobPrincipal(ctx, { ownerId, nativeAuthSessionId: identity.sessionId,
      sessionId: owned.session._id, externalId: args.externalId, jurisdictionId: args.jurisdictionId });
    const duplicate = await ctx.db.query("reviewedEmploymentJobs").withIndex("by_ownerId_and_submissionId", q => q.eq("ownerId", ownerId).eq("submissionId", args.submissionId)).unique();
    if (duplicate) {
      if (duplicate.sessionId !== owned.session._id || duplicate.submissionDigest !== submissionDigest) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_CONFLICT");
      return project(duplicate);
    }

    for (const status of ["queued", "running"] as const) {
      const rows = await ctx.db.query("reviewedEmploymentJobs").withIndex("by_sessionId_and_status", q => q.eq("sessionId", owned.session._id).eq("status", status)).take(2);
      for (const row of rows) {
        if (now < row.terminalDeadlineAt) throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_ACTIVE");
        await ctx.db.patch(row._id, { status: "expired", errorReason: "deadline_exceeded", updatedAt: now });
      }
    }
    const source: { status: string } = await ctx.runQuery(sourceRef, sourceArgs(args, args.publicationFilterProtocol));
    if (source.status !== "authorized") throw new ConvexError("REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE");
    await ctx.runMutation(usageRef, {});
    const jobId = await ctx.db.insert("reviewedEmploymentJobs", { ownerId, nativeAuthSessionId: identity.sessionId,
      sessionId: owned.session._id, externalId: args.externalId, jurisdictionId: args.jurisdictionId,
      submissionId: args.submissionId, userClientId: args.userClientId, assistantClientId: args.assistantClientId,
      question: selection.query, submission: args.submission, submissionDigest, policyId, status: "queued", progress: "queued",
      createdAt: now, updatedAt: now, verificationDeadlineAt: now + REVIEWED_EMPLOYMENT_VERIFICATION_WINDOW_MS,
      terminalDeadlineAt: now + REVIEWED_EMPLOYMENT_TERMINAL_WINDOW_MS });
    await ctx.scheduler.runAt(now + REVIEWED_EMPLOYMENT_TERMINAL_WINDOW_MS, expireRef, { jobId });
    return project((await ctx.db.get(jobId))!);
  },
});

const chatQuery = { args: { externalId: v.string(), jobId: v.optional(v.id("reviewedEmploymentJobs")) }, returns: v.union(v.null(), projectionValidator),
  handler: async (ctx: QueryCtx, args: { externalId: string; jobId?: Id<"reviewedEmploymentJobs"> }) => {
    if (!identifier(args.externalId)) return null;
    const owned = await ownerSession(ctx, args.externalId); if (!owned) return null;
    const row = args.jobId ? await ctx.db.get(args.jobId)
      : await ctx.db.query("reviewedEmploymentJobs").withIndex("by_ownerId_and_externalId", q => q.eq("ownerId", owned.ownerId).eq("externalId", args.externalId)).order("desc").first();
    return row && row.ownerId === owned.ownerId && row.sessionId === owned.session._id && row.externalId === args.externalId ? project(row) : null;
  } };
export const getForChat = query(chatQuery);
export const latest = query(chatQuery);
export const cancel = mutation({
  args: { jobId: v.id("reviewedEmploymentJobs") }, returns: v.union(v.null(), projectionValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId); if (!job) return null;
    const owned = await ownerSession(ctx, job.externalId);
    if (!owned || owned.ownerId !== job.ownerId || owned.session._id !== job.sessionId) return null;
    if (!active(job)) return project(job);
    const now = Date.now(), expired = now >= job.terminalDeadlineAt;
    await ctx.db.patch(job._id, { status: expired ? "expired" : "cancelled", errorReason: expired ? "deadline_exceeded" : "cancelled", updatedAt: now });
    return project((await ctx.db.get(job._id))!);
  },
});
export const expire = internalMutation({
  args: { jobId: v.id("reviewedEmploymentJobs") }, returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job && active(job) && Date.now() >= job.terminalDeadlineAt) await ctx.db.patch(job._id, { status: "expired", errorReason: "deadline_exceeded", updatedAt: Date.now() });
    return null;
  },
});
function reservationFrom(value: unknown): ReviewedEmploymentJobReservation | null {
  if (!object(value) || !exact(value, ["stage", "requestSha256", "candidateSha256", "sourceBinding"])
    || !REVIEWED_EMPLOYMENT_JOB_STAGES.includes(value.stage as typeof REVIEWED_EMPLOYMENT_JOB_STAGES[number])
    || !hash(value.requestSha256) || !hash(value.sourceBinding) || (value.candidateSha256 !== null && !hash(value.candidateSha256))) return null;
  return value as unknown as ReviewedEmploymentJobReservation;
}

/** Public transport for the server worker, authenticated by a fresh, domain-
 * separated HMAC rather than a browser JWT. Every mutation binds exact body bytes.
 * A claimed stage is never retried or taken over, including uncertain failures. */
export const worker = mutation({
  args: { jobId: v.id("reviewedEmploymentJobs"), workerId: v.string(), operation: v.union(v.literal("claim"), v.literal("state"), v.literal("authority"),
    v.literal("reserve"), v.literal("passed"), v.literal("fail"), v.literal("commit")), body: v.string(), issuedAt: v.number(), serviceProof: v.string(),
    publicationFilterProtocol: v.optional(v.literal(PUBLICATION_FILTER_PROTOCOL)) },
  returns: resultValidator,
  handler: async (ctx, args): Promise<Infer<typeof resultValidator>> => {
    const now = Date.now();
    if (!identifier(args.workerId) || !fresh(args.issuedAt, now) || new TextEncoder().encode(args.body).byteLength > MAX_BODY_BYTES) return ignored();
    try { if (!await verifyTelemetryServiceProof(args.serviceProof, await reviewedEmploymentJobProofParts(args))) return ignored(); } catch { return ignored(); }
    const job = await ctx.db.get(args.jobId); if (!job || !active(job)) return ignored();
    if (now >= job.terminalDeadlineAt) {
      await ctx.db.patch(job._id, { status: "expired", errorReason: "deadline_exceeded", updatedAt: now }); return ignored();
    }
    let body: unknown; try { body = JSON.parse(args.body); } catch { return ignored(); }
    // Disabling execution stops live polling and every new provider reservation,
    // pass and commit. Owner read/cancel and fail/expiry remain available, so a
    // rollback cannot orphan an accepted job or replay an uncertain stage.
    if (args.operation !== "fail" && (!reviewedEmploymentBackendExecutionAllowed(process.env)
      || !reviewedEmploymentBackendJobPolicyMatches(process.env, job.policyId))) return ignored();
    if (args.operation === "claim") {
      if (!object(body) || !exact(body, []) || job.workerId !== undefined || job.status !== "queued" || now >= job.verificationDeadlineAt) return ignored();
      try { if (!await sourceAuthority(ctx, job, args.publicationFilterProtocol)) return ignored(); } catch { return ignored(); }
      await ctx.db.patch(job._id, { status: "running", progress: "draft", workerId: args.workerId, updatedAt: now });
      return ok({ jobId: job._id, submission: job.submission, createdAt: job.createdAt, verificationDeadlineAt: job.verificationDeadlineAt,
        terminalDeadlineAt: job.terminalDeadlineAt, externalId: job.externalId, jurisdictionId: job.jurisdictionId,
        userClientId: job.userClientId, assistantClientId: job.assistantClientId,
        ...(job.policyId === undefined ? {} : { policyId: job.policyId }) });
    }
    if (job.workerId !== args.workerId || job.status !== "running") return ignored();
    if (args.operation === "fail") {
      if (!object(body) || !exact(body, ["reason"]) || !REVIEWED_EMPLOYMENT_JOB_ERRORS.includes(body.reason as typeof REVIEWED_EMPLOYMENT_JOB_ERRORS[number])) return ignored();
      const reason = body.reason as typeof REVIEWED_EMPLOYMENT_JOB_ERRORS[number];
      await ctx.db.patch(job._id, { status: reason === "deadline_exceeded" ? "expired" : "blocked", errorReason: reason, updatedAt: now });
      return ok(project((await ctx.db.get(job._id))!));
    }
    if (args.operation === "state") {
      if (!object(body) || !exact(body, [])) return ignored();
      try { await currentPrincipal(ctx, job); } catch { return ignored(); }
      return ok(project(job));
    }
    if (args.operation === "authority") {
      if (!object(body) || !exact(body, [])) return ignored();
      try { const authority = await sourceAuthority(ctx, job, args.publicationFilterProtocol); return authority ? ok({ source: authority.source, manifest: authority.manifest }) : ignored(); } catch { return ignored(); }
    }
    if (args.operation === "reserve" || args.operation === "passed") {
      if (now >= job.verificationDeadlineAt) return ignored();
      const input = reservationFrom(body); if (!input) return ignored();
      try { if (!await sourceAuthority(ctx, job, args.publicationFilterProtocol)) return ignored(); } catch { return ignored(); }
      const ordinal = REVIEWED_EMPLOYMENT_JOB_STAGES.indexOf(input.stage);
      const predecessor = ordinal >= 2 ? "inventory" : "draft";
      const prior = ordinal > 0 ? await ctx.db.query("reviewedEmploymentJobStages").withIndex("by_jobId_and_stage", q => q.eq("jobId", job._id).eq("stage", predecessor)).unique() : null;
      if (ordinal > 0 && (prior?.status !== "passed" || !job.candidateSha256 || input.candidateSha256 !== job.candidateSha256 || input.sourceBinding !== job.sourceBinding)) return ignored();
      const stage = await ctx.db.query("reviewedEmploymentJobStages").withIndex("by_jobId_and_stage", q => q.eq("jobId", job._id).eq("stage", input.stage)).unique();
      if (args.operation === "reserve") {
        if (stage || (input.stage === "draft" && input.candidateSha256 !== null)) return ignored();
        await ctx.db.insert("reviewedEmploymentJobStages", { jobId: job._id, ...input, status: "reserved", reservedAt: now });
        await ctx.db.patch(job._id, { progress: input.stage, ...(input.stage === "draft" ? { sourceBinding: input.sourceBinding } : {}), updatedAt: now });
      } else {
        if (!stage || stage.status !== "reserved" || stage.requestSha256 !== input.requestSha256 || stage.sourceBinding !== input.sourceBinding
          || input.candidateSha256 === null || (input.stage !== "draft" && stage.candidateSha256 !== input.candidateSha256)) return ignored();
        await ctx.db.patch(stage._id, { status: "passed", candidateSha256: input.candidateSha256, passedAt: now });
        let progress: Doc<"reviewedEmploymentJobs">["progress"] = ordinal < 2 ? REVIEWED_EMPLOYMENT_JOB_STAGES[ordinal + 1] : "commit";
        if (ordinal >= 2) {
          const otherStage = input.stage === "consent" ? "overtime" : "consent";
          const other = await ctx.db.query("reviewedEmploymentJobStages").withIndex("by_jobId_and_stage", q => q.eq("jobId", job._id).eq("stage", otherStage)).unique();
          if (other?.status !== "passed") progress = otherStage;
        }
        await ctx.db.patch(job._id, { progress,
          ...(input.stage === "draft" ? { candidateSha256: input.candidateSha256 } : {}), updatedAt: now });
      }
      return ok(project((await ctx.db.get(job._id))!));
    }
    if (args.operation === "commit") {
      if (!object(body) || !exact(body, ["completion", "source", "user"]) || !object(body.completion) || !object(body.source) || !object(body.user)) return ignored();
      const input = body as unknown as ReviewedEmploymentCommitInput, submission = submissionFrom(job.submission);
      if (input.completion.externalId !== job.externalId || input.completion.jurisdictionId !== job.jurisdictionId
        || input.completion.assistantClientId !== job.assistantClientId || input.completion.routeNonce !== submission.routeNonce
        || input.user.clientId !== job.userClientId || input.user.content !== submission.query
        || JSON.stringify(input.user.attachmentIds) !== JSON.stringify(submission.attachmentIds)
        || JSON.stringify(input.completion.attachmentIds) !== JSON.stringify(submission.contextAttachmentIds)
        || typeof input.completion.finalAnswer !== "string" || await sha256(input.completion.finalAnswer) !== job.candidateSha256) return ignored();
      const stages = await Promise.all(REVIEWED_EMPLOYMENT_JOB_STAGES.map(stage => ctx.db.query("reviewedEmploymentJobStages")
        .withIndex("by_jobId_and_stage", q => q.eq("jobId", job._id).eq("stage", stage)).unique()));
      if (stages.some(stage => !stage || stage.status !== "passed" || stage.candidateSha256 !== job.candidateSha256 || stage.sourceBinding !== job.sourceBinding)) return ignored();
      let authority: Awaited<ReturnType<typeof sourceAuthority>>;
      try { authority = await sourceAuthority(ctx, job, args.publicationFilterProtocol); } catch { return ignored(); }
      if (!authority || await sha256(reviewedEmploymentSourceBundleCanonicalJson({ source: authority.source, manifest: authority.manifest })) !== job.sourceBinding) return ignored();
      const principal = authority.principal;
      const serviceProof = await createTelemetryServiceProof(await reviewedEmploymentCommitProofParts(input));
      // Let errors escape: failed atomic completion must roll back its telemetry,
      // claim, both messages and provenance, as well as the terminal job update.
      const completion = await commitReviewedEmploymentForJobPrincipal(ctx, { ...input, serviceProof }, principal, job._id);
      await ctx.db.patch(job._id, { status: "succeeded", progress: "complete", updatedAt: now });
      return ok(completion);
    }
    return ignored();
  },
});

/** The owner deletion removes the session first, closing every worker operation.
 * Cleanup then erases copied private context and reservations in bounded batches. */
export const deleteForChatBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") }, returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.sessionId)) return null;
    const jobs = await ctx.db.query("reviewedEmploymentJobs")
      .withIndex("by_sessionId_and_status", q => q.eq("sessionId", args.sessionId)).take(25);
    for (const job of jobs) {
      const stages = await ctx.db.query("reviewedEmploymentJobStages")
        .withIndex("by_jobId_and_stage", q => q.eq("jobId", job._id)).take(4);
      for (const stage of stages) await ctx.db.delete(stage._id);
      await ctx.db.delete(job._id);
    }
    if (jobs.length === 25) await ctx.scheduler.runAfter(0,
      makeFunctionReference<"mutation", { sessionId: Id<"chatSessions"> }, null>("reviewedEmploymentJobs:deleteForChatBatch"), args);
    return null;
  },
});
