import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAudit } from "./audit";

type PublicationOperation = "publish" | "unpublish" | "rollback";
type PublicationPayload = {
  operation: PublicationOperation;
  previousVersionId?: string;
};

function readPayload(job: Doc<"integrationJobs">): PublicationPayload | null {
  if (job.type !== "copy_documents" && job.type !== "delete_documents") return null;
  let value: unknown;
  try { value = JSON.parse(job.payload); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.operation !== "publish" && record.operation !== "unpublish" && record.operation !== "rollback") return null;
  return {
    operation: record.operation,
    ...(typeof record.previousVersionId === "string" ? { previousVersionId: record.previousVersionId } : {}),
  };
}

async function releaseLifecycleLock(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
  resourceId: Id<"legalResources">,
) {
  const locks = await ctx.db.query("documentLifecycleLocks")
    .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
    .take(2);
  if (locks.length > 1) throw new ConvexError("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
  if (locks[0]?.jobId === job._id) await ctx.db.delete(locks[0]._id);
}

export async function applyPublicationJobOutcome(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
  outcome: "succeeded" | "failed",
  processId?: string,
): Promise<void> {
  const payload = readPayload(job);
  if (!payload) return;
  const versionId = job.targetId as Id<"documentVersions">;
  const version = await ctx.db.get(versionId);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  const resource = await ctx.db.get(version.resourceId);
  if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
  const now = Date.now();

  if (outcome === "failed") {
    if (payload.operation === "publish" && version.status === "publishing") {
      await ctx.db.patch(version._id, { status: "approved", failureSummary: "Production copy failed", updatedAt: now });
    } else if (payload.operation === "rollback" && version.status === "publishing") {
      await ctx.db.patch(version._id, { status: "superseded", failureSummary: "Rollback copy failed", updatedAt: now });
    }
    await writeAudit(ctx, {
      actorId: job.actorId,
      actorRoles: job.actorRoles,
      action: `document.${payload.operation}.failure`,
      targetType: "documentVersion",
      targetId: version._id,
      correlationId: job.correlationId,
      outcome: "failure",
    });
    await releaseLifecycleLock(ctx, job, resource._id);
    return;
  }

  const priorId = payload.previousVersionId as Id<"documentVersions"> | undefined;
  if (payload.operation === "unpublish") {
    if (version.status !== "published" || resource.activeVersionId !== version._id) {
      throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
    await ctx.db.patch(version._id, {
      status: "unpublished",
      groundxProductionProcessId: processId,
      unpublishedAt: now,
      failureSummary: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(resource._id, { activeVersionId: undefined, updatedBy: job.actorId, updatedAt: now });
  } else {
    if (version.status !== "publishing" || resource.activeVersionId !== priorId) {
      throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
    if (priorId) {
      const prior = await ctx.db.get(priorId);
      if (!prior || prior.resourceId !== resource._id || prior.status !== "published") {
        throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
      }
      await ctx.db.patch(prior._id, { status: "superseded", updatedAt: now });
    }
    await ctx.db.patch(version._id, {
      status: "published",
      groundxProductionDocumentId: version.groundxStagingDocumentId,
      groundxProductionProcessId: processId,
      publishedAt: now,
      unpublishedAt: undefined,
      failureSummary: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(resource._id, { activeVersionId: version._id, updatedBy: job.actorId, updatedAt: now });
  }
  await writeAudit(ctx, {
    actorId: job.actorId,
    actorRoles: job.actorRoles,
    action: `document.${payload.operation}.success`,
    targetType: "documentVersion",
    targetId: version._id,
    correlationId: job.correlationId,
    outcome: "success",
  });
  await releaseLifecycleLock(ctx, job, resource._id);
}
