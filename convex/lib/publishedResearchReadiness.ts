import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isGeminiDocumentName, isGeminiFileSearchStoreName, isGeminiUploadOperationForStore } from "./geminiFileSearchNames";
import { PUBLICATION_FILTER_PROTOCOL, MAX_PUBLISHED_FILTER_DOCUMENTS, parsePublicationFilter,
  buildPublicationMetadataFilter, isPublicationEnvironment, isPublicationMetadataId, type PublicationFilter } from "../../shared/gemini-publication-filter";

const MAX_RESOURCES = 400;
// Picker display counts have a separate budget from authoritative readiness.
const MAX_DISPLAY_RESOURCES = 32;
const MAX_DISPLAY_FAILED_VERSIONS = 32;
const MAX_CURRENT_JOBS = 128;
const CURRENT_STATUSES = ["queued", "running", "waiting_provider", "manual_review", "waiting_callback"] as const;
const GEMINI_JOB_TYPES = ["gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store"] as const;
type ReadContext = Pick<QueryCtx, "db">;
export type ResearchReadState = {
  jobs: readonly Doc<"integrationJobs">[];
  legacyLocks: readonly Doc<"documentLifecycleLocks">[];
};

/** Invocation-local snapshot, shared by all libraries in one research scope. */
export async function currentGeminiResearchState(ctx: ReadContext): Promise<ResearchReadState | null> {
  const jobs: Doc<"integrationJobs">[] = [];
  for (const status of CURRENT_STATUSES) for (const type of GEMINI_JOB_TYPES) {
    const batch = await ctx.db.query("integrationJobs").withIndex("by_status_and_type_and_createdAt", q => q.eq("status", status).eq("type", type)).take(MAX_CURRENT_JOBS + 1);
    jobs.push(...batch);
    if (jobs.length > MAX_CURRENT_JOBS) return null;
  }
  const legacyLocks = await ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", undefined)).take(MAX_CURRENT_JOBS + 1);
  if (legacyLocks.length > MAX_CURRENT_JOBS) return null;
  for (const lock of legacyLocks) {
    const resource = await ctx.db.get(lock.resourceId);
    if (!resource || !(await ctx.db.get(resource.jurisdictionId))) return null;
  }
  return { jobs, legacyLocks };
}

