import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { authComponent } from "../auth";
import { hasRolePermission, parseAdminRoles } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { readAdminEnabled } from "./featureFlags";
import {
  assertCurrentLease, assertGeminiExecutionPermit, assertGeminiOriginal, claimJobDocument,
  isGeminiJobDocument, succeedGeminiJob, type GeminiIntegrationJob,
} from "./jobs";
import { applyGeminiIndexCompletion, resolveGeminiPublicationWorkflow } from "./publicationState";
import type { DiagnosticTarget } from "./integrations/geminiDiagnostic";

const RECOVERY_ACTOR = "gemini_recovery";
const RECOVERY_ACTION = "gemini_active_document_recovery";
const MAX_PROOF_AGE_MS = 30_000;
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
export type ActiveDocumentRecoveryResult = Infer<typeof resultValidator>;
type Attempt = { operationId: Id<"adminOperations">; leaseToken: string; binding: string; jurisdictionId: Id<"jurisdictions"> };
export type ActiveDocumentRecoveryClaim =
  | { kind: "completed"; result: ActiveDocumentRecoveryResult }
  | ({ kind: "claimed"; target: DiagnosticTarget } & Attempt);

function invalid(): never { throw new ConvexError("GEMINI_ACTIVE_DOCUMENT_RECOVERY_INVALID"); }

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function attemptCorrelation(attempt: Omit<Attempt, "operationId">): Promise<string> {
  return `rec_${await digest({ leaseToken: attempt.leaseToken, binding: attempt.binding, jurisdictionId: attempt.jurisdictionId })}`;
}

/** Internal deployment authority does not impersonate the original publisher. */
async function assertPublisherAuthority(ctx: MutationCtx, job: GeminiIntegrationJob) {
  if (!(await readAdminEnabled(ctx))) throw new ConvexError("ADMIN_DISABLED");
  const publisher = await authComponent.getAnyUserById(ctx, job.actorId);
  if (!publisher || publisher.emailVerified !== true || publisher.twoFactorEnabled !== true || publisher.banned === true ||
      (!job.organizationId && !hasRolePermission(parseAdminRoles(publisher.role), "document", "publish"))) {
    throw new ConvexError("GEMINI_RECOVERY_PUBLISHER_UNAUTHORIZED");
  }
  // Organization membership is rechecked by resolveGeminiPublicationWorkflow.
}

async function recoveryContext(ctx: MutationCtx, job: GeminiIntegrationJob, now: number) {
  if (job.type !== "gemini_index_document" || job.targetType !== "documentVersion" ||
      job.recoveryKind !== "poll_operation" || !job.providerOperationName || job.knownStoreResult !== undefined) invalid();
  const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
  if (workflow.kind !== "index" || workflow.payload.operation !== "publish" || workflow.publicationOperation !== "publish" ||
      workflow.previous !== null || workflow.resource.activeVersionId !== undefined || workflow.resource.catalogPublished === true ||
      workflow.version.geminiDocumentName !== undefined ||
      (job.organizationId !== undefined && workflow.jurisdiction.organizationId !== job.organizationId)) invalid();
  if (workflow.lock.actorId !== job.actorId || workflow.lock.idempotencyKey !== job.idempotencyKey ||
      (workflow.lock.jurisdictionId !== undefined && workflow.lock.jurisdictionId !== workflow.jurisdiction._id)) invalid();
  await assertGeminiOriginal(ctx, workflow.version);
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!environment || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(environment) ||
      !/^[a-f0-9]{64}$/.test(workflow.version.sha256) ||
      !Number.isSafeInteger(workflow.version.versionNumber) || workflow.version.versionNumber < 1) invalid();
  const target: DiagnosticTarget = {
    storeName: workflow.storeName, operationName: job.providerOperationName,
    metadata: { environment, jurisdiction_id: workflow.jurisdiction._id, resource_id: workflow.resource._id,
      version_id: workflow.version._id, version_number: String(workflow.version.versionNumber), sha256: workflow.version.sha256 },
  };
  const binding = await digest({
    target, jobId: job._id, payload: job.payload, actorId: job.actorId, actorRoles: job.actorRoles,
    organizationId: job.organizationId, organizationRole: job.organizationRole,
    idempotencyKey: job.idempotencyKey, requestFingerprint: job.requestFingerprint, correlationId: job.correlationId,
    jobUpdatedAt: job.updatedAt, versionUpdatedAt: workflow.version.updatedAt, resourceUpdatedAt: workflow.resource.updatedAt,
    jurisdictionUpdatedAt: workflow.jurisdiction.updatedAt,
    originalStorageId: workflow.version.originalStorageId, byteSize: workflow.version.byteSize, mimeType: workflow.version.mimeType,
    lock: { id: workflow.lock._id, resourceId: workflow.lock.resourceId, versionId: workflow.lock.versionId,
      jobId: workflow.lock.jobId, actorId: workflow.lock.actorId, operation: workflow.lock.operation,
      idempotencyKey: workflow.lock.idempotencyKey, expiresAt: workflow.lock.expiresAt },
  });
  return { target, binding, jurisdictionId: workflow.jurisdiction._id };
}

