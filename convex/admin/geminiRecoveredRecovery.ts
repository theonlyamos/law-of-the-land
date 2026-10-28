import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { validateAuditReason, writeAudit } from "./audit";
import { assertPublisherAuthority, attemptCorrelation, digest, recoveryContext } from "./geminiRecovery";
import {
  assertCurrentLease, assertGeminiExecutionPermit, isGeminiJobDocument, succeedGeminiJob, type GeminiIntegrationJob,
} from "./jobs";
import { applyGeminiIndexCompletion } from "./publicationState";
import type { DiagnosticTarget } from "./integrations/geminiDiagnostic";

// Finishes a first publication whose document was confirmed STATE_FAILED and later became ACTIVE.
// The failed-document recovery cannot apply then (it needs the document still failed and the
// operation still pending), and the ordinary poller never resumes a job with failed evidence.
const RECOVERY_ACTOR = "gemini_recovery";
const RECOVERY_ACTION = "gemini_recovered_document_recovery";
const MAX_PROOF_AGE_MS = 30_000;
const RECOVERY_LEASE_MS = 15 * 60_000;
const HASH_REFERENCE = /^sha256:[a-f0-9]{64}$/;
const resultValidator = v.object({
  status: v.union(v.literal("succeeded"), v.literal("failed")),
  jobId: v.id("integrationJobs"), correlationId: v.string(),
});
const targetValidator = v.object({
  storeName: v.string(), operationName: v.string(),
  metadata: v.object({ environment: v.string(), jurisdiction_id: v.string(), resource_id: v.string(),
    version_id: v.string(), version_number: v.string(), sha256: v.string() }),
});
const attemptArgs = {
  operationId: v.id("adminOperations"), leaseToken: v.string(), binding: v.string(),
  jurisdictionId: v.id("jurisdictions"),
};
export type RecoveredDocumentRecoveryResult = Infer<typeof resultValidator>;
type Attempt = { operationId: Id<"adminOperations">; leaseToken: string; binding: string; jurisdictionId: Id<"jurisdictions"> };
export type RecoveredDocumentRecoveryClaim =
  | { kind: "completed"; result: RecoveredDocumentRecoveryResult }
  | ({ kind: "claimed"; target: DiagnosticTarget; failedDocumentReference: string } & Attempt);

function invalid(): never { throw new ConvexError("GEMINI_RECOVERED_DOCUMENT_RECOVERY_INVALID"); }

