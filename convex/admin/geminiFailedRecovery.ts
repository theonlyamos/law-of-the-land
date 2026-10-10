import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { authComponent } from "../auth";
import { hasRolePermission, parseAdminRoles } from "../lib/adminPermissions";
import { isGeminiDocumentName, isGeminiUploadOperationForStore } from "../lib/geminiFileSearchNames";
import { validateAuditReason, writeAudit } from "./audit";
import { readAdminEnabled } from "./featureFlags";
import { assertCurrentLease, assertGeminiExecutionPermit, assertGeminiOriginal,
  isGeminiJobDocument, type GeminiIntegrationJob } from "./jobs";
import { resolveGeminiPublicationWorkflow } from "./publicationState";
import { patchDocumentVersion } from "./reviewCounts";
import type { DiagnosticTarget } from "./integrations/geminiDiagnostic";
import type { FailedDocumentCoverageInput } from "./integrations/geminiFailedDocumentCoverage";
import { buildPublicationMetadataFilter, isPublicationEnvironment, isPublicationMetadataId,
  MAX_PUBLISHED_FILTER_DOCUMENTS, PUBLICATION_FILTER_PROTOCOL } from "../../shared/gemini-publication-filter";

const ACTOR = "gemini_recovery";
const ACTION = "gemini_failed_document_recovery";
const MAX_PROOF_AGE_MS = 30_000;
const MIN_CONFIRMATION_AGE_MS = 5 * 60_000;
const MAX_RESOURCES = 400;
const MAX_UNRESOLVED_JOBS = 128;
const MAX_LOCKS = 128;
const RECOVERY_LEASE_MS = 15 * 60_000;
const HASH_REFERENCE = /^sha256:[a-f0-9]{64}$/;
const resultValidator = v.object({ status: v.union(v.literal("succeeded"), v.literal("failed")),
  jobId: v.id("integrationJobs"), correlationId: v.string() });
const metadataValidator = v.object({ environment: v.string(), jurisdiction_id: v.string(), resource_id: v.string(),
  version_id: v.string(), version_number: v.string(), sha256: v.string() });
const coverageValidator = v.object({
  target: v.object({ storeName: v.string(), operationName: v.string(), metadata: metadataValidator }),
  published: v.array(v.object({ documentName: v.string(), metadata: metadataValidator })),
  excluded: v.array(v.object({ metadata: metadataValidator, documentReference: v.optional(v.string()) })),
});
const attemptArgs = { operationId: v.id("adminOperations"), leaseToken: v.string(), binding: v.string(), jurisdictionId: v.id("jurisdictions") };
const proofArgs = { documentReference: v.string(), operationReference: v.string(), firstObservedAt: v.number(),
  confirmedAt: v.number(), coverageVerifiedAt: v.number(), publishedCount: v.number() };
const attemptValidator = v.object(attemptArgs);
type Attempt = Infer<typeof attemptValidator>;
export type FailedDocumentRecoveryResult = Infer<typeof resultValidator>;
export type FailedDocumentRecoveryClaim = { kind: "completed"; result: FailedDocumentRecoveryResult } |
  ({ kind: "claimed"; coverage: FailedDocumentCoverageInput } & Infer<typeof attemptValidator>);
