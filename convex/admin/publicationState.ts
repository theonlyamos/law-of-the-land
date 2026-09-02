import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isGeminiDocumentName, isGeminiFileSearchStoreName, isGeminiUploadOperationForStore } from "../lib/geminiFileSearchNames";
import { writeAudit } from "./audit";

type PublicationOperation = "publish" | "unpublish" | "rollback";
type IndexPayload =
  | { operation: "publish"; storeName: string; sha256: string }
  | { operation: "replace_index" | "rollback_index"; previousVersionId: string; storeName: string; sha256: string };
type DeletePayload =
  | { operation: "unpublish"; storeName: string; documentName: string }
  | { operation: "replace_delete"; publicationOperation: "publish" | "rollback"; candidateVersionId: string; candidateDocumentName: string; previousVersionId: string; storeName: string; documentName: string };

function readPayload(job: Doc<"integrationJobs">): IndexPayload | DeletePayload | null {
  if (job.type !== "gemini_index_document" && job.type !== "gemini_delete_document") return null;
  if (new TextEncoder().encode(job.payload).byteLength > 8_192) return null;
  let value: unknown;
  try { value = JSON.parse(job.payload); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = (...keys: string[]) => Object.keys(record).every((key) => keys.includes(key));
  const reasonValid = record.reasonDigest === undefined || (typeof record.reasonDigest === "string" && /^[a-f0-9]{64}$/.test(record.reasonDigest));
  if (job.type === "gemini_index_document" && record.operation === "publish" && typeof record.storeName === "string" && typeof record.sha256 === "string" && record.previousVersionId === undefined && reasonValid && allowed("operation", "storeName", "sha256", "reasonDigest")) {
    return { operation: "publish", storeName: record.storeName, sha256: record.sha256 };
  }
  if (job.type === "gemini_index_document" && (record.operation === "replace_index" || record.operation === "rollback_index") && typeof record.previousVersionId === "string" && typeof record.storeName === "string" && typeof record.sha256 === "string" && reasonValid && allowed("operation", "previousVersionId", "storeName", "sha256", "reasonDigest")) {
    return { operation: record.operation, previousVersionId: record.previousVersionId, storeName: record.storeName, sha256: record.sha256 };
  }
  if (job.type === "gemini_delete_document" && record.operation === "unpublish" && typeof record.storeName === "string" && typeof record.documentName === "string" && reasonValid && allowed("operation", "storeName", "documentName", "reasonDigest")) {
    return { operation: "unpublish", storeName: record.storeName, documentName: record.documentName };
  }
  if (job.type === "gemini_delete_document" && record.operation === "replace_delete" && (record.publicationOperation === "publish" || record.publicationOperation === "rollback") && typeof record.candidateVersionId === "string" && typeof record.candidateDocumentName === "string" && typeof record.previousVersionId === "string" && typeof record.storeName === "string" && typeof record.documentName === "string" && allowed("operation", "publicationOperation", "candidateVersionId", "candidateDocumentName", "previousVersionId", "storeName", "documentName")) {
    return { operation: "replace_delete", publicationOperation: record.publicationOperation, candidateVersionId: record.candidateVersionId, candidateDocumentName: record.candidateDocumentName, previousVersionId: record.previousVersionId, storeName: record.storeName, documentName: record.documentName };
  }
  return null;
}

async function lifecycleLock(ctx: MutationCtx | QueryCtx, resourceId: Id<"legalResources">, job: Doc<"integrationJobs">, now: number) {
  const locks = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).take(2);
  if (locks.length !== 1 || locks[0].jobId !== job._id || locks[0].expiresAt <= now) throw new ConvexError("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
  return locks[0];
}

async function assertNoStoreTeardown(ctx: MutationCtx | QueryCtx, jurisdictionId: Id<"jurisdictions">) {
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

type IndexWorkflow = {
  kind: "index";
  payload: IndexPayload;
  publicationOperation: "publish" | "rollback";
  version: Doc<"documentVersions">;
  previous: Doc<"documentVersions"> | null;
  resource: Doc<"legalResources">;
  jurisdiction: Doc<"jurisdictions">;
  lock: Doc<"documentLifecycleLocks">;
  storeName: string;
};
type DeleteWorkflow = {
  kind: "delete";
  payload: DeletePayload;
  publicationOperation: PublicationOperation;
  target: Doc<"documentVersions">;
  candidate: Doc<"documentVersions"> | null;
  resource: Doc<"legalResources">;
  jurisdiction: Doc<"jurisdictions">;
  lock: Doc<"documentLifecycleLocks">;
  storeName: string;
};

export async function resolveGeminiPublicationWorkflow(
  ctx: MutationCtx | QueryCtx,
  job: Doc<"integrationJobs">,
  mode:
    | { kind: "active"; pendingOperationName?: string }
    | { kind: "stale_reconciliation" }
    | { kind: "indexed_candidate"; documentName: string } = { kind: "active" },
  now: number,
): Promise<IndexWorkflow | DeleteWorkflow> {
  if (job.targetType !== "documentVersion") throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
  const payload = readPayload(job);
  if (!payload) throw new ConvexError("INTEGRATION_PAYLOAD_INVALID");
  const target = await ctx.db.get(job.targetId as Id<"documentVersions">);
  if (!target) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  const resource = await ctx.db.get(target.resourceId);
  const jurisdiction = resource ? await ctx.db.get(resource.jurisdictionId) : null;
  const storeName = jurisdiction?.geminiFileSearchStoreName;
  if (!resource || !jurisdiction || resource.status !== "active" || jurisdiction.status !== "enabled" || !storeName || !isGeminiFileSearchStoreName(storeName) || payload.storeName !== storeName) {
    throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
  }
  await assertNoStoreTeardown(ctx, jurisdiction._id);
  const owners = await ctx.db.query("jurisdictions").withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", storeName)).take(2);
  if (owners.length !== 1 || owners[0]._id !== jurisdiction._id) throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
  const lock = await lifecycleLock(ctx, resource._id, job, now);
  const driftRecovery = jurisdiction.providerSyncState === "drifted";

  if (job.type === "gemini_index_document" && (payload.operation === "publish" || payload.operation === "replace_index" || payload.operation === "rollback_index")) {
    const publicationOperation = payload.operation === "rollback_index" ? "rollback" : "publish";
    const previousVersionId = payload.operation === "publish" ? undefined : payload.previousVersionId as Id<"documentVersions">;
    const previous = previousVersionId ? await ctx.db.get(previousVersionId) : null;
    const pendingOperationName = mode.kind === "active" ? mode.pendingOperationName : undefined;
    const boundOperationName = pendingOperationName ?? job.providerOperationName;
    const operationBound = boundOperationName !== undefined && isGeminiUploadOperationForStore(boundOperationName, storeName);
    const candidateDocumentValid = mode.kind === "indexed_candidate"
      ? target.geminiDocumentName === mode.documentName && isGeminiDocumentName(mode.documentName) && mode.documentName.startsWith(`${storeName}/documents/`)
      : target.geminiDocumentName === undefined;
    const provenanceValid = mode.kind === "stale_reconciliation"
      ? (job.providerOperationName === undefined
          ? job.recoveryKind === undefined
          : operationBound && (job.recoveryKind === undefined || job.recoveryKind === "poll_operation"))
      : job.providerOperationName === undefined
        ? job.recoveryKind === undefined
        : job.recoveryKind === "poll_operation";
    if (
      target.status !== "publishing" || target.sha256 !== payload.sha256 || !candidateDocumentValid ||
      lock.versionId !== target._id || lock.operation !== publicationOperation ||
      resource.activeVersionId !== previousVersionId ||
      (previousVersionId === undefined ? previous !== null : !previous || previous.resourceId !== resource._id || previous.status !== "published" || !previous.geminiDocumentName || !isGeminiDocumentName(previous.geminiDocumentName) || !previous.geminiDocumentName.startsWith(`${storeName}/documents/`)) ||
      !provenanceValid ||
      (job.providerOperationName !== undefined && !operationBound) ||
      (pendingOperationName !== undefined && (job.providerOperationName !== undefined || job.recoveryKind !== undefined || !operationBound)) ||
      (driftRecovery && !(job.recoveryKind === "poll_operation" && operationBound)) ||
      (!driftRecovery && jurisdiction.providerSyncState !== "synced")
    ) throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    return { kind: "index", payload, publicationOperation, version: target, previous, resource, jurisdiction, lock, storeName };
  }

  if (job.type === "gemini_delete_document" && (payload.operation === "unpublish" || payload.operation === "replace_delete")) {
    const recovering = job.recoveryKind === "delete_document";
    const provenanceValid = mode.kind === "stale_reconciliation"
      ? job.recoveryKind === undefined || recovering
      : recovering || job.recoveryKind === undefined;
    if ((driftRecovery && !recovering) || (!driftRecovery && jurisdiction.providerSyncState !== "synced") || !provenanceValid || job.providerOperationName !== undefined || mode.kind === "indexed_candidate") {
      throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
    if (!target.geminiDocumentName || target.geminiDocumentName !== payload.documentName || !isGeminiDocumentName(payload.documentName) || !payload.documentName.startsWith(`${storeName}/documents/`)) {
      throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
    if (payload.operation === "unpublish") {
      if (lock.versionId !== target._id || lock.operation !== "unpublish" || target.status !== "published" || resource.activeVersionId !== target._id) throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
      return { kind: "delete", payload, publicationOperation: "unpublish", target, candidate: null, resource, jurisdiction, lock, storeName };
    }
    const candidate = await ctx.db.get(payload.candidateVersionId as Id<"documentVersions">);
    if (
      payload.previousVersionId !== target._id || lock.versionId !== payload.candidateVersionId || lock.operation !== payload.publicationOperation ||
      !candidate || candidate.resourceId !== resource._id || candidate.status !== "publishing" || candidate.geminiDocumentName !== payload.candidateDocumentName || candidate.geminiDocumentName === target.geminiDocumentName || !isGeminiDocumentName(candidate.geminiDocumentName) || !candidate.geminiDocumentName.startsWith(`${storeName}/documents/`) ||
      target.status !== "published" || resource.activeVersionId !== target._id
    ) throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    return { kind: "delete", payload, publicationOperation: payload.publicationOperation, target, candidate, resource, jurisdiction, lock, storeName };
  }
  throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
}

async function releaseLifecycleLock(ctx: MutationCtx, lock: Doc<"documentLifecycleLocks">) {
  await ctx.db.delete(lock._id);
}

async function auditOutcome(ctx: MutationCtx, job: Doc<"integrationJobs">, operation: PublicationOperation, targetId: Id<"documentVersions">, outcome: "success" | "failure") {
  await writeAudit(ctx, { actorId: job.actorId, actorRoles: job.actorRoles, action: `document.${operation}.${outcome}`, targetType: "documentVersion", targetId, correlationId: job.correlationId, outcome });
}

const MAX_UNRESOLVED_PROVIDER_JOBS_TO_CHECK = 128;
const UNRESOLVED_PROVIDER_JOB_STATUSES = ["manual_review", "running", "waiting_provider"] as const;
const GEMINI_PROVIDER_JOB_TYPES = [
  "gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store",
] as const;

function unresolvedProviderJob(job: Doc<"integrationJobs">) {
  if (!["gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store"].includes(job.type)) return false;
  if (job.status === "manual_review") return true;
  return (job.status === "running" || job.status === "waiting_provider")
    && job.recoveryKind !== undefined
    && job.lastErrorKind !== undefined;
}

async function unresolvedJobJurisdiction(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
): Promise<Id<"jurisdictions"> | null> {
  if (job.type === "gemini_create_store" || job.type === "gemini_delete_store") {
    return job.targetType === "jurisdictionGeminiStore"
      ? ctx.db.normalizeId("jurisdictions", job.targetId)
      : null;
  }
  if (job.type !== "gemini_index_document" && job.type !== "gemini_delete_document") return null;
  const versionId = job.targetType === "documentVersion"
    ? ctx.db.normalizeId("documentVersions", job.targetId)
    : null;
  const version = versionId ? await ctx.db.get(versionId) : null;
  const resource = version ? await ctx.db.get(version.resourceId) : null;
  return resource?.jurisdictionId ?? null;
}

async function clearResolvedJurisdictionDrift(
  ctx: MutationCtx,
  jurisdiction: Doc<"jurisdictions">,
  completedJobId: Id<"integrationJobs">,
  now: number,
) {
  if (jurisdiction.providerSyncState !== "drifted") return;
  const unresolved: Doc<"integrationJobs">[] = [];
  for (const status of UNRESOLVED_PROVIDER_JOB_STATUSES) {
    for (const type of GEMINI_PROVIDER_JOB_TYPES) {
      const remaining = MAX_UNRESOLVED_PROVIDER_JOBS_TO_CHECK - unresolved.length;
      const jobs = await ctx.db.query("integrationJobs")
        .withIndex("by_status_and_type_and_createdAt", (q) => q.eq("status", status).eq("type", type))
        .take(remaining + 1);
      if (jobs.length > remaining) return;
      unresolved.push(...jobs);
    }
  }
  for (const candidate of unresolved) {
    if (candidate._id === completedJobId || !unresolvedProviderJob(candidate)) continue;
    const candidateJurisdictionId = await unresolvedJobJurisdiction(ctx, candidate);
    if (candidateJurisdictionId === null || candidateJurisdictionId === jurisdiction._id) return;
  }
  await ctx.db.patch(jurisdiction._id, { providerSyncState: "synced", updatedAt: now });
}

export async function applyPublicationJobFailure(ctx: MutationCtx, job: Doc<"integrationJobs">, now: number): Promise<void> {
  const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
  if (workflow.kind === "delete") {
    if (workflow.payload.operation !== "unpublish") throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    await ctx.db.patch(workflow.target._id, { failureSummary: undefined, updatedAt: now });
    await clearResolvedJurisdictionDrift(ctx, workflow.jurisdiction, job._id, now);
    await auditOutcome(ctx, job, "unpublish", workflow.target._id, "failure");
    await releaseLifecycleLock(ctx, workflow.lock);
    return;
  }
  await ctx.db.patch(workflow.version._id, { status: workflow.publicationOperation === "rollback" ? "superseded" : "approved", failureSummary: workflow.previous ? "Publishing failed. The previous published version is still active." : "Publishing failed. No version was published.", updatedAt: now });
  await clearResolvedJurisdictionDrift(ctx, workflow.jurisdiction, job._id, now);
  await auditOutcome(ctx, job, workflow.publicationOperation, workflow.version._id, "failure");
  await releaseLifecycleLock(ctx, workflow.lock);
}

export type ReplacementDelete = { previousVersionId: Id<"documentVersions">; payload: DeletePayload & { operation: "replace_delete" } };

export async function applyGeminiIndexCompletion(ctx: MutationCtx, job: Doc<"integrationJobs">, documentName: string, now: number): Promise<ReplacementDelete | null> {
  const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
  if (workflow.kind !== "index" || !job.providerOperationName || job.recoveryKind !== "poll_operation" || !isGeminiDocumentName(documentName) || !documentName.startsWith(`${workflow.storeName}/documents/`) || workflow.previous?.geminiDocumentName === documentName) throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
  await ctx.db.patch(workflow.version._id, { geminiDocumentName: documentName, geminiIndexedAt: now, updatedAt: now });
  if (workflow.previous) {
    return { previousVersionId: workflow.previous._id, payload: { operation: "replace_delete", publicationOperation: workflow.publicationOperation, candidateVersionId: workflow.version._id, candidateDocumentName: documentName, previousVersionId: workflow.previous._id, storeName: workflow.storeName, documentName: workflow.previous.geminiDocumentName! } };
  }
  await ctx.db.patch(workflow.version._id, { status: "published", publishedAt: now, unpublishedAt: undefined, failureSummary: undefined, updatedAt: now });
  await ctx.db.patch(workflow.resource._id, { activeVersionId: workflow.version._id, updatedBy: job.actorId, updatedAt: now });
  await clearResolvedJurisdictionDrift(ctx, workflow.jurisdiction, job._id, now);
  await auditOutcome(ctx, job, workflow.publicationOperation, workflow.version._id, "success");
  await releaseLifecycleLock(ctx, workflow.lock);
  return null;
}

export async function transferPublicationLock(ctx: MutationCtx, indexJob: Doc<"integrationJobs">, deleteJobId: Id<"integrationJobs">, candidateDocumentName: string, now: number): Promise<void> {
  const workflow = await resolveGeminiPublicationWorkflow(ctx, indexJob, { kind: "indexed_candidate", documentName: candidateDocumentName }, now);
  if (workflow.kind !== "index" || !workflow.previous) throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
  await ctx.db.patch(workflow.lock._id, { jobId: deleteJobId, updatedAt: now });
}

export async function applyGeminiDeleteCompletion(ctx: MutationCtx, job: Doc<"integrationJobs">, now: number): Promise<void> {
  const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
  if (workflow.kind !== "delete") throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
  if (workflow.payload.operation === "unpublish") {
    await ctx.db.patch(workflow.target._id, { status: "unpublished", geminiDocumentName: undefined, geminiIndexedAt: undefined, unpublishedAt: now, failureSummary: undefined, updatedAt: now });
    await ctx.db.patch(workflow.resource._id, { activeVersionId: undefined, updatedBy: job.actorId, updatedAt: now });
    await clearResolvedJurisdictionDrift(ctx, workflow.jurisdiction, job._id, now);
    await auditOutcome(ctx, job, "unpublish", workflow.target._id, "success");
    await releaseLifecycleLock(ctx, workflow.lock);
    return;
  }
  const candidate = workflow.candidate!;
  await ctx.db.patch(workflow.target._id, { status: "superseded", geminiDocumentName: undefined, geminiIndexedAt: undefined, updatedAt: now });
  await ctx.db.patch(candidate._id, { status: "published", publishedAt: now, unpublishedAt: undefined, failureSummary: undefined, updatedAt: now });
  await ctx.db.patch(workflow.resource._id, { activeVersionId: candidate._id, updatedBy: job.actorId, updatedAt: now });
  await clearResolvedJurisdictionDrift(ctx, workflow.jurisdiction, job._id, now);
  await auditOutcome(ctx, job, workflow.publicationOperation, candidate._id, "success");
  await releaseLifecycleLock(ctx, workflow.lock);
}
