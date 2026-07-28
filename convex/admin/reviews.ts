import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { writeAudit, validateAuditReason } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MIN_KEY = 8;
const MAX_KEY = 128;
const MAX_EVALUATION_ID = 128;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_EVALUATION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const checklistValidator = v.object({
  sourceAuthentic: v.boolean(),
  metadataAccurate: v.boolean(),
  extractionReviewed: v.boolean(),
  citationsVerified: v.boolean(),
  evaluationPassed: v.boolean(),
});
const operationResultValidator = v.object({
  status: v.union(v.literal("ready_for_review"), v.literal("approved"), v.literal("rejected")),
  correlationId: v.string(),
  versionId: v.id("documentVersions"),
});
type Checklist = {
  sourceAuthentic: boolean;
  metadataAccurate: boolean;
  extractionReviewed: boolean;
  citationsVerified: boolean;
  evaluationPassed: boolean;
};
type Actor = { userId: string; roles: AdminRole[] };
type ReviewResult = {
  status: "ready_for_review" | "approved" | "rejected";
  correlationId: string;
  versionId: Id<"documentVersions">;
};

function validateKey(value: string) {
  if (value.length < MIN_KEY || value.length > MAX_KEY || !SAFE_KEY.test(value)) {
    throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  }
}

function validateEvaluation(value: string): string {
  if (!value || value.length > MAX_EVALUATION_ID || !SAFE_EVALUATION.test(value)) {
    throw new ConvexError("DOCUMENT_EVALUATION_INVALID");
  }
  return value;
}

function fingerprint(payload: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
}

async function beginReviewOperation(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    action: string;
    versionId: Id<"documentVersions">;
    reason: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<{ replay: true; result: ReviewResult } | { replay: false; operationId: Id<"adminOperations">; correlationId: string }> {
  validateAuditReason(input.reason);
  validateKey(input.idempotencyKey);
  const requestFingerprint = fingerprint(input.payload);
  const existing = await ctx.db.query("adminOperations")
    .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.userId).eq("idempotencyKey", input.idempotencyKey))
    .take(2);
  if (existing.length > 1) throw new ConvexError("DOCUMENT_IDEMPOTENCY_STATE_INVALID");
  if (existing[0]) {
    if (existing[0].action !== input.action || existing[0].targetId !== input.versionId || existing[0].requestFingerprint !== requestFingerprint) {
      throw new ConvexError("DOCUMENT_IDEMPOTENCY_CONFLICT");
    }
    if (!existing[0].result) throw new ConvexError("DOCUMENT_OPERATION_IN_PROGRESS");
    return {
      replay: true,
      result: {
        status: existing[0].result.status === "succeeded"
          ? input.action === "document_submit" ? "ready_for_review" : input.action === "document_approve" ? "approved" : "rejected"
          : "rejected",
        correlationId: existing[0].correlationId,
        versionId: input.versionId,
      },
    };
  }
  const now = Date.now();
  const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
  const operationId = await ctx.db.insert("adminOperations", {
    actorId: actor.userId,
    action: input.action,
    targetId: input.versionId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    correlationId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return { replay: false, operationId, correlationId };
}

async function finishReviewOperation(
  ctx: MutationCtx,
  actor: Actor,
  operation: { operationId: Id<"adminOperations">; correlationId: string },
  input: { action: string; versionId: Id<"documentVersions">; reason: string; status: ReviewResult["status"] },
): Promise<ReviewResult> {
  const result = { status: input.status, correlationId: operation.correlationId, versionId: input.versionId };
  await ctx.db.patch(operation.operationId, {
    status: "succeeded",
    result: { status: "succeeded", correlationId: operation.correlationId, action: input.action, targetId: input.versionId },
    updatedAt: Date.now(),
  });
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: input.action.replace("_", "."),
    targetType: "documentVersion",
    targetId: input.versionId,
    reason: input.reason,
    afterSummary: JSON.stringify({ status: input.status }),
    correlationId: operation.correlationId,
    outcome: "success",
  });
  return result;
}

export const submitForReview = mutation({
  args: { versionId: v.id("documentVersions"), reason: v.string(), idempotencyKey: v.string() },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "document", "submit");
    const operation = await beginReviewOperation(ctx, actor, {
      action: "document_submit", versionId: args.versionId, reason: args.reason, idempotencyKey: args.idempotencyKey,
      payload: { versionId: args.versionId, reason: args.reason },
    });
    if (operation.replay) return operation.result;
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
    if (version.status !== "draft" || !version.groundxStagingDocumentId) {
      throw new ConvexError("DOCUMENT_TRANSITION_INVALID");
    }
    const now = Date.now();
    await ctx.db.patch(version._id, { status: "ready_for_review", submittedBy: actor.userId, submittedAt: now, updatedAt: now });
    return await finishReviewOperation(ctx, actor, operation, {
      action: "document_submit", versionId: version._id, reason: args.reason, status: "ready_for_review",
    });
  },
});