function invalid(): never { throw new ConvexError("GEMINI_FAILED_DOCUMENT_RECOVERY_INVALID"); }
async function digest(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, "0")).join("");
}
async function reference(value: string): Promise<string> {
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("")}`;
}
async function correlation(attempt: Omit<Attempt, "operationId">): Promise<string> {
  return `rec_${await digest({ leaseToken: attempt.leaseToken, binding: attempt.binding, jurisdictionId: attempt.jurisdictionId })}`;
}
async function assertPublisherAuthority(ctx: MutationCtx, job: GeminiIntegrationJob): Promise<void> {
  if (!(await readAdminEnabled(ctx))) throw new ConvexError("ADMIN_DISABLED");
  const publisher = await authComponent.getAnyUserById(ctx, job.actorId);
  if (!publisher || publisher.emailVerified !== true || publisher.twoFactorEnabled !== true || publisher.banned === true ||
      (!job.organizationId && !hasRolePermission(parseAdminRoles(publisher.role), "document", "publish"))) {
    throw new ConvexError("GEMINI_RECOVERY_PUBLISHER_UNAUTHORIZED");
  }
}
function identity(environment: string, jurisdictionId: Id<"jurisdictions">, version: Doc<"documentVersions">): DiagnosticTarget["metadata"] {
  if (!isPublicationMetadataId(jurisdictionId) || !isPublicationMetadataId(version.resourceId) || !isPublicationMetadataId(version._id) ||
      !/^[a-f0-9]{64}$/.test(version.sha256) || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1) invalid();
  return { environment, jurisdiction_id: jurisdictionId, resource_id: version.resourceId,
    version_id: version._id, version_number: String(version.versionNumber), sha256: version.sha256 };
}
async function context(ctx: MutationCtx, job: GeminiIntegrationJob, now: number) {
  if (job.type !== "gemini_index_document" || job.targetType !== "documentVersion" || job.recoveryKind !== "poll_operation" ||
      !job.providerOperationName || job.knownStoreResult !== undefined || job.failedDocumentEvidence?.coverageVerifiedAt !== undefined) invalid();
  const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
  if (workflow.kind !== "index" || workflow.payload.operation !== "publish" || workflow.previous !== null ||
      workflow.resource.activeVersionId !== undefined || workflow.resource.catalogPublished === true ||
      workflow.resource.geminiPublicationBlock !== undefined || workflow.version.geminiDocumentName !== undefined ||
      workflow.lock.actorId !== job.actorId || workflow.lock.idempotencyKey !== job.idempotencyKey ||
      (workflow.lock.jurisdictionId !== undefined && workflow.lock.jurisdictionId !== workflow.jurisdiction._id) ||
      (job.organizationId !== undefined && workflow.jurisdiction.organizationId !== job.organizationId)) invalid();
  await assertGeminiOriginal(ctx, workflow.version);
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!isPublicationEnvironment(environment)) invalid();
  const target: DiagnosticTarget = { storeName: workflow.storeName, operationName: job.providerOperationName,
    metadata: identity(environment, workflow.jurisdiction._id, workflow.version) };
  const resources = await ctx.db.query("legalResources").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", workflow.jurisdiction._id)).take(MAX_RESOURCES + 1);
  if (resources.length > MAX_RESOURCES) invalid();
  const jurisdictionLocks = await ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", workflow.jurisdiction._id)).take(MAX_LOCKS + 1);
  if (jurisdictionLocks.length > MAX_LOCKS) invalid();
  const lockMap = new Map(jurisdictionLocks.map(lock => [lock._id, lock]));
  // Older locks can omit jurisdictionId; bind every resource-scoped lock too.
  for (const resource of resources) {
    const resourceLocks = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", q => q.eq("resourceId", resource._id)).take(2);
    if (resourceLocks.length > 1) invalid();
    for (const lock of resourceLocks) lockMap.set(lock._id, lock);
    if (lockMap.size > MAX_LOCKS) invalid();
  }
  const locks = [...lockMap.values()];
  const versions = new Map<string, Doc<"documentVersions">>([[workflow.version._id, workflow.version]]);
  const recordedJobs = new Map<string, Doc<"integrationJobs">>([[job._id, job]]);
  const coverage: FailedDocumentCoverageInput = { target, published: [], excluded: [] };
  const blockedVersionIds = new Set<Id<"documentVersions">>();
  for (const resource of resources) {
    if (resource.activeVersionId !== undefined) {
      const version = await ctx.db.get(resource.activeVersionId);
      if (resource.status !== "active" || resource.catalogPublished !== true || !version || version.resourceId !== resource._id || version.status !== "published" ||
          !version.geminiDocumentName || !isGeminiDocumentName(version.geminiDocumentName) ||
          !version.geminiDocumentName.startsWith(`${workflow.storeName}/documents/`) ||
          locks.some(lock => lock.resourceId === resource._id)) invalid();
      versions.set(version._id, version);
      coverage.published.push({ documentName: version.geminiDocumentName, metadata: identity(environment, workflow.jurisdiction._id, version) });
    } else if (resource.catalogPublished === true) invalid();
    const block = resource.geminiPublicationBlock;
    if (block !== undefined) {
      const version = await ctx.db.get(block.versionId); const excludedJob = await ctx.db.get(block.jobId);
      if (!version || !excludedJob || excludedJob.status !== "failed" || excludedJob.targetId !== version._id ||
          excludedJob.targetType !== "documentVersion" || excludedJob.type !== "gemini_index_document" ||
          !excludedJob.failedDocumentEvidence || !excludedJob.providerOperationName ||
          !isGeminiUploadOperationForStore(excludedJob.providerOperationName, workflow.storeName) ||
          excludedJob.failedDocumentEvidence.operationReference !== await reference(excludedJob.providerOperationName) ||
          !HASH_REFERENCE.test(excludedJob.failedDocumentEvidence.documentReference) || version.resourceId !== resource._id ||
          version.status !== "failed" || version.sha256 !== block.sha256 || block.storeName !== workflow.storeName ||
          resource.activeVersionId !== undefined) invalid();
      versions.set(version._id, version); recordedJobs.set(excludedJob._id, excludedJob);
      blockedVersionIds.add(version._id);
      coverage.excluded.push({ metadata: identity(environment, workflow.jurisdiction._id, version), documentReference: excludedJob.failedDocumentEvidence.documentReference });
    }
  }
  const restriction = workflow.jurisdiction.geminiSearchRestriction;
  if (restriction !== undefined) {
    const failed = restriction.failedVersionIds;
    if (restriction.kind !== "published_only" || failed.length < 1 || failed.length > MAX_PUBLISHED_FILTER_DOCUMENTS ||
        new Set(failed).size !== failed.length || failed.length !== blockedVersionIds.size ||
        failed.some(id => !blockedVersionIds.has(id))) invalid();
  } else if (blockedVersionIds.size !== 0) invalid();
  const candidates: Doc<"integrationJobs">[] = [];
  for (const status of ["queued", "running", "waiting_provider", "manual_review"] as const) {
    const rows = await ctx.db.query("integrationJobs").withIndex("by_status_and_createdAt", q => q.eq("status", status)).take(MAX_UNRESOLVED_JOBS + 1 - candidates.length);
    candidates.push(...rows); if (candidates.length > MAX_UNRESOLVED_JOBS) invalid();
  }
  let otherUnresolved = 0;
  for (const candidate of candidates) {
    if (!isGeminiJobDocument(candidate)) invalid();
    let jurisdictionId: Id<"jurisdictions">;
    if (candidate.targetType === "jurisdictionGeminiStore") {
      const id = ctx.db.normalizeId("jurisdictions", candidate.targetId); if (!id) invalid(); jurisdictionId = id;
    } else if (candidate.targetType === "documentVersion") {
      const id = ctx.db.normalizeId("documentVersions", candidate.targetId); const version = id ? await ctx.db.get(id) : null;
      const resource = version ? await ctx.db.get(version.resourceId) : null; if (!version || !resource) invalid(); jurisdictionId = resource.jurisdictionId;
      if (jurisdictionId === workflow.jurisdiction._id) versions.set(version._id, version);
    } else invalid();
    if (jurisdictionId !== workflow.jurisdiction._id) continue;
    recordedJobs.set(candidate._id, candidate); if (candidate._id === job._id) continue;
    otherUnresolved++;
    if (candidate.type !== "gemini_index_document" || candidate.status !== "manual_review" || candidate.recoveryKind !== "poll_operation" ||
        !candidate.providerOperationName || !isGeminiUploadOperationForStore(candidate.providerOperationName, workflow.storeName)) invalid();
    const other = await resolveGeminiPublicationWorkflow(ctx, candidate, { kind: "active" }, now);
    if (other.kind !== "index" || other.payload.operation !== "publish" || other.previous !== null || other.resource.activeVersionId !== undefined) invalid();
    await assertGeminiOriginal(ctx, other.version);
    const documentReference = candidate.failedDocumentEvidence?.documentReference ?? candidate.failedDocumentObservation?.documentReference;
    coverage.excluded.push({ metadata: identity(environment, workflow.jurisdiction._id, other.version),
      ...(documentReference ? { documentReference } : {}) });
  }
  if (coverage.published.length < 1 || coverage.published.length > MAX_PUBLISHED_FILTER_DOCUMENTS ||
      coverage.excluded.length + 1 > MAX_PUBLISHED_FILTER_DOCUMENTS ||
      coverage.published.length + coverage.excluded.length + 1 > MAX_RESOURCES) invalid();
  try {
    buildPublicationMetadataFilter([{ jurisdictionId: workflow.jurisdiction._id, publicationFilter: {
      protocol: PUBLICATION_FILTER_PROTOCOL, environment, documents: coverage.published.map(entry => ({
        resourceId: entry.metadata.resource_id, versionId: entry.metadata.version_id, sha256: entry.metadata.sha256 })) } }]);
  } catch { invalid(); }
  coverage.published.sort((a, b) => a.documentName.localeCompare(b.documentName));
  coverage.excluded.sort((a, b) => a.metadata.version_id.localeCompare(b.metadata.version_id));
  const binding = await digest({ coverage, resources: [...resources].sort((a, b) => a._id.localeCompare(b._id)),
    versions: [...versions.values()].sort((a, b) => a._id.localeCompare(b._id)),
    jobs: [...recordedJobs.values()].sort((a, b) => a._id.localeCompare(b._id)),
    locks: [...locks].sort((a, b) => a._id.localeCompare(b._id)), jurisdiction: workflow.jurisdiction });
  return { workflow, coverage, binding, otherUnresolved, otherLocks: locks.filter(lock => lock._id !== workflow.lock._id).length };
}
function terminal(operation: Doc<"adminOperations">, jobId: Id<"integrationJobs">): FailedDocumentRecoveryResult | null {
  if (operation.status === "pending") return null;
  if ((operation.status !== "succeeded" && operation.status !== "failed") || operation.result?.status !== operation.status ||
      operation.result.action !== ACTION || operation.result.targetId !== jobId || operation.result.correlationId !== operation.correlationId) invalid();
  return { status: operation.status, jobId, correlationId: operation.correlationId };
}
async function loadAttempt(ctx: MutationCtx, args: Attempt) {
  const operation = await ctx.db.get(args.operationId);
  if (!operation || operation.actorId !== ACTOR || operation.action !== ACTION || operation.correlationId !== await correlation(args)) invalid();
  const jobId = ctx.db.normalizeId("integrationJobs", operation.targetId); if (!jobId) invalid();
  return { operation, jobId };
}
async function finishReceipt(ctx: MutationCtx, operation: Doc<"adminOperations">, jobId: Id<"integrationJobs">, status: "succeeded" | "failed") {
  const request: { jobId?: unknown; reason?: unknown } = JSON.parse(operation.requestFingerprint);
  if (request.jobId !== jobId || typeof request.reason !== "string") invalid(); const reason = validateAuditReason(request.reason);
  await ctx.db.patch(operation._id, { status, result: { status, correlationId: operation.correlationId, action: ACTION, targetId: jobId }, updatedAt: Date.now() });
  await writeAudit(ctx, { actorId: ACTOR, actorRoles: [], action: status === "succeeded" ? "document.publish.failed_document_reconciled" : "document.publish.failed_document_reconciliation_failed",
    targetType: "integrationJob", targetId: jobId, reason, correlationId: operation.correlationId, outcome: status === "succeeded" ? "success" : "failure" },
    { actorType: "system", actorUserId: "system", metadata: { method: "failed_document_reconciliation", ...(status === "succeeded" ? { evidence: "confirmed_failed_document_and_published_coverage" } : {}) } });
  return { status, jobId, correlationId: operation.correlationId };
}
async function releaseOwnedAttempt(ctx: MutationCtx, args: Attempt, jobId: Id<"integrationJobs">): Promise<void> {
  const job = await ctx.db.get(jobId);
  if (job?.status !== "running" || job.leaseToken !== args.leaseToken) return;
  const jurisdiction = await ctx.db.get(args.jurisdictionId); const permit = jurisdiction?.geminiExecutionPermit;
  if (jurisdiction && permit?.jobId === job._id && permit.leaseExpiresAt === job.leaseExpiresAt) {
    await ctx.db.patch(jurisdiction._id, { geminiExecutionPermit: undefined, contentRevision: (jurisdiction.contentRevision ?? 0) + 1 });
  }
  await ctx.db.patch(job._id, { status: "manual_review", leaseToken: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined, updatedAt: Date.now() });
}
/** A confirmed failure intentionally cannot be claimed by the ordinary upload/poll runner. */
async function claimRecoveryLease(ctx: MutationCtx, job: GeminiIntegrationJob, jurisdiction: Doc<"jurisdictions">) {
  const now = Date.now();
  if (job.status !== "manual_review" || job.leaseToken !== undefined || job.leaseExpiresAt !== undefined ||
      (job.nextAttemptAt !== undefined && job.nextAttemptAt > now)) invalid();
  if (jurisdiction.geminiExecutionPermit !== undefined) throw new ConvexError("GEMINI_EXECUTION_BUSY");
  const leaseToken = `lease_${crypto.randomUUID().replaceAll("-", "")}`;
  const leaseExpiresAt = now + RECOVERY_LEASE_MS;
  const claimedJob: GeminiIntegrationJob = { ...job, status: "running", leaseToken, leaseExpiresAt, nextAttemptAt: leaseExpiresAt, updatedAt: now };
  await ctx.db.patch(jurisdiction._id, { contentRevision: (jurisdiction.contentRevision ?? 0) + 1,
    geminiExecutionPermit: { jobId: job._id, leaseExpiresAt } });
  await ctx.db.patch(job._id, { status: "running", leaseToken, leaseExpiresAt, nextAttemptAt: leaseExpiresAt, updatedAt: now });
  return { leaseToken, job: claimedJob };
}
export const claimFailedDocumentRecovery = internalMutation({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: v.union(v.object({ kind: v.literal("completed"), result: resultValidator }), v.object({ kind: v.literal("claimed"), ...attemptArgs, coverage: coverageValidator })),
  handler: async (ctx, args): Promise<FailedDocumentRecoveryClaim> => {
    const reason = validateAuditReason(args.reason);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(args.idempotencyKey)) throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
    const job = await ctx.db.get(args.jobId); if (!job || !isGeminiJobDocument(job)) invalid(); await assertPublisherAuthority(ctx, job);
    const fingerprint = JSON.stringify({ action: ACTION, jobId: job._id, reason });
    const operations = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", q => q.eq("actorId", ACTOR).eq("idempotencyKey", args.idempotencyKey)).take(2);
    if (operations.length > 1) invalid();
    if (operations[0]) {
      const operation = operations[0]; if (operation.action !== ACTION || operation.targetId !== job._id || operation.requestFingerprint !== fingerprint) throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
      const result = terminal(operation, job._id); if (result) return { kind: "completed", result }; throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
    }
    if (job.status !== "manual_review" || job.leaseToken !== undefined || job.leaseExpiresAt !== undefined) invalid();
    const initial = await context(ctx, job, Date.now());
    const claim = await claimRecoveryLease(ctx, job, initial.workflow.jurisdiction);
    const current = await context(ctx, claim.job, Date.now());
    const attempt = { leaseToken: claim.leaseToken, binding: current.binding, jurisdictionId: current.workflow.jurisdiction._id };
    const correlationId = await correlation(attempt); const now = Date.now();
    const operationId = await ctx.db.insert("adminOperations", { actorId: ACTOR, action: ACTION, targetId: job._id, idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint, correlationId, status: "pending", createdAt: now, updatedAt: now });
    return { kind: "claimed", operationId, ...attempt, coverage: current.coverage };
  },
});
/** The proof is supplied only by the internal GET-only verifier, never by a browser or CLI-crafted completion. */
export const completeFailedDocumentRecovery = internalMutation({
  args: { ...attemptArgs, ...proofArgs }, returns: resultValidator,
  handler: async (ctx, args): Promise<FailedDocumentRecoveryResult> => {
    const { operation, jobId } = await loadAttempt(ctx, args); const replay = terminal(operation, jobId); if (replay) return replay;
    const now = Date.now();
    if (!HASH_REFERENCE.test(args.documentReference) || !HASH_REFERENCE.test(args.operationReference) ||
        !Number.isFinite(args.firstObservedAt) || !Number.isFinite(args.confirmedAt) || args.firstObservedAt < operation.createdAt ||
        args.confirmedAt < args.firstObservedAt || args.confirmedAt > now || now - args.confirmedAt > MAX_PROOF_AGE_MS ||
        args.coverageVerifiedAt !== args.confirmedAt || !Number.isSafeInteger(args.publishedCount)) invalid();
    const job = await ctx.db.get(jobId); if (!job || !isGeminiJobDocument(job)) invalid();
    assertCurrentLease(job, args.leaseToken, now); const permitJurisdiction = await assertGeminiExecutionPermit(ctx, job, now); await assertPublisherAuthority(ctx, job);
    const current = await context(ctx, job, now);
    if (current.binding !== args.binding || current.workflow.jurisdiction._id !== args.jurisdictionId || permitJurisdiction?._id !== args.jurisdictionId ||
        args.publishedCount !== current.coverage.published.length || args.operationReference !== await reference(current.coverage.target.operationName)) invalid();
    const prior = job.failedDocumentObservation ?? (job.failedDocumentEvidence ? { documentReference: job.failedDocumentEvidence.documentReference,
      operationReference: job.failedDocumentEvidence.operationReference, observedAt: job.failedDocumentEvidence.firstObservedAt } : undefined);
    if (prior && (prior.documentReference !== args.documentReference || prior.operationReference !== args.operationReference ||
        !Number.isFinite(prior.observedAt) || prior.observedAt > now)) invalid();
    if (!prior || now - prior.observedAt < MIN_CONFIRMATION_AGE_MS) {
      if (!prior) await ctx.db.patch(job._id, { failedDocumentObservation: { documentReference: args.documentReference, operationReference: args.operationReference, observedAt: args.firstObservedAt } });
      await releaseOwnedAttempt(ctx, args, jobId);
      return await finishReceipt(ctx, operation, jobId, "failed");
    }
    const workflow = current.workflow; const restriction = workflow.jurisdiction.geminiSearchRestriction;
    const failedVersionIds = [...new Set([...(restriction?.failedVersionIds ?? []), workflow.version._id])].sort();
    if (failedVersionIds.length > MAX_PUBLISHED_FILTER_DOCUMENTS) invalid();
    const priorErrorKind = job.failedDocumentEvidence?.priorErrorKind ?? job.lastErrorKind;
    await patchDocumentVersion(ctx, workflow.version._id, { status: "failed", failureSummary: "Gemini reports failed document processing. The provider did not supply the cause. This version is excluded; another upload is blocked while the original operation remains pending.", updatedAt: now });
    await ctx.db.patch(workflow.resource._id, { geminiPublicationBlock: { jobId: job._id, versionId: workflow.version._id, storeName: workflow.storeName,
      sha256: workflow.version.sha256, recordedAt: now }, catalogPublished: false, updatedAt: now });
    await ctx.db.patch(job._id, { status: "failed", leaseToken: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined, recoveryKind: undefined,
      failedDocumentEvidence: { documentReference: args.documentReference, operationReference: args.operationReference,
        firstObservedAt: prior.observedAt, confirmedAt: args.confirmedAt,
        ...(priorErrorKind ? { priorErrorKind } : {}),
        priorProviderPollCount: job.failedDocumentEvidence?.priorProviderPollCount ?? job.providerPollCount ?? 0,
        observedOperationDone: false, observedDocumentState: "STATE_FAILED", coverageVerifiedAt: args.coverageVerifiedAt, publishedCount: args.publishedCount },
      updatedAt: now, retentionPending: true });
    await ctx.db.delete(workflow.lock._id);
    // The sticky restriction is installed in the same transaction, before search can become ready.
    await ctx.db.patch(workflow.jurisdiction._id, { geminiSearchRestriction: { kind: "published_only", establishedAt: restriction?.establishedAt ?? now, failedVersionIds },
      providerSyncState: current.otherUnresolved === 0 && current.otherLocks === 0 ? "synced" : "drifted",
      geminiExecutionPermit: undefined, contentRevision: (workflow.jurisdiction.contentRevision ?? 0) + 1, updatedAt: now });
    await writeAudit(ctx, { actorId: job.actorId, actorRoles: job.actorRoles, action: "document.publish.failure", targetType: "documentVersion", targetId: workflow.version._id, correlationId: job.correlationId, outcome: "failure" });
    await writeAudit(ctx, { actorId: job.actorId, actorRoles: job.actorRoles, action: "integration.job_failed", targetType: "integrationJob", targetId: job._id, correlationId: job.correlationId, outcome: "failure" });
    return await finishReceipt(ctx, operation, jobId, "succeeded");
  },
});
export const abortFailedDocumentRecovery = internalMutation({
  args: attemptArgs, returns: resultValidator,
  handler: async (ctx, args): Promise<FailedDocumentRecoveryResult> => {
    const { operation, jobId } = await loadAttempt(ctx, args); const replay = terminal(operation, jobId); if (replay) return replay;
    await releaseOwnedAttempt(ctx, args, jobId); return await finishReceipt(ctx, operation, jobId, "failed");
  },
});