async function reference(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function recoveredContext(ctx: MutationCtx, job: GeminiIntegrationJob, now: number) {
  const evidence = job.failedDocumentEvidence;
  // Evidence with verified coverage means the version was already excluded and blocked.
  if (!evidence || evidence.coverageVerifiedAt !== undefined || evidence.observedDocumentState !== "STATE_FAILED" ||
      !HASH_REFERENCE.test(evidence.documentReference) || !job.providerOperationName ||
      evidence.operationReference !== await reference(job.providerOperationName)) invalid();
  const base = await recoveryContext(ctx, job, now);
  const binding = await digest({ base: base.binding, evidence });
  return { target: base.target, binding, jurisdictionId: base.jurisdictionId, failedDocumentReference: evidence.documentReference };
}

function terminalResult(operation: Doc<"adminOperations">, jobId: Id<"integrationJobs">): RecoveredDocumentRecoveryResult | null {
  if (operation.status === "pending") return null;
  if ((operation.status !== "succeeded" && operation.status !== "failed") ||
      operation.result?.status !== operation.status || operation.result.action !== RECOVERY_ACTION ||
      operation.result.targetId !== jobId || operation.result.correlationId !== operation.correlationId) invalid();
  return { status: operation.status, jobId, correlationId: operation.correlationId };
}

async function loadAttempt(ctx: MutationCtx, args: Attempt) {
  const operation = await ctx.db.get(args.operationId);
  if (!operation || operation.actorId !== RECOVERY_ACTOR || operation.action !== RECOVERY_ACTION ||
      operation.correlationId !== await attemptCorrelation(args)) invalid();
  const jobId = ctx.db.normalizeId("integrationJobs", operation.targetId);
  if (!jobId) invalid();
  return { operation, jobId };
}

async function finishReceipt(ctx: MutationCtx, operation: Doc<"adminOperations">, jobId: Id<"integrationJobs">, status: "succeeded" | "failed") {
  const request: { jobId?: unknown; reason?: unknown } = JSON.parse(operation.requestFingerprint);
  if (request.jobId !== jobId || typeof request.reason !== "string") invalid();
  const reason = validateAuditReason(request.reason);
  await ctx.db.patch(operation._id, { status, result: { status, correlationId: operation.correlationId,
    action: RECOVERY_ACTION, targetId: jobId }, updatedAt: Date.now() });
  await writeAudit(ctx, { actorId: RECOVERY_ACTOR, actorRoles: [], action: status === "succeeded"
    ? "document.publish.recovered_document_reconciled" : "document.publish.recovered_document_reconciliation_failed",
  targetType: "integrationJob", targetId: jobId, reason, correlationId: operation.correlationId,
  outcome: status === "succeeded" ? "success" : "failure" },
  { actorType: "system", actorUserId: "system", metadata: { method: "recovered_document_reconciliation",
    ...(status === "succeeded" ? { evidence: "failed_document_now_active_and_operation_completed" } : {}) } });
  return { status, jobId, correlationId: operation.correlationId };
}

/** A job with failed-document evidence is never claimable by the ordinary runner. */
async function claimRecoveryLease(ctx: MutationCtx, job: GeminiIntegrationJob, jurisdictionId: Id<"jurisdictions">) {
  const now = Date.now();
  if (job.status !== "manual_review" || job.leaseToken !== undefined || job.leaseExpiresAt !== undefined ||
      (job.nextAttemptAt !== undefined && job.nextAttemptAt > now)) invalid();
  const jurisdiction = await ctx.db.get(jurisdictionId);
  if (!jurisdiction) invalid();
  if (jurisdiction.geminiExecutionPermit !== undefined) throw new ConvexError("GEMINI_EXECUTION_BUSY");
  const leaseToken = `lease_${crypto.randomUUID().replaceAll("-", "")}`;
  const leaseExpiresAt = now + RECOVERY_LEASE_MS;
  const claimedJob: GeminiIntegrationJob = { ...job, status: "running", leaseToken, leaseExpiresAt, nextAttemptAt: leaseExpiresAt, updatedAt: now };
  await ctx.db.patch(jurisdiction._id, { contentRevision: (jurisdiction.contentRevision ?? 0) + 1,
    geminiExecutionPermit: { jobId: job._id, leaseExpiresAt } });
  await ctx.db.patch(job._id, { status: "running", leaseToken, leaseExpiresAt, nextAttemptAt: leaseExpiresAt, updatedAt: now });
  return { leaseToken, job: claimedJob };
}

export const claimRecoveredDocumentRecovery = internalMutation({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: v.union(v.object({ kind: v.literal("completed"), result: resultValidator }), v.object({
    kind: v.literal("claimed"), ...attemptArgs, target: targetValidator, failedDocumentReference: v.string(),
  })),
  handler: async (ctx, args): Promise<RecoveredDocumentRecoveryClaim> => {
    const reason = validateAuditReason(args.reason);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(args.idempotencyKey)) throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
    const job = await ctx.db.get(args.jobId);
    if (!job || !isGeminiJobDocument(job)) invalid();
    await assertPublisherAuthority(ctx, job);
    const fingerprint = JSON.stringify({ action: RECOVERY_ACTION, jobId: job._id, reason });
    const operations = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey",
      q => q.eq("actorId", RECOVERY_ACTOR).eq("idempotencyKey", args.idempotencyKey)).take(2);
    if (operations.length > 1) invalid();
    if (operations[0]) {
      const operation = operations[0];
      if (operation.action !== RECOVERY_ACTION || operation.targetId !== job._id || operation.requestFingerprint !== fingerprint) {
        throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
      }
      const result = terminalResult(operation, job._id);
      if (result) return { kind: "completed", result };
      throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
    }
    if (job.status !== "manual_review" || job.leaseToken !== undefined || job.leaseExpiresAt !== undefined) invalid();
    const initial = await recoveredContext(ctx, job, Date.now());
    const claim = await claimRecoveryLease(ctx, job, initial.jurisdictionId);
    const context = await recoveredContext(ctx, claim.job, Date.now());
    const attempt = { leaseToken: claim.leaseToken, binding: context.binding, jurisdictionId: context.jurisdictionId };
    const correlationId = await attemptCorrelation(attempt);
    const now = Date.now();
    const operationId = await ctx.db.insert("adminOperations", { actorId: RECOVERY_ACTOR, action: RECOVERY_ACTION,
      targetId: job._id, idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint, correlationId,
      status: "pending", createdAt: now, updatedAt: now });
    return { kind: "claimed", operationId, ...attempt, target: context.target, failedDocumentReference: context.failedDocumentReference };
  },
});