async function decide(
  ctx: MutationCtx,
  args: { versionId: Id<"documentVersions">; checklistAnswers: Checklist; evaluationRunId: string; reason: string; idempotencyKey: string },
  decision: "approve" | "reject",
) {
  const actor = await requireEnabledAdminPermission(ctx, "document", "review");
  const evaluationRunId = validateEvaluation(args.evaluationRunId);
  const action = decision === "approve" ? "document_approve" : "document_reject";
  const operation = await beginReviewOperation(ctx, actor, {
    action, versionId: args.versionId, reason: args.reason, idempotencyKey: args.idempotencyKey,
    payload: { versionId: args.versionId, reason: args.reason, evaluationRunId, checklistAnswers: args.checklistAnswers },
  });
  if (operation.replay) return operation.result;
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  if (version.status !== "ready_for_review") throw new ConvexError("DOCUMENT_TRANSITION_INVALID");
  if (version.submittedBy === actor.userId) throw new ConvexError("Document must be approved by a different reviewer");
  if (decision === "approve" && Object.values(args.checklistAnswers).some((answer) => !answer)) {
    throw new ConvexError("DOCUMENT_CHECKLIST_INCOMPLETE");
  }
  const now = Date.now();
  await ctx.db.insert("reviewDecisions", {
    documentVersionId: version._id,
    reviewerId: actor.userId,
    decision,
    notes: args.reason,
    checklistAnswers: args.checklistAnswers,
    evaluationRunId,
    reason: args.reason,
    correlationId: operation.correlationId,
    createdAt: now,
  });
  const status = decision === "approve" ? "approved" as const : "rejected" as const;
  await ctx.db.patch(version._id, { status, reviewedBy: actor.userId, reviewedAt: now, updatedAt: now });
  return await finishReviewOperation(ctx, actor, operation, { action, versionId: version._id, reason: args.reason, status });
}

const decisionArgs = {
  versionId: v.id("documentVersions"),
  checklistAnswers: checklistValidator,
  evaluationRunId: v.string(),
  reason: v.string(),
  idempotencyKey: v.string(),
};

export const approveVersion = mutation({
  args: decisionArgs,
  returns: operationResultValidator,
  handler: async (ctx, args) => await decide(ctx, args, "approve"),
});

export const rejectVersion = mutation({
  args: decisionArgs,
  returns: operationResultValidator,
  handler: async (ctx, args) => await decide(ctx, args, "reject"),
});

const queueRowValidator = v.object({
  id: v.id("documentVersions"),
  resourceId: v.id("legalResources"),
  resourceTitle: v.string(),
  officialCitation: v.string(),
  versionNumber: v.number(),
  filename: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  sha256: v.string(),
  sourceHost: v.string(),
  effectiveDate: v.optional(v.string()),
  repealDate: v.optional(v.string()),
  status: v.union(v.literal("ready_for_review"), v.literal("approved"), v.literal("published"), v.literal("superseded")),
  stagingDocumentId: v.optional(v.string()),
  stagingProcessId: v.optional(v.string()),
  submittedBy: v.string(),
  submittedAt: v.optional(v.number()),
  previousVersion: v.optional(v.object({
    versionNumber: v.number(), filename: v.string(), sha256: v.string(), effectiveDate: v.optional(v.string()),
  })),
  decisions: v.array(v.object({
    decision: v.union(v.literal("approve"), v.literal("reject")),
    reviewerId: v.string(), reason: v.string(), evaluationRunId: v.optional(v.string()), createdAt: v.number(),
  })),
});

export const listReviewQueue = query({
  args: {
    status: v.optional(v.union(v.literal("ready_for_review"), v.literal("approved"), v.literal("published"), v.literal("superseded"))),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(queueRowValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "document", "read");
    const status = args.status ?? "ready_for_review";
    const result = await ctx.db.query("documentVersions")
      .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status))
      .order("asc")
      .paginate({ ...args.paginationOpts, numItems: Math.min(Math.max(1, args.paginationOpts.numItems), 50) });
    const page = await Promise.all(result.page.map(async (version) => {
      const [resource, previous, decisions] = await Promise.all([
        ctx.db.get(version.resourceId),
        version.versionNumber > 1
          ? ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", version.resourceId).eq("versionNumber", version.versionNumber - 1)).unique()
          : null,
        ctx.db.query("reviewDecisions").withIndex("by_documentVersionId_and_createdAt", (q) => q.eq("documentVersionId", version._id)).order("desc").take(20),
      ]);
      if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
      return {
        id: version._id,
        resourceId: version.resourceId,
        resourceTitle: resource.title,
        officialCitation: resource.officialCitation,
        versionNumber: version.versionNumber,
        filename: version.filename,
        mimeType: version.mimeType,
        byteSize: version.byteSize,
        sha256: version.sha256,
        sourceHost: new URL(version.sourceUrl).host,
        effectiveDate: version.effectiveDate,
        status,
        stagingDocumentId: version.groundxStagingDocumentId,
        stagingProcessId: version.groundxStagingProcessId,
        submittedBy: version.submittedBy,
        submittedAt: version.submittedAt,
        ...(previous ? { previousVersion: { versionNumber: previous.versionNumber, filename: previous.filename, sha256: previous.sha256, effectiveDate: previous.effectiveDate } } : {}),
        decisions: decisions.map((decision) => ({
          decision: decision.decision,
          reviewerId: decision.reviewerId,
          reason: decision.reason,
          evaluationRunId: decision.evaluationRunId,
          createdAt: decision.createdAt,
        })),
      };
    }));
    return { ...result, page };
  },
});
