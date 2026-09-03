import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { isGeminiDocumentName, isGeminiFileSearchStoreName } from "../lib/geminiFileSearchNames";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { hashJobValue, persistJob } from "./jobs";

const resultValidator = v.object({
  jobId: v.id("integrationJobs"),
  type: v.union(v.literal("gemini_index"), v.literal("gemini_delete")),
  duplicate: v.boolean(),
  correlationId: v.string(),
});
type Actor = { userId: string; roles: AdminRole[] };
type Operation = "publish" | "unpublish" | "rollback";
const LIFECYCLE_LOCK_MS = 24 * 60 * 60_000;
const UNCERTAIN_RECHECK_MS = 15 * 60_000;
const expireLifecycleLockRef = makeFunctionReference<"mutation">("admin/publication:expireLifecycleLock");
const reconcileStaleJobsRef = makeFunctionReference<"mutation">("admin/jobs:reconcileStaleJobs");

function validKey(value: string): string {
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  return value;
}

async function assertNoStoreTeardown(ctx: MutationCtx, jurisdictionId: Id<"jurisdictions">) {
  const jobs = await Promise.all(([
    "queued", "running", "waiting_provider", "manual_review",
  ] as const).map(async (status) => await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId_and_type_and_status", (q) => q
      .eq("targetType", "jurisdictionGeminiStore")
      .eq("targetId", jurisdictionId)
      .eq("type", "gemini_delete_store")
      .eq("status", status))
    .take(1)));
  if (jobs.some((rows) => rows.length > 0)) {
    throw new ConvexError("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
  }
}

async function existingPublication(ctx: MutationCtx, actor: Actor, input: { versionId: Id<"documentVersions">; idempotencyKey: string; reasonDigest: string }, operation: Operation) {
  const jobs = await ctx.db.query("integrationJobs")
    .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.userId).eq("idempotencyKey", input.idempotencyKey)).take(2);
  if (jobs.length > 1) throw new ConvexError("INTEGRATION_IDEMPOTENCY_STATE_INVALID");
  const job = jobs[0];
  if (!job) return null;
  let payload: unknown;
  try { payload = JSON.parse(job.payload); } catch { throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT"); }
  const record = payload as Record<string, unknown>;
  const expectedType = operation === "unpublish" ? "gemini_delete_document" : "gemini_index_document";
  const payloadOperationMatches = operation === "publish"
    ? record.operation === "publish" || record.operation === "replace_index"
    : operation === "rollback"
      ? record.operation === "rollback_index"
      : record.operation === "unpublish";
  if (job.targetType !== "documentVersion" || job.targetId !== input.versionId || job.type !== expectedType || !payload || typeof payload !== "object" || !payloadOperationMatches || record.reasonDigest !== input.reasonDigest) throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT");
  return { jobId: job._id, type: operation === "unpublish" ? "gemini_delete" as const : "gemini_index" as const, duplicate: true, correlationId: job.correlationId };
}

async function consumeStepUp(ctx: MutationCtx, actorId: string, sessionId: string, action: string, targetId: string, idempotencyKey: string) {
  const proofs = await ctx.db.query("adminStepUpProofs")
    .withIndex("by_actorId_sessionId_action_targetId_idempotencyKey", (q) => q.eq("actorId", actorId).eq("sessionId", sessionId).eq("action", action).eq("targetId", targetId).eq("idempotencyKey", idempotencyKey)).take(2);
  if (proofs.length !== 1 || proofs[0].consumedAt !== undefined || proofs[0].expiresAt <= Date.now() || Date.now() - proofs[0].issuedAt > 300_000) throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
}

async function releaseLock(ctx: MutationCtx, lock: Doc<"documentLifecycleLocks">) {
  const current = await ctx.db.get(lock._id);
  if (current) await ctx.db.delete(lock._id);
}

function jobPayloadOperation(job: Doc<"integrationJobs">): string | undefined {
  try { const value = JSON.parse(job.payload) as { operation?: unknown }; return typeof value.operation === "string" ? value.operation : undefined; }
  catch { return undefined; }
}