function payloadOf(job: Doc<"integrationJobs">): Record<string, unknown> | null {
  if (new TextEncoder().encode(job.payload).byteLength > 8192) return null;
  try {
    const value: unknown = JSON.parse(job.payload);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Display metadata only: changes to unpublished documents are not source authority changes. */
export async function unpublishedDocumentCount(ctx: ReadContext, row: Doc<"jurisdictions">): Promise<number | null> {
  const failedVersions = [...new Set(row.geminiSearchRestriction?.failedVersionIds ?? [])];
  if (failedVersions.length > MAX_DISPLAY_FAILED_VERSIONS) return null;
  const resources = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_activeVersionId", q =>
    q.eq("jurisdictionId", row._id).eq("activeVersionId", undefined)).take(MAX_DISPLAY_RESOURCES + 1);
  if (resources.length > MAX_DISPLAY_RESOURCES) return null;
  const excluded = new Set<string>();
  for (const resource of resources) {
    if (resource.status !== "active" || resource.catalogPublished === true) continue;
    const versions = await ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", q => q.eq("resourceId", resource._id)).take(1);
    if (versions.length) excluded.add(resource._id);
  }
  for (const versionId of failedVersions) {
    const version = await ctx.db.get(versionId);
    if (!version) return null;
    const resource = await ctx.db.get(version.resourceId);
    if (!resource || resource.jurisdictionId !== row._id) return null;
    excluded.add(resource._id);
  }
  return excluded.size;
}

/** Read policy only. Never changes provider state, job recovery, locks, or publication pointers. */
export async function publishedResearchReadiness(ctx: ReadContext, jurisdictionId: Id<"jurisdictions">, filterCapable = false,
  currentState?: ResearchReadState | null): Promise<{
  storeName: string; publicationFilter?: PublicationFilter; documents: PublicationFilter["documents"]; requiresFilter: boolean;
} | null> {
  const row = await ctx.db.get(jurisdictionId);
  const storeName = row?.geminiFileSearchStoreName;
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!row || row.status !== "enabled" || !storeName || !isGeminiFileSearchStoreName(storeName)
    || !["synced", "drifted"].includes(row.providerSyncState)) return null;
  const owners = await ctx.db.query("jurisdictions").withIndex("by_gemini_store_name", q => q.eq("geminiFileSearchStoreName", storeName)).take(2);
  if (owners.length !== 1 || owners[0]._id !== row._id) return null;
  const restriction = row.geminiSearchRestriction;
  if (restriction && (!restriction.failedVersionIds.length || restriction.failedVersionIds.length > MAX_PUBLISHED_FILTER_DOCUMENTS
    || new Set(restriction.failedVersionIds).size !== restriction.failedVersionIds.length)) return null;
  const failedVersions = new Set(restriction?.failedVersionIds ?? []);
  for (const versionId of failedVersions) {
    const version = await ctx.db.get(versionId);
    const resource = version ? await ctx.db.get(version.resourceId) : null;
    if (!version || !resource || resource.jurisdictionId !== row._id || version.status !== "failed") return null;
  }
  const resources = await ctx.db.query("legalResources").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", row._id)).take(MAX_RESOURCES + 1);
  if (resources.length > MAX_RESOURCES) return null;
  const documents: PublicationFilter["documents"] = [];
  let unpublishedAddition = false;
  const documentNames = new Set<string>();
  const resourceLocks = new Map<Id<"legalResources">, Doc<"documentLifecycleLocks">[]>();
  for (const resource of resources) {
    const [published, locks] = await Promise.all([
      ctx.db.query("documentVersions").withIndex("by_resourceId_and_status", q => q.eq("resourceId", resource._id).eq("status", "published")).take(2),
      ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", q => q.eq("resourceId", resource._id)).take(2),
    ]);
    resourceLocks.set(resource._id, locks);
    if (resource.activeVersionId === undefined) {
      if (resource.catalogPublished === true || published.length) return null;
      const versions = await ctx.db.query("documentVersions").withIndex("by_resourceId_and_versionNumber", q => q.eq("resourceId", resource._id)).take(1);
      if (versions.length) unpublishedAddition = true;
      continue;
    }
    const version = await ctx.db.get(resource.activeVersionId);
    if (resource.status !== "active" || resource.catalogPublished !== true || resource.geminiPublicationBlock || locks.length
      || published.length !== 1 || published[0]._id !== resource.activeVersionId || !version || version.resourceId !== resource._id
      || version.status !== "published" || failedVersions.has(version._id) || !version.geminiDocumentName
      || !isGeminiDocumentName(version.geminiDocumentName) || !version.geminiDocumentName.startsWith(`${storeName}/documents/`)
      || documentNames.has(version.geminiDocumentName) || !isPublicationMetadataId(resource._id)
      || !isPublicationMetadataId(version._id) || !/^[a-f0-9]{64}$/.test(version.sha256)) return null;
    documentNames.add(version.geminiDocumentName);
    documents.push({ resourceId: resource._id, versionId: version._id, sha256: version.sha256 });
  }
  if (!documents.length) return null;

  // Complete bounded current-job scan: unattributable work cannot explain store drift safely.
  const state = currentState === undefined ? await currentGeminiResearchState(ctx) : currentState;
  if (!state) return null;
  const { jobs } = state;
  const additions = new Set<Id<"integrationJobs">>();
  const explainedLocks = new Set<Id<"documentLifecycleLocks">>();
  for (const job of jobs) {
    const payload = payloadOf(job);
    if (!payload) return null;
    if (job.type === "gemini_create_store" || job.type === "gemini_delete_store") {
      const target = ctx.db.normalizeId("jurisdictions", job.targetId);
      if (!target || job.targetType !== "jurisdictionGeminiStore") return null;
      if (target === row._id || payload.storeName === storeName) return null;
      continue;
    }
    const versionId = ctx.db.normalizeId("documentVersions", job.targetId);
    const version = versionId ? await ctx.db.get(versionId) : null;
    const resource = version ? await ctx.db.get(version.resourceId) : null;
    if (!resource || !version || job.targetType !== "documentVersion") return null;
    if (resource.jurisdictionId !== row._id) {
      if (payload.storeName === storeName) return null;
      continue;
    }
    const locks = resourceLocks.get(resource._id) ?? [];
    const lock = locks[0];
    if (job.type !== "gemini_index_document" || job.status === "waiting_callback" || resource.status !== "active" || resource.activeVersionId !== undefined
      || resource.catalogPublished === true || resource.geminiPublicationBlock || version.status !== "publishing"
      || version.geminiDocumentName !== undefined || payload.operation !== "publish" || payload.storeName !== storeName
      || payload.sha256 !== version.sha256 || !/^[a-f0-9]{64}$/.test(version.sha256)
      || (payload.reasonDigest !== undefined && (typeof payload.reasonDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.reasonDigest)))
      || Object.keys(payload).some(key => !["operation", "storeName", "sha256", "reasonDigest"].includes(key))
      || locks.length !== 1 || !lock || lock.operation !== "publish" || lock.versionId !== version._id
      || lock.jobId !== job._id || lock.actorId !== job.actorId || lock.idempotencyKey !== job.idempotencyKey
      || (lock.jurisdictionId !== undefined && lock.jurisdictionId !== row._id)
      || (job.lastErrorKind !== undefined && !["timeout", "network", "provider", "rate_limit"].includes(job.lastErrorKind))
      || (job.recoveryKind !== undefined && job.recoveryKind !== "poll_operation")
      || (job.providerOperationName !== undefined && (job.recoveryKind !== "poll_operation" || !isGeminiUploadOperationForStore(job.providerOperationName, storeName)))
      || (job.recoveryKind === "poll_operation" && job.providerOperationName === undefined)) return null;
    additions.add(job._id); explainedLocks.add(lock._id);
  }
  const jurisdictionLocks = await ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", row._id)).take(MAX_CURRENT_JOBS + 1);
  if (jurisdictionLocks.length > MAX_CURRENT_JOBS || jurisdictionLocks.some(lock => !explainedLocks.has(lock._id))) return null;
  for (const locks of resourceLocks.values()) if (locks.some(lock => !explainedLocks.has(lock._id))) return null;
  if (row.geminiExecutionPermit && !additions.has(row.geminiExecutionPermit.jobId)) return null;
  if (row.providerSyncState === "drifted" && additions.size === 0) return null;
  const requiresFilter = restriction !== undefined || additions.size > 0 || unpublishedAddition;
  if (!requiresFilter && !filterCapable) return { storeName, documents, requiresFilter };
  if (!isPublicationEnvironment(environment)) return null;
  const publicationFilter = parsePublicationFilter({ protocol: PUBLICATION_FILTER_PROTOCOL, environment, documents });
  if (!publicationFilter) return null;
  try { buildPublicationMetadataFilter([{ jurisdictionId, publicationFilter }]); } catch { return null; }
  return { storeName, documents, publicationFilter, requiresFilter };
}
