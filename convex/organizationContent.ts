import { retryJobForActor } from "./admin/jobs";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import { requireOrganizationAccess, requireOrganizationResource } from "./lib/organizationAccess";
import { createResourceArgs, createResourceForActor, updateResourceArgs, updateResourceForActor, archiveResourceArgs, archiveResourceForActor, markResourceRepealedArgs, markResourceRepealedForActor } from "./admin/resources";
import { createDocumentVersionArgs, createDocumentVersionForActor, uploadLimit } from "./admin/documents";
import { verifyWidgetServiceProof, uploadProofBytes } from "./lib/widgetProof";
import { decideForActor, decisionArgs, submitForReviewForActor } from "./admin/reviews";
import { queuePublication } from "./admin/publication";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

async function reviewerForVersion(ctx: MutationCtx, versionId: Id<"documentVersions">) {
  const version = await ctx.db.get(versionId);
  if (!version) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const { actor } = await requireOrganizationResource(ctx, version.resourceId, "review");
  return { ...actor, roles: [] };
}
export const approveVersion = mutation({ args: decisionArgs, handler: async (ctx, args) => decideForActor(ctx, args, "approve", await reviewerForVersion(ctx, args.versionId)) });
export const rejectVersion = mutation({ args: decisionArgs, handler: async (ctx, args) => decideForActor(ctx, args, "reject", await reviewerForVersion(ctx, args.versionId)) });
const publicationArgs = { versionId: v.id("documentVersions"), reason: v.string(), confirmation: v.string(), idempotencyKey: v.string() };
export const publishVersion = mutation({ args: publicationArgs, handler: async (ctx, args) => queuePublication(ctx, await reviewerForVersion(ctx, args.versionId), args, "publish") });
export const unpublishVersion = mutation({ args: publicationArgs, handler: async (ctx, args) => queuePublication(ctx, await reviewerForVersion(ctx, args.versionId), args, "unpublish") });
export const rollbackVersion = mutation({ args: publicationArgs, handler: async (ctx, args) => queuePublication(ctx, await reviewerForVersion(ctx, args.versionId), args, "rollback") });