function terminalResult(operation: Doc<"adminOperations">, jobId: Id<"integrationJobs">): ActiveDocumentRecoveryResult | null {
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
    ? "document.publish.reconciled" : "document.publish.reconciliation_failed", targetType: "integrationJob",
    targetId: jobId, reason, correlationId: operation.correlationId, outcome: status === "succeeded" ? "success" : "failure" },
  { actorType: "system", actorUserId: "system", metadata: { method: "active_document_reconciliation",
    ...(status === "succeeded" ? { evidence: "unique_active_document" } : {}) } });
  return { status, jobId, correlationId: operation.correlationId };
}

export const claimActiveDocumentRecovery = internalMutation({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: v.union(v.object({ kind: v.literal("completed"), result: resultValidator }), v.object({
    kind: v.literal("claimed"), ...attemptArgs, target: targetValidator,
  })),
  handler: async (ctx, args): Promise<ActiveDocumentRecoveryClaim> => {
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
    await recoveryContext(ctx, job, Date.now());
    const claim = await claimJobDocument(ctx, job, false, true);
    if (!claim) throw new ConvexError("GEMINI_EXECUTION_BUSY");
    const context = await recoveryContext(ctx, claim.job, Date.now());
    const attempt = { leaseToken: claim.leaseToken, binding: context.binding, jurisdictionId: context.jurisdictionId };
    const correlationId = await attemptCorrelation(attempt);
    const now = Date.now();
    const operationId = await ctx.db.insert("adminOperations", { actorId: RECOVERY_ACTOR, action: RECOVERY_ACTION,
      targetId: job._id, idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint, correlationId,
      status: "pending", createdAt: now, updatedAt: now });
    return { kind: "claimed", operationId, ...attempt, target: context.target };
  },
});

/** Evidence comes only from the internal server-side verifier, never a browser result. */
export const completeActiveDocumentRecovery = internalMutation({
  args: { ...attemptArgs, documentName: v.string(), verifiedAt: v.number() },
  returns: resultValidator,
  handler: async (ctx, args): Promise<ActiveDocumentRecoveryResult> => {
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
    const current = await recoveryContext(ctx, job, now);
    if (current.binding !== args.binding || current.jurisdictionId !== args.jurisdictionId || jurisdiction?._id !== args.jurisdictionId) invalid();
    // Reuse the atomic first-publication effects, without fabricating operation completion.
    const replacement = await applyGeminiIndexCompletion(ctx, job, args.documentName, now);
    if (replacement !== null) invalid();
    await succeedGeminiJob(ctx, job, jurisdiction, now);
    return await finishReceipt(ctx, operation, jobId, "succeeded");
  },
});

/** Cleanup deliberately remains possible after authority, bindings, or the lease expire. */
export const abortActiveDocumentRecovery = internalMutation({
  args: attemptArgs, returns: resultValidator,
  handler: async (ctx, args): Promise<ActiveDocumentRecoveryResult> => {
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