async function restoreExpiredUnstartedIndex(ctx: MutationCtx, lock: Doc<"documentLifecycleLocks">, job: Doc<"integrationJobs">) {
  let payload: { operation?: unknown; previousVersionId?: unknown; storeName?: unknown; sha256?: unknown };
  try { payload = JSON.parse(job.payload) as typeof payload; }
  catch { throw new ConvexError("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID"); }
  const version = job.targetType === "documentVersion" ? await ctx.db.get(job.targetId as Id<"documentVersions">) : null;
  const resource = version ? await ctx.db.get(version.resourceId) : null;
  const jurisdiction = resource ? await ctx.db.get(resource.jurisdictionId) : null;
  const previousVersionId = typeof payload.previousVersionId === "string" ? payload.previousVersionId as Id<"documentVersions"> : undefined;
  const operationValid = lock.operation === "rollback"
    ? payload.operation === "rollback_index" && previousVersionId !== undefined
    : lock.operation === "publish" && (payload.operation === "publish" || payload.operation === "replace_index") && (payload.operation === "publish") === (previousVersionId === undefined);
  if (
    !version || !resource || !jurisdiction || job.targetId !== lock.versionId || version.resourceId !== lock.resourceId ||
    version.status !== "publishing" || version.geminiDocumentName !== undefined || version.sha256 !== payload.sha256 ||
    !operationValid || resource.activeVersionId !== previousVersionId ||
    jurisdiction.geminiFileSearchStoreName !== payload.storeName
  ) throw new ConvexError("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
  await ctx.db.patch(version._id, {
    status: lock.operation === "rollback" ? "superseded" : "approved",
    failureSummary: previousVersionId ? "Publishing failed. The previous published version is still active." : "Publishing failed. No version was published.",
    updatedAt: Date.now(),
  });
  await writeAudit(ctx, {
    actorId: job.actorId, actorRoles: job.actorRoles, action: `document.${lock.operation}.failure`,
    targetType: "documentVersion", targetId: version._id, correlationId: job.correlationId, outcome: "failure",
  });
}

async function cancelExpiredLock(ctx: MutationCtx, lock: Doc<"documentLifecycleLocks">) {
  if (lock.jobId) {
    const job = await ctx.db.get(lock.jobId);
    if (job && job.type === "gemini_delete_document" && jobPayloadOperation(job) === "replace_delete") return false;
    if (job && job.status === "queued" && job.leaseToken === undefined && job.leaseExpiresAt === undefined && job.providerOperationName === undefined) {
      await ctx.db.patch(job._id, { status: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined, updatedAt: Date.now() });
      if (job.type === "gemini_index_document") await restoreExpiredUnstartedIndex(ctx, lock, job);
    } else if (job && !["succeeded", "failed", "cancelled"].includes(job.status)) {
      return false;
    }
  }
  await releaseLock(ctx, lock);
  return true;
}

async function claimLifecycleLock(ctx: MutationCtx, input: { resourceId: Id<"legalResources">; versionId: Id<"documentVersions">; operation: Operation; actorId: string; idempotencyKey: string }) {
  const locks = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", input.resourceId)).take(2);
  if (locks.length > 1) throw new ConvexError("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
  if (locks[0]) {
    if (locks[0].expiresAt > Date.now() || !(await cancelExpiredLock(ctx, locks[0]))) throw new ConvexError("DOCUMENT_LIFECYCLE_BUSY");
  }
  const now = Date.now();
  return await ctx.db.insert("documentLifecycleLocks", { ...input, expiresAt: now + LIFECYCLE_LOCK_MS, createdAt: now, updatedAt: now });
}

async function queuePublication(ctx: MutationCtx, actor: Actor, args: { versionId: Id<"documentVersions">; confirmation: string; reason: string; idempotencyKey: string }, operation: Operation) {
  validateAuditReason(args.reason);
  validKey(args.idempotencyKey);
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject !== actor.userId || typeof identity.sessionId !== "string") throw new ConvexError("ADMIN_AUTH_REQUIRED");
  if (args.confirmation !== `${operation.toUpperCase()} ${args.versionId}`) throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
  const reasonDigest = await hashJobValue(args.reason);
  const existing = await existingPublication(ctx, actor, { versionId: args.versionId, idempotencyKey: args.idempotencyKey, reasonDigest }, operation);
  if (existing) return existing;
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  const resource = await ctx.db.get(version.resourceId);
  if (!resource || resource.status !== "active") throw new ConvexError("RESOURCE_NOT_ACTIVE");
  const jurisdiction = await ctx.db.get(resource.jurisdictionId);
  const storeName = jurisdiction?.geminiFileSearchStoreName;
  if (!jurisdiction || jurisdiction.status !== "enabled") throw new ConvexError("JURISDICTION_NOT_ENABLED");
  if (jurisdiction.providerSyncState !== "synced" || !storeName || !isGeminiFileSearchStoreName(storeName)) throw new ConvexError("GEMINI_STORE_NOT_READY");
  await assertNoStoreTeardown(ctx, jurisdiction._id);
  const requiredState = operation === "publish" ? "approved" : operation === "rollback" ? "superseded" : "published";
  if (version.status !== requiredState) throw new ConvexError("DOCUMENT_TRANSITION_INVALID");
  const previousVersionId = resource.activeVersionId;
  if (operation === "unpublish" && (previousVersionId !== version._id || !version.geminiDocumentName || !isGeminiDocumentName(version.geminiDocumentName) || !version.geminiDocumentName.startsWith(`${storeName}/documents/`))) throw new ConvexError("DOCUMENT_ACTIVE_POINTER_INVALID");
  if (operation === "rollback" && (!previousVersionId || previousVersionId === version._id)) throw new ConvexError("DOCUMENT_ROLLBACK_TARGET_INVALID");
  await consumeStepUp(ctx, actor.userId, identity.sessionId, `document_${operation}`, version._id, args.idempotencyKey);
  const lockId = await claimLifecycleLock(ctx, { resourceId: resource._id, versionId: version._id, operation, actorId: actor.userId, idempotencyKey: args.idempotencyKey });
  try {
    const queued = await persistJob(ctx, {
      type: operation === "unpublish" ? "gemini_delete_document" : "gemini_index_document",
      targetType: "documentVersion",
      targetId: version._id,
      payload: operation === "unpublish"
        ? { operation, storeName, documentName: version.geminiDocumentName!, reasonDigest }
        : {
            operation: operation === "rollback" ? "rollback_index" : previousVersionId ? "replace_index" : "publish",
            storeName,
            sha256: version.sha256,
            ...(previousVersionId ? { previousVersionId } : {}),
            reasonDigest,
          },
      idempotencyKey: args.idempotencyKey,
    }, { id: actor.userId, roles: actor.roles });
    const job = await ctx.db.get(queued.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    await ctx.db.patch(lockId, { jobId: job._id, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(LIFECYCLE_LOCK_MS, expireLifecycleLockRef, { lockId });
    if (operation !== "unpublish") await ctx.db.patch(version._id, { status: "publishing", failureSummary: undefined, updatedAt: Date.now() });
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: `document.${operation}.queued`, targetType: "documentVersion", targetId: version._id, reason: args.reason, correlationId: job.correlationId, outcome: "success" });
    return { jobId: job._id, type: operation === "unpublish" ? "gemini_delete" as const : "gemini_index" as const, duplicate: false, correlationId: job.correlationId };
  } catch (error) {
    const lock = await ctx.db.get(lockId);
    if (lock) await ctx.db.delete(lock._id);
    throw error;
  }
}

const args = { versionId: v.id("documentVersions"), confirmation: v.string(), reason: v.string(), idempotencyKey: v.string() };
export const publishVersion = mutation({ args, returns: resultValidator, handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "publish"), values, "publish") });
export const unpublishVersion = mutation({ args, returns: resultValidator, handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "publish"), values, "unpublish") });
export const rollbackVersion = mutation({ args, returns: resultValidator, handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "rollback"), values, "rollback") });

