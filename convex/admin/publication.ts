import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { hashCallbackToken, persistJob } from "./jobs";

const resultValidator = v.object({
  jobId: v.id("integrationJobs"),
  type: v.union(v.literal("groundx_copy"), v.literal("groundx_delete")),
  duplicate: v.boolean(),
  correlationId: v.string(),
});
type Actor = { userId: string; roles: AdminRole[] };
type Operation = "publish" | "unpublish" | "rollback";

async function existingPublication(
  ctx: MutationCtx,
  actor: Actor,
  input: { versionId: Id<"documentVersions">; idempotencyKey: string; reasonDigest: string },
  operation: Operation,
) {
  const jobs = await ctx.db.query("integrationJobs")
    .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.userId).eq("idempotencyKey", input.idempotencyKey))
    .take(2);
  if (jobs.length > 1) throw new ConvexError("INTEGRATION_IDEMPOTENCY_STATE_INVALID");
  const job = jobs[0];
  if (!job) return null;
  let payload: unknown;
  try { payload = JSON.parse(job.payload); } catch { throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT"); }
  const record = payload as Record<string, unknown>;
  const expectedType = operation === "unpublish" ? "delete_documents" : "copy_documents";
  if (
    job.targetType !== "documentVersion" || job.targetId !== input.versionId || job.type !== expectedType ||
    !payload || typeof payload !== "object" || record.operation !== operation || record.reasonDigest !== input.reasonDigest
  ) {
    throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT");
  }
  return {
    jobId: job._id,
    type: operation === "unpublish" ? "groundx_delete" as const : "groundx_copy" as const,
    duplicate: true,
    correlationId: job.correlationId,
  };
}

function bucketId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new ConvexError("GROUNDX_BUCKET_NOT_CONFIGURED");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ConvexError("GROUNDX_BUCKET_NOT_CONFIGURED");
  return parsed;
}

function validKey(value: string): string {
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}

async function consumeStepUp(
  ctx: MutationCtx,
  actorId: string,
  sessionId: string,
  action: string,
  targetId: string,
  idempotencyKey: string,
) {
  const proofs = await ctx.db.query("adminStepUpProofs")
    .withIndex("by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey", (q) => q
      .eq("actorId", actorId).eq("sessionId", sessionId).eq("action", action)
      .eq("targetId", targetId).eq("idempotencyKey", idempotencyKey))
    .take(2);
  if (proofs.length !== 1 || proofs[0].consumedAt !== undefined || proofs[0].expiresAt <= Date.now() || Date.now() - proofs[0].issuedAt > 300_000) {
    throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  }
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
}

async function assertNoOtherActiveJob(ctx: MutationCtx, versionId: Id<"documentVersions">, ownJobId: Id<"integrationJobs">) {
  const jobs = await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "documentVersion").eq("targetId", versionId))
    .take(26);
  if (jobs.some((job) => job._id !== ownJobId && ["queued", "running", "waiting_callback"].includes(job.status))) {
    throw new ConvexError("DOCUMENT_PUBLICATION_IN_PROGRESS");
  }
}

async function queuePublication(
  ctx: MutationCtx,
  actor: Actor,
  args: { versionId: Id<"documentVersions">; confirmation: string; reason: string; idempotencyKey: string },
  operation: Operation,
) {
  validateAuditReason(args.reason);
  validKey(args.idempotencyKey);
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject !== actor.userId || typeof identity.sessionId !== "string") {
    throw new ConvexError("ADMIN_AUTH_REQUIRED");
  }
  const expectedConfirmation = `${operation.toUpperCase()} ${args.versionId}`;
  if (args.confirmation !== expectedConfirmation) throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
  const reasonDigest = await hashCallbackToken(args.reason);
  const existing = await existingPublication(ctx, actor, {
    versionId: args.versionId,
    idempotencyKey: args.idempotencyKey,
    reasonDigest,
  }, operation);
  if (existing) return existing;
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  const resource = await ctx.db.get(version.resourceId);
  if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
  const jurisdiction = await ctx.db.get(resource.jurisdictionId);
  if (!jurisdiction || jurisdiction.status !== "enabled") throw new ConvexError("JURISDICTION_NOT_ENABLED");
  if (resource.status !== "active") throw new ConvexError("RESOURCE_NOT_ACTIVE");
  const previousVersionId = resource.activeVersionId;
  const payload = operation === "unpublish"
    ? { documentIds: [version.groundxProductionDocumentId], operation, ...(previousVersionId ? { previousVersionId } : {}) }
    : {
        fromBucket: bucketId(jurisdiction.stagingBucketId),
        toBucket: bucketId(jurisdiction.productionBucketId),
        documentIds: [version.groundxStagingDocumentId],
        operation,
        ...(previousVersionId ? { previousVersionId } : {}),
      };
  if (payload.documentIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new ConvexError("GROUNDX_DOCUMENT_NOT_READY");
  }
  const queued = await persistJob(ctx, {
    type: operation === "unpublish" ? "delete_documents" : "copy_documents",
    targetType: "documentVersion",
    targetId: version._id,
    payload: { ...payload, reasonDigest },
    idempotencyKey: args.idempotencyKey,
  }, { id: actor.userId, roles: actor.roles });
  const job = await ctx.db.get(queued.jobId);
  if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
  if (queued.duplicate) {
    return { jobId: job._id, type: operation === "unpublish" ? "groundx_delete" as const : "groundx_copy" as const, duplicate: true, correlationId: job.correlationId };
  }
  await assertNoOtherActiveJob(ctx, version._id, job._id);
  const requiredState = operation === "publish" ? "approved" : operation === "rollback" ? "superseded" : "published";
  if (version.status !== requiredState) throw new ConvexError("DOCUMENT_TRANSITION_INVALID");
  if (operation === "unpublish" && resource.activeVersionId !== version._id) throw new ConvexError("DOCUMENT_ACTIVE_POINTER_INVALID");
  if (operation === "rollback" && (!resource.activeVersionId || resource.activeVersionId === version._id)) throw new ConvexError("DOCUMENT_ROLLBACK_TARGET_INVALID");
  await consumeStepUp(ctx, actor.userId, identity.sessionId, `document_${operation}`, version._id, args.idempotencyKey);
  if (operation !== "unpublish") await ctx.db.patch(version._id, { status: "publishing", failureSummary: undefined, updatedAt: Date.now() });
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: `document.${operation}.queued`,
    targetType: "documentVersion",
    targetId: version._id,
    reason: args.reason,
    correlationId: job.correlationId,
    outcome: "success",
  });
  return { jobId: job._id, type: operation === "unpublish" ? "groundx_delete" as const : "groundx_copy" as const, duplicate: false, correlationId: job.correlationId };
}

const args = {
  versionId: v.id("documentVersions"),
  confirmation: v.string(),
  reason: v.string(),
  idempotencyKey: v.string(),
};

export const publishVersion = mutation({
  args, returns: resultValidator,
  handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "publish"), values, "publish"),
});
export const unpublishVersion = mutation({
  args, returns: resultValidator,
  handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "publish"), values, "unpublish"),
});
export const rollbackVersion = mutation({
  args, returns: resultValidator,
  handler: async (ctx, values) => queuePublication(ctx, await requireEnabledAdminPermission(ctx, "document", "rollback"), values, "rollback"),
});