/** Evidence comes only from the internal server-side verifier, never a browser result. */
export const completeRecoveredDocumentRecovery = internalMutation({
  args: { ...attemptArgs, documentName: v.string(), verifiedAt: v.number() },
  returns: resultValidator,
  handler: async (ctx, args): Promise<RecoveredDocumentRecoveryResult> => {
    const { operation, jobId } = await loadAttempt(ctx, args);
    const replay = terminalResult(operation, jobId);
    if (replay) return replay;
    const now = Date.now();
    if (!Number.isFinite(args.verifiedAt) || args.verifiedAt < operation.createdAt || args.verifiedAt > now ||
        now - args.verifiedAt > MAX_PROOF_AGE_MS) invalid();
    const job = await ctx.db.get(jobId);
    if (!job || !isGeminiJobDocument(job)) invalid();
    assertCurrentLease(job, args.leaseToken, now);
    const jurisdiction = await assertGeminiExecutionPermit(ctx, job, now);
    await assertPublisherAuthority(ctx, job);
    const current = await recoveredContext(ctx, job, now);
    if (current.binding !== args.binding || current.jurisdictionId !== args.jurisdictionId || jurisdiction?._id !== args.jurisdictionId ||
        await reference(args.documentName) !== current.failedDocumentReference) invalid();
    // Reuse the atomic first-publication effects that the ordinary poller applies.
    const replacement = await applyGeminiIndexCompletion(ctx, job, args.documentName, now);
    if (replacement !== null) invalid();
    await succeedGeminiJob(ctx, job, jurisdiction, now);
    // The tombstone marks an unresolved provider operation; this one is now resolved.
    await ctx.db.patch(job._id, { failedDocumentEvidence: undefined });
    return await finishReceipt(ctx, operation, jobId, "succeeded");
  },
});

/** Cleanup deliberately remains possible after authority, bindings, or the lease expire. */
export const abortRecoveredDocumentRecovery = internalMutation({
  args: attemptArgs, returns: resultValidator,
  handler: async (ctx, args): Promise<RecoveredDocumentRecoveryResult> => {
    const { operation, jobId } = await loadAttempt(ctx, args);
    const replay = terminalResult(operation, jobId);
    if (replay) return replay;
    const job = await ctx.db.get(jobId);
    if (job?.status === "running" && job.leaseToken === args.leaseToken) {
      const jurisdiction = await ctx.db.get(args.jurisdictionId);
      const permit = jurisdiction?.geminiExecutionPermit;
      if (jurisdiction && permit?.jobId === job._id && permit.leaseExpiresAt === job.leaseExpiresAt) {
        await ctx.db.patch(jurisdiction._id, { geminiExecutionPermit: undefined, contentRevision: (jurisdiction.contentRevision ?? 0) + 1 });
      }
      await ctx.db.patch(job._id, { status: "manual_review", leaseToken: undefined, leaseExpiresAt: undefined,
        nextAttemptAt: undefined, updatedAt: Date.now() });
    }
    return await finishReceipt(ctx, operation, jobId, "failed");
  },
});