export const createResource = mutation({ args: createResourceArgs.fields, handler: async (ctx, args) => {
  const jurisdiction = await ctx.db.get(args.jurisdictionId);
  if (jurisdiction?.kind !== "organizational" || !jurisdiction.organizationId) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const actor = await requireOrganizationAccess(ctx, jurisdiction.organizationId, "manage");
  return createResourceForActor(ctx, { ...actor, roles: [] }, args);
} });
export const updateResource = mutation({ args: updateResourceArgs.fields, handler: async (ctx, args) => {
  const { actor } = await requireOrganizationResource(ctx, args.id, "manage");
  return updateResourceForActor(ctx, { ...actor, roles: [] }, args);
} });
export const archiveResource = mutation({ args: archiveResourceArgs.fields, handler: async (ctx, args) => {
  const { actor } = await requireOrganizationResource(ctx, args.id, "manage");
  return archiveResourceForActor(ctx, { ...actor, roles: [] }, args);
} });
export const markResourceRepealed = mutation({ args: markResourceRepealedArgs.fields, handler: async (ctx, args) => {
  const { actor } = await requireOrganizationResource(ctx, args.id, "manage");
  return markResourceRepealedForActor(ctx, { ...actor, roles: [] }, args);
} });
export const listResources = query({ args: { organizationId: v.id("organizations"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  await requireOrganizationAccess(ctx, args.organizationId, "read");
  if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 50) throw new ConvexError("INVALID_PAGINATION");
  const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_organizationId", q => q.eq("organizationId", args.organizationId)).unique();
  if (!jurisdiction) return { page: [], isDone: true, continueCursor: "" };
  return ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_updatedAt", q => q.eq("jurisdictionId", jurisdiction._id)).order("desc").paginate(args.paginationOpts);
} });
export const getResource = query({ args: { organizationId: v.id("organizations"), resourceId: v.id("legalResources") }, handler: async (ctx, args) => {
  const { resource, actor } = await requireOrganizationResource(ctx, args.resourceId, "read");
  if (actor.organizationId !== args.organizationId) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  return { resource, role: actor.organizationRole, maxBytes: Math.min(uploadLimit(), 4 * 1024 * 1024) };
} });
export const listVersions = query({ args: { organizationId: v.id("organizations"), resourceId: v.id("legalResources"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const { actor } = await requireOrganizationResource(ctx, args.resourceId, "read");
  if (actor.organizationId !== args.organizationId) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 50) throw new ConvexError("INVALID_PAGINATION");
  const result = await ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", q => q.eq("resourceId", args.resourceId)).order("desc").paginate(args.paginationOpts);
  const resource = await ctx.db.get(args.resourceId);
  return { ...result, page: await Promise.all(result.page.map(async row => {
    const [previous, decisions, originalUrl] = await Promise.all([
      row.versionNumber > 1 ? ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", q => q.eq("resourceId", args.resourceId).eq("versionNumber", row.versionNumber - 1)).unique() : null,
      ctx.db.query("reviewDecisions").withIndex("by_documentVersionId_and_createdAt", q => q.eq("documentVersionId", row._id)).order("desc").take(20),
      ctx.storage.getUrl(row.originalStorageId),
    ]);
    return { id: row._id, resourceTitle: resource!.title, officialCitation: resource!.officialCitation, versionNumber: row.versionNumber, filename: row.filename, mimeType: row.mimeType, byteSize: row.byteSize, sha256: row.sha256, sourceHost: new URL(row.sourceUrl).host, originalUrl, status: row.status, submittedBy: row.submittedBy, effectiveDate: row.effectiveDate, createdAt: row.createdAt, failureSummary: row.failureSummary,
      ...(previous ? { previousVersion: { versionNumber: previous.versionNumber, filename: previous.filename, sha256: previous.sha256, effectiveDate: previous.effectiveDate } } : {}),
      decisions: decisions.map(d => ({ decision: d.decision, reviewerId: d.reviewerId, reason: d.reason, evaluationRunId: d.evaluationRunId, createdAt: d.createdAt })),
    };
  })) };
} });
export const prepareUpload = mutation({ args: { resourceId: v.id("legalResources") }, handler: async (ctx, args) => {
  const { actor, resource } = await requireOrganizationResource(ctx, args.resourceId, "manage");
  if (resource.status !== "active") throw new ConvexError("RESOURCE_NOT_ACTIVE");
  return { uploadUrl: await ctx.storage.generateUploadUrl(), userId: actor.userId, sessionId: actor.sessionId, maximumBytes: Math.min(uploadLimit(), 4 * 1024 * 1024), organizationId: actor.organizationId };
} });
export const finalizeUpload = mutation({ args: { ...createDocumentVersionArgs.fields, issuedAt: v.number(), signature: v.string() }, handler: async (ctx, args) => {
  const { actor } = await requireOrganizationResource(ctx, args.resourceId, "manage");
  if (!await verifyWidgetServiceProof("organization-upload-finalize", args.issuedAt, uploadProofBytes(actor, args), args.signature)) throw new ConvexError("UPLOAD_PROOF_INVALID");
  const attached = await ctx.db.query("documentVersions").withIndex("by_originalStorageId", q => q.eq("originalStorageId", args.storageId)).take(2);
  if (attached.length) {
    if (attached.length === 1 && attached[0].resourceId === args.resourceId && attached[0].sha256 === args.sha256 && attached[0].submittedBy === actor.userId) return attached[0]._id;
    throw new ConvexError("UPLOAD_ALREADY_CLAIMED");
  }
  return createDocumentVersionForActor(ctx, { ...actor, roles: [] }, args);
} });

export const retryPublication = mutation({ args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId);
  const versionId = job?.targetType === "documentVersion" ? ctx.db.normalizeId("documentVersions", job.targetId) : null;
  if (!job || !versionId || !["gemini_index_document", "gemini_delete_document"].includes(job.type)) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const actor = await reviewerForVersion(ctx, versionId);
  // Only resumes a known provider operation; never authorizes a fresh upload.
  if (job.status !== "manual_review" || (job.type === "gemini_index_document" && (job.recoveryKind !== "poll_operation" || !job.providerOperationName))) throw new ConvexError("JOB_NOT_SAFELY_RETRYABLE");
  return retryJobForActor(ctx, args, actor);
} });
export const publicationStatus = query({ args: { versionId: v.id("documentVersions") }, handler: async (ctx, args) => {
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const { actor } = await requireOrganizationResource(ctx, version.resourceId, "read");
  const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", q => q.eq("resourceId", version.resourceId)).unique();
  const job = lock?.versionId === args.versionId && lock.jobId ? await ctx.db.get(lock.jobId) : null;
  return job ? { id: job._id, status: job.status, updatedAt: job.updatedAt, canRetry: actor.organizationRole === "reviewer" && job.status === "manual_review" && (job.type === "gemini_delete_document" || (job.recoveryKind === "poll_operation" && !!job.providerOperationName)) } : null;
} });

export const submitForReview = mutation({ args: { versionId: v.id("documentVersions"), reason: v.string(), idempotencyKey: v.string() }, handler: async (ctx, args) => {
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const { actor } = await requireOrganizationResource(ctx, version.resourceId, "manage");
  return submitForReviewForActor(ctx, args, { ...actor, roles: [] });
} });