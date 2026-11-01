import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import {
  sourceVerificationInputValidator, validateSourceVerification, UNRESOLVED_SOURCE_GUIDANCE,
  type SourceVerificationInput, type SourceVerificationAssessment,
} from "../lib/sourceVerification";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { patchDocumentVersion } from "./reviewCounts";

type Actor = { userId: string; roles: AdminRole[]; organizationId?: Id<"organizations">; organizationRole?: "member" | "manager" | "reviewer" };
type RecordInput = {
  versionId: Id<"documentVersions">; sourceVerification: SourceVerificationInput;
  reason: string; kind: "approval" | "correction"; assessment?: SourceVerificationAssessment; idempotencyKey: string;
};
export const sourceVerificationRecordValidator = v.object({
  _id: v.id("documentSourceVerifications"), _creationTime: v.number(),
  ...sourceVerificationInputValidator.fields,
  versionId: v.id("documentVersions"), reviewerId: v.string(),
  kind: v.union(v.literal("approval"), v.literal("correction")),
  assessment: v.union(v.literal("verified"), v.literal("unresolved")),
  previousVerificationId: v.optional(v.id("documentSourceVerifications")),
  reason: v.string(), createdAt: v.number(), idempotencyKey: v.optional(v.string()),
});

function sameInput(row: Doc<"documentSourceVerifications">, input: RecordInput, source: SourceVerificationInput, assessment: SourceVerificationAssessment): boolean {
  return row.versionId === input.versionId && row.kind === input.kind && row.assessment === assessment && row.reason === input.reason &&
    row.sourceClass === source.sourceClass && row.sourceUrl === source.sourceUrl && row.verificationNotes === source.verificationNotes &&
    JSON.stringify(row.corroboratingUrls) === JSON.stringify(source.corroboratingUrls) && row.completeOriginal === source.completeOriginal &&
    row.citationChecked === source.citationChecked && row.laterTreatmentChecked === source.laterTreatmentChecked;
}

/** Appends evidence only. Callers retain their existing lifecycle and authorization checks. */
export async function recordSourceVerificationForActor(ctx: MutationCtx, actor: Actor, input: RecordInput): Promise<Id<"documentSourceVerifications">> {
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.idempotencyKey)) {
    throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  }
  const reason = validateAuditReason(input.reason.trim());
  const assessment = input.assessment ?? "verified";
  if (input.kind === "approval" && assessment !== "verified") throw new ConvexError("DOCUMENT_SOURCE_APPROVAL_REQUIRES_VERIFICATION");
  const version = await ctx.db.get(input.versionId);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  const source = validateSourceVerification(input.sourceVerification, version.sourceUrl, assessment);
  const existing = await ctx.db.query("documentSourceVerifications").withIndex("by_reviewerId_and_idempotencyKey", q =>
    q.eq("reviewerId", actor.userId).eq("idempotencyKey", input.idempotencyKey)).take(2);
  if (existing.length > 1) throw new ConvexError("DOCUMENT_SOURCE_IDEMPOTENCY_STATE_INVALID");
  if (existing[0]) {
    if (!sameInput(existing[0], { ...input, reason }, source, assessment)) throw new ConvexError("DOCUMENT_SOURCE_IDEMPOTENCY_CONFLICT");
    return existing[0]._id;
  }
  const previous = await ctx.db.query("documentSourceVerifications").withIndex("by_versionId_and_createdAt", q => q.eq("versionId", input.versionId)).order("desc").take(1);
  const id = await ctx.db.insert("documentSourceVerifications", {
    ...source, versionId: input.versionId, reviewerId: actor.userId, kind: input.kind, assessment,
    ...(previous[0] ? { previousVerificationId: previous[0]._id } : {}),
    reason, createdAt: Date.now(), idempotencyKey: input.idempotencyKey,
  });
  await writeAudit(ctx, {
    actorId: actor.userId, actorRoles: actor.roles, organizationId: actor.organizationId, organizationRole: actor.organizationRole,
    action: input.kind === "correction" ? "document.source_correction" : "document.source_verification",
    targetType: "documentVersion", targetId: input.versionId, reason,
    afterSummary: JSON.stringify({ verificationId: id, sourceClass: source.sourceClass, assessment, kind: input.kind }), outcome: "success",
  });
  return id;
}

export const recordCorrection = mutation({
  args: { versionId: v.id("documentVersions"), sourceVerification: sourceVerificationInputValidator,
    reason: v.string(), idempotencyKey: v.string(), assessment: v.union(v.literal("verified"), v.literal("unresolved")) },
  returns: v.id("documentSourceVerifications"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "document", "review");
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
    if (version.status === "published") await requireEnabledAdminPermission(ctx, "document", "publish");
    if (version.status === "superseded") await requireEnabledAdminPermission(ctx, "document", "rollback");
    if (args.assessment === "unresolved") {
      if (!["approved", "unpublished", "rejected", "ready_for_review"].includes(version.status)) throw new ConvexError(UNRESOLVED_SOURCE_GUIDANCE);
    } else if (!["approved", "published", "superseded"].includes(version.status)) {
      throw new ConvexError("DOCUMENT_SOURCE_CORRECTION_STATE_INVALID");
    }
    const replay = await ctx.db.query("documentSourceVerifications").withIndex("by_reviewerId_and_idempotencyKey", q =>
      q.eq("reviewerId", actor.userId).eq("idempotencyKey", args.idempotencyKey)).take(1);
    const id = await recordSourceVerificationForActor(ctx, actor, { ...args, kind: "correction" });
    if (args.assessment === "unresolved" && version.status === "approved" && replay.length === 0) {
      await patchDocumentVersion(ctx, version._id, { status: "ready_for_review", reviewedBy: undefined, reviewedAt: undefined, updatedAt: Date.now() });
      await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles,
        action: "document.source_approval_invalidated", targetType: "documentVersion", targetId: version._id,
        reason: "Unresolved source evidence requires fresh approval", beforeSummary: JSON.stringify({ status: "approved" }),
        afterSummary: JSON.stringify({ status: "ready_for_review", verificationId: id }), outcome: "success" });
    }
    return id;
  },
});

export const listHistory = query({
  args: { versionId: v.id("documentVersions") }, returns: v.array(sourceVerificationRecordValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "document", "read");
    if (!(await ctx.db.get(args.versionId))) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
    return ctx.db.query("documentSourceVerifications").withIndex("by_versionId_and_createdAt", q => q.eq("versionId", args.versionId)).order("desc").take(25);
  },
});