export const expireLifecycleLock = internalMutation({
  args: { lockId: v.id("documentLifecycleLocks") }, returns: v.null(),
  handler: async (ctx, args) => {
    const lock = await ctx.db.get(args.lockId);
    if (!lock || lock.expiresAt > Date.now()) return null;
    const job = lock.jobId ? await ctx.db.get(lock.jobId) : null;
    const released = await cancelExpiredLock(ctx, lock);
    if (!released) {
      const expiresAt = Date.now() + UNCERTAIN_RECHECK_MS;
      await ctx.db.patch(lock._id, { expiresAt, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, reconcileStaleJobsRef, {});
      await ctx.scheduler.runAfter(UNCERTAIN_RECHECK_MS, expireLifecycleLockRef, { lockId: lock._id });
      await writeAudit(ctx, { actorId: "system", actorRoles: [], action: "document.lifecycle_lock_uncertain", targetType: "legalResource", targetId: lock.resourceId, reason: "Provider outcome remains uncertain; resource stays locked", correlationId: job?.correlationId, outcome: "failure" }, { actorType: "system", actorUserId: "system", metadata: {} });
      return null;
    }
    await writeAudit(ctx, { actorId: "system", actorRoles: [], action: "document.lifecycle_lock_expired", targetType: "legalResource", targetId: lock.resourceId, reason: "Expired lifecycle operation cancelled safely", correlationId: job?.correlationId, outcome: "failure" }, { actorType: "system", actorUserId: "system", metadata: {} });
    return null;
  },
});
