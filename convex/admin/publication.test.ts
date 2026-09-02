/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;

const submitForReview = makeFunctionReference<"mutation">("admin/reviews:submitForReview");
const approveVersion = makeFunctionReference<"mutation">("admin/reviews:approveVersion");
const rejectVersion = makeFunctionReference<"mutation">("admin/reviews:rejectVersion");
const publishVersion = makeFunctionReference<"mutation">("admin/publication:publishVersion");
const unpublishVersion = makeFunctionReference<"mutation">("admin/publication:unpublishVersion");
const rollbackVersion = makeFunctionReference<"mutation">("admin/publication:rollbackVersion");
const claimJob = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const getGeminiJobTarget = makeFunctionReference<"query">("admin/jobs:getGeminiJobTarget");
const applyGeminiProviderResult = makeFunctionReference<"mutation">("admin/jobs:applyGeminiProviderResult");
const recordProviderFailure = makeFunctionReference<"mutation">("admin/jobs:recordProviderFailure");
const retryJob = makeFunctionReference<"mutation">("admin/jobs:retryJob");
const reconcileStaleJobs = makeFunctionReference<"mutation">("admin/jobs:reconcileStaleJobs");
const runGeminiJob = makeFunctionReference<"action">("admin/geminiActions:runGeminiJob");
const recordAdminStepUpProof = makeFunctionReference<"mutation">("admin/users:recordAdminStepUpProof");
const expireLifecycleLock = makeFunctionReference<"mutation">("admin/publication:expireLifecycleLock");
const listReviewQueue = makeFunctionReference<"query">("admin/reviews:listReviewQueue");

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() });
  });
}

async function asAdmin(t: Backend, role: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: `${role} fixture`, email: `${role}-${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: `session-${crypto.randomUUID()}`, userId: user._id, expiresAt: now + 60_000, createdAt: now, updatedAt: now, adminTwoFactorVerifiedAt: now } } });
    return { userId: user._id, sessionId: session._id };
  });
  return { client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }), ...identity };
}

async function sha256(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type VersionStatus = "draft" | "ready_for_review" | "approved" | "published" | "superseded";
async function seedCatalog(t: Backend, submitterId: string, statuses: VersionStatus[]) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      code: "GH", name: "Ghana", slug: `ghana-${crypto.randomUUID()}`, status: "enabled", isDefault: true,
      geminiFileSearchStoreName: "fileSearchStores/ghana-test", geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced", createdBy: submitterId, updatedBy: submitterId, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: "Data Protection Act", issuer: "Parliament", officialCitation: "Act 843",
      officialCitationKey: "act 843", sourceUrl: "https://laws.example.gov/act-843", topics: ["privacy"],
      effectiveDate: "2012-10-16", status: "active", createdBy: submitterId, updatedBy: submitterId, createdAt: now, updatedAt: now,
    });
    const ids: Id<"documentVersions">[] = [];
    for (let index = 0; index < statuses.length; index += 1) {
      const body = `version-${index + 1}`;
      const originalStorageId = await ctx.storage.store(new Blob([body], { type: "application/pdf" }));
      const status = statuses[index];
      ids.push(await ctx.db.insert("documentVersions", {
        resourceId, versionNumber: index + 1, originalStorageId, filename: `act-843-v${index + 1}.pdf`,
        mimeType: "application/pdf", byteSize: body.length, sha256: await sha256(body), sourceUrl: "https://laws.example.gov/act-843",
        effectiveDate: "2012-10-16", status,
        ...(status === "published" || status === "superseded" ? { geminiDocumentName: `fileSearchStores/ghana-test/documents/version-${index + 1}`, geminiIndexedAt: now, publishedAt: now } : {}),
        submittedBy: submitterId, ...(status === "draft" ? {} : { submittedAt: now }),
        ...(["approved", "published", "superseded"].includes(status) ? { reviewedBy: "prior-reviewer", reviewedAt: now } : {}),
        createdAt: now + index, updatedAt: now + index,
      }));
    }
    const activeIndex = statuses.findIndex((status) => status === "published");
    if (activeIndex >= 0) await ctx.db.patch(resourceId, { activeVersionId: ids[activeIndex] });
    return { jurisdictionId, resourceId, ids };
  });
}

async function addStepUp(t: Backend, actor: { userId: string; sessionId: string }, action: string, targetId: string, idempotencyKey: string) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("adminStepUpProofs", { actorId: actor.userId, sessionId: actor.sessionId, action, targetId, idempotencyKey, issuedAt: now, expiresAt: now + 300_000 });
  });
}

async function completeIndex(t: Backend, jobId: Id<"integrationJobs">, documentId: string) {
  const execute = await t.mutation(claimJob, { jobId });
  if (!execute) throw new Error("expected index execution claim");
  const executionTarget = await t.query(getGeminiJobTarget, { jobId, leaseToken: execute.leaseToken });
  await t.mutation(applyGeminiProviderResult, { jobId, leaseToken: execute.leaseToken, result: { kind: "index_accepted", operationName: `fileSearchStores/ghana-test/upload/operations/${documentId}` } });
  await t.run(async (ctx) => ctx.db.patch(jobId, { nextAttemptAt: Date.now() - 1 }));
  const poll = await t.mutation(claimJob, { jobId });
  if (!poll) throw new Error("expected index poll claim");
  const pollTarget = await t.query(getGeminiJobTarget, { jobId, leaseToken: poll.leaseToken });
  await t.mutation(applyGeminiProviderResult, { jobId, leaseToken: poll.leaseToken, result: { kind: "index_completed", documentName: `fileSearchStores/ghana-test/documents/${documentId}` } });
  return { executionTarget, pollTarget };
}

async function claimAcceptedIndexPoll(t: Backend, jobId: Id<"integrationJobs">, operationId: string) {
  const execute = await t.mutation(claimJob, { jobId });
  if (!execute) throw new Error("expected index execution claim");
  await t.mutation(applyGeminiProviderResult, {
    jobId,
    leaseToken: execute.leaseToken,
    result: { kind: "index_accepted", operationName: `fileSearchStores/ghana-test/upload/operations/${operationId}` },
  });
  await t.run(async (ctx) => ctx.db.patch(jobId, { nextAttemptAt: Date.now() - 1 }));
  const poll = await t.mutation(claimJob, { jobId });
  if (!poll) throw new Error("expected index poll claim");
  return poll;
}

async function completeDelete(t: Backend, jobId: Id<"integrationJobs">) {
  const claim = await t.mutation(claimJob, { jobId });
  if (!claim) throw new Error("expected delete claim");
  const target = await t.query(getGeminiJobTarget, { jobId, leaseToken: claim.leaseToken });
  await t.mutation(applyGeminiProviderResult, { jobId, leaseToken: claim.leaseToken, result: { kind: "document_deleted" } });
  return target;
}

const checklist = { sourceAuthentic: true, metadataAccurate: true, extractionReviewed: true, citationsVerified: true, evaluationPassed: true };
const originalEnabled = process.env.ADMIN_PANEL_ENABLED;
const originalEnvironment = process.env.ADMIN_ENVIRONMENT;
const originalGoogleApiKey = process.env.GOOGLE_AI_API_KEY;
afterEach(() => {
  if (originalEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED; else process.env.ADMIN_PANEL_ENABLED = originalEnabled;
  if (originalEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT; else process.env.ADMIN_ENVIRONMENT = originalEnvironment;
  if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_AI_API_KEY; else process.env.GOOGLE_AI_API_KEY = originalGoogleApiKey;
});

describe("governed document publication", () => {
  it("submits a verified Convex original for review without provider evidence or jobs", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager,content_reviewer");
    const reviewer = await asAdmin(t, "content_reviewer");
    const { ids } = await seedCatalog(t, manager.userId, ["draft"]);
    await manager.client.mutation(submitForReview, { versionId: ids[0], reason: "Ready for independent legal review", idempotencyKey: "submit-version-1" });
    await expect(manager.client.mutation(approveVersion, { versionId: ids[0], checklistAnswers: checklist, evaluationRunId: "evaluation-2026-01", reason: "Independent review complete", idempotencyKey: "approve-version-1" })).rejects.toThrow("different reviewer");
    await reviewer.client.mutation(approveVersion, { versionId: ids[0], checklistAnswers: checklist, evaluationRunId: "evaluation-2026-01", reason: "Independent review complete", idempotencyKey: "approve-version-1" });
    const docket = await reviewer.client.query(listReviewQueue, { status: "approved", paginationOpts: { numItems: 10, cursor: null } });
    expect(docket.page[0]).toMatchObject({ id: ids[0], status: "approved", sourceHost: "laws.example.gov" });
    expect(docket.page[0]).not.toHaveProperty("stagingDocumentId");
    expect(docket.page[0]).not.toHaveProperty("xrayEvidence");
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(1))).toHaveLength(0);
  });

  it("allows a super administrator to approve and publish their own submission", async () => {
    const t = createBackend();
    await enablePanel(t);
    const administrator = await asAdmin(t, "super_admin");
    const { ids } = await seedCatalog(t, administrator.userId, ["draft"]);

    await administrator.client.mutation(submitForReview, {
      versionId: ids[0],
      reason: "Submit for super administrator review",
      idempotencyKey: "super-admin-submit-1",
    });
    await expect(administrator.client.mutation(approveVersion, {
      versionId: ids[0],
      checklistAnswers: checklist,
      evaluationRunId: "super-admin-evaluation-1",
      reason: "Super administrator review complete",
      idempotencyKey: "super-admin-approve-1",
    })).resolves.toMatchObject({ status: "approved", versionId: ids[0] });

    const publishKey = "super-admin-publish-1";
    await addStepUp(t, administrator, "document_publish", ids[0], publishKey);
    await expect(administrator.client.mutation(publishVersion, {
      versionId: ids[0],
      confirmation: `PUBLISH ${ids[0]}`,
      reason: "Publish the approved legal original",
      idempotencyKey: publishKey,
    })).resolves.toMatchObject({ type: "gemini_index", duplicate: false });
  });

  it("rejects review submission when the immutable original checksum no longer matches", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const { ids } = await seedCatalog(t, manager.userId, ["draft"]);
    await t.run(async (ctx) => ctx.db.patch(ids[0], { sha256: "0".repeat(64) }));
    await expect(manager.client.mutation(submitForReview, { versionId: ids[0], reason: "Submit altered record", idempotencyKey: "submit-altered-1" })).rejects.toThrow("DOCUMENT_CHECKSUM_MISMATCH");
  });

  it("preserves review idempotency, validation, rejection, and bounded pagination governance", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const reviewer = await asAdmin(t, "content_reviewer");
    const review = await seedCatalog(t, manager.userId, ["ready_for_review"]);
    await expect(reviewer.client.mutation(approveVersion, { versionId: review.ids[0], checklistAnswers: { ...checklist, citationsVerified: false }, evaluationRunId: "evaluation-incomplete", reason: "Incomplete review", idempotencyKey: "review-incomplete-1" })).rejects.toThrow("DOCUMENT_CHECKLIST_INCOMPLETE");
    await expect(reviewer.client.mutation(rejectVersion, { versionId: review.ids[0], checklistAnswers: checklist, evaluationRunId: "x".repeat(129), reason: "Reject invalid evaluation", idempotencyKey: "review-invalid-evaluation" })).rejects.toThrow("DOCUMENT_EVALUATION_INVALID");
    const rejected = await reviewer.client.mutation(rejectVersion, { versionId: review.ids[0], checklistAnswers: { ...checklist, extractionReviewed: false }, evaluationRunId: "evaluation-reject-1", reason: "Original text does not match", idempotencyKey: "review-reject-1" });
    await expect(reviewer.client.mutation(rejectVersion, { versionId: review.ids[0], checklistAnswers: { ...checklist, extractionReviewed: false }, evaluationRunId: "evaluation-reject-1", reason: "Original text does not match", idempotencyKey: "review-reject-1" })).resolves.toEqual(rejected);
    await expect(reviewer.client.mutation(rejectVersion, { versionId: review.ids[0], checklistAnswers: checklist, evaluationRunId: "evaluation-other", reason: "Different request", idempotencyKey: "review-reject-1" })).rejects.toThrow("DOCUMENT_IDEMPOTENCY_CONFLICT");

    const catalog = await seedCatalog(t, manager.userId, Array.from({ length: 13 }, () => "published" as const));
    const first = await reviewer.client.query(listReviewQueue, { status: "published", paginationOpts: { numItems: 12, cursor: null } });
    expect(first.page).toHaveLength(12);
    expect(first.page[0].id).toBe(catalog.ids[12]);
    const second = await reviewer.client.query(listReviewQueue, { status: "published", paginationOpts: { numItems: 12, cursor: first.continueCursor } });
    expect(second.page.map((row: { id: Id<"documentVersions"> }) => row.id)).toEqual([catalog.ids[0]]);
    expect(second.isDone).toBe(true);
  });

  it("rechecks feature, permission, impersonation, and step-up proof scope", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const auditor = await asAdmin(t, "auditor");
    const { ids } = await seedCatalog(t, "manager", ["approved"]);
    const request = { versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish governed original", idempotencyKey: "authority-publish-1" };
    await addStepUp(t, auditor, "document_publish", ids[0], request.idempotencyKey);
    await expect(auditor.client.mutation(publishVersion, request)).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(t.mutation(recordAdminStepUpProof, { actorId: auditor.userId, sessionId: auditor.sessionId, action: "document_publish", targetId: ids[0], idempotencyKey: "scope-proof-1" })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
    await expect(t.mutation(recordAdminStepUpProof, { actorId: reviewer.userId, sessionId: reviewer.sessionId, action: "document_publish", targetId: ids[0], idempotencyKey: "scope-proof-1" })).resolves.toBeNull();

    await addStepUp(t, reviewer, "document_publish", ids[0], request.idempotencyKey);
    await t.run(async (ctx) => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", operator: "eq", value: reviewer.sessionId }], update: { impersonatedBy: "original-admin" } } }));
    await expect(reviewer.client.mutation(publishVersion, request)).rejects.toThrow("Impersonated sessions");
    const fresh = await asAdmin(t, "content_reviewer");
    await addStepUp(t, fresh, "document_publish", ids[0], request.idempotencyKey);
    await t.run(async (ctx) => {
      const flag = await ctx.db.query("featureFlags").withIndex("by_key_and_environment", (q) => q.eq("key", "admin_panel").eq("environment", "test")).unique();
      if (flag) await ctx.db.patch(flag._id, { enabled: false, updatedAt: Date.now() });
    });
    await expect(fresh.client.mutation(publishVersion, request)).rejects.toThrow("ADMIN_DISABLED");
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(2))).toHaveLength(0);
  });

  it("rejects publication idempotency conflicts and safely recovers an expired untouched lock", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[1], "stale-publication-1");
    const request = { versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish approved replacement", idempotencyKey: "stale-publication-1" };
    const queued = await publisher.client.mutation(publishVersion, request);
    await expect(publisher.client.mutation(publishVersion, { ...request, reason: "Conflicting reason" })).rejects.toThrow("INTEGRATION_IDEMPOTENCY_CONFLICT");
    const lockId = await t.run(async (ctx) => {
      const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).unique();
      if (!lock) throw new Error("expected lifecycle lock");
      await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
      return lock._id;
    });
    await t.mutation(expireLifecycleLock, { lockId });
    const expired = await t.run(async (ctx) => ({ job: await ctx.db.get(queued.jobId as Id<"integrationJobs">), candidate: await ctx.db.get(ids[1]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(expired.job?.status).toBe("cancelled");
    expect(expired.candidate?.status).toBe("approved");
    expect(expired.locks).toHaveLength(0);
    await addStepUp(t, publisher, "document_publish", ids[1], "stale-publication-2");
    await expect(publisher.client.mutation(publishVersion, { ...request, idempotencyKey: "stale-publication-2", reason: "Retry safely after expiry" })).resolves.toMatchObject({ type: "gemini_index", duplicate: false });
  });

  it("first publish uploads once with the exact bounded metadata and activates only after completion", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "first-publish-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish approved original", idempotencyKey: "first-publish-1" });
    expect(queued).toMatchObject({ type: "gemini_index", duplicate: false });
    expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBeUndefined();
    const { executionTarget, pollTarget } = await completeIndex(t, queued.jobId, "first-publish");
    const version = await t.run(async (ctx) => ctx.db.get(ids[0]));
    expect(executionTarget).toMatchObject({ kind: "index_document", signedUrl: expect.stringMatching(/^https?:\/\//), customMetadata: [
      { key: "environment", stringValue: "test" },
      { key: "jurisdiction_id", stringValue: jurisdictionId },
      { key: "resource_id", stringValue: resourceId },
      { key: "version_id", stringValue: ids[0] },
      { key: "version_number", stringValue: "1" },
      { key: "sha256", stringValue: version?.sha256 },
    ] });
    expect(pollTarget).not.toHaveProperty("signedUrl");
    expect(version).toMatchObject({ status: "published", geminiDocumentName: "fileSearchStores/ghana-test/documents/first-publish" });
    expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBe(ids[0]);
  });

  it("replacement keeps the prior active until new indexing and old deletion both succeed", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[1], "replacement-publish-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish replacement", idempotencyKey: "replacement-publish-1" });
    await completeIndex(t, queued.jobId, "replacement-v2");
    const indexed = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), previous: await ctx.db.get(ids[0]), candidate: await ctx.db.get(ids[1]), jobs: await ctx.db.query("integrationJobs").take(3) }));
    expect(indexed.resource?.activeVersionId).toBe(ids[0]);
    expect(indexed.previous?.status).toBe("published");
    expect(indexed.candidate?.status).toBe("publishing");
    const deletion = indexed.jobs.find((job) => job.type === "gemini_delete_document");
    if (!deletion) throw new Error("expected replacement deletion");
    await expect(completeDelete(t, deletion._id)).resolves.toMatchObject({ kind: "delete_document", documentName: "fileSearchStores/ghana-test/documents/version-1" });
    const final = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), previous: await ctx.db.get(ids[0]), candidate: await ctx.db.get(ids[1]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.resource?.activeVersionId).toBe(ids[1]);
    expect(final.previous).toMatchObject({ status: "superseded" });
    expect(final.previous?.geminiDocumentName).toBeUndefined();
    expect(final.candidate).toMatchObject({ status: "published", geminiDocumentName: "fileSearchStores/ghana-test/documents/replacement-v2" });
    expect(final.locks).toHaveLength(0);
  });

  it("restores a terminally failed index candidate and preserves the active pointer", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[1], "failed-publish-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish replacement", idempotencyKey: "failed-publish-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected failed index claim");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "validation" });
    const state = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), candidate: await ctx.db.get(ids[1]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(state.resource?.activeVersionId).toBe(ids[0]);
    expect(state.candidate).toMatchObject({ status: "approved", failureSummary: "Publishing failed. The previous published version is still active." });
    expect(state.locks).toHaveLength(0);
  });

  it("persists the approved manual-review message when an index outcome is uncertain", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "uncertain-index-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish approved original", idempotencyKey: "uncertain-index-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected uncertain index claim");
    const failure = await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    expect(failure.status).toBe("manual_review");
    const state = await t.run(async (ctx) => ({ jurisdiction: await ctx.db.get(jurisdictionId), version: await ctx.db.get(ids[0]) }));
    expect(state.jurisdiction?.providerSyncState).toBe("drifted");
    expect(state.version).toMatchObject({ status: "publishing", failureSummary: "Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job." });
  });

  it("rollback reindexes the immutable original, and unpublish deletes before clearing state", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["superseded", "published"]);
    await t.run(async (ctx) => ctx.db.patch(ids[0], { geminiDocumentName: undefined, geminiIndexedAt: undefined }));
    await addStepUp(t, publisher, "document_rollback", ids[0], "rollback-version-1");
    const rollback = await publisher.client.mutation(rollbackVersion, { versionId: ids[0], confirmation: `ROLLBACK ${ids[0]}`, reason: "Restore verified original", idempotencyKey: "rollback-version-1" });
    await completeIndex(t, rollback.jobId, "rollback-v1");
    const deleteCurrent = await t.run(async (ctx) => (await ctx.db.query("integrationJobs").take(3)).find((job) => job.type === "gemini_delete_document"));
    if (!deleteCurrent) throw new Error("expected rollback deletion");
    await completeDelete(t, deleteCurrent._id);
    expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBe(ids[0]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "unpublish-version-1");
    const unpublish = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Withdraw indexed original", idempotencyKey: "unpublish-version-1" });
    expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBe(ids[0]);
    await completeDelete(t, unpublish.jobId);
    const final = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]) }));
    expect(final.resource?.activeVersionId).toBeUndefined();
    expect(final.version?.status).toBe("unpublished");
    expect(final.version?.geminiDocumentName).toBeUndefined();
  });

  it("serializes concurrent lifecycle commands and collapses an identical replay", async () => {
    const t = createBackend();
    await enablePanel(t);
    const first = await asAdmin(t, "content_reviewer");
    const second = await asAdmin(t, "content_reviewer");
    const { ids } = await seedCatalog(t, "manager", ["published", "superseded", "approved"]);
    await addStepUp(t, first, "document_publish", ids[2], "concurrent-publish-1");
    const request = { versionId: ids[2], confirmation: `PUBLISH ${ids[2]}`, reason: "Publish one approved version", idempotencyKey: "concurrent-publish-1" };
    const replay = await Promise.all([first.client.mutation(publishVersion, request), first.client.mutation(publishVersion, request)]);
    expect(replay.map((row) => row.duplicate).sort()).toEqual([false, true]);
    await addStepUp(t, second, "document_rollback", ids[1], "competing-rollback-1");
    await expect(second.client.mutation(rollbackVersion, { versionId: ids[1], confirmation: `ROLLBACK ${ids[1]}`, reason: "Competing rollback", idempotencyKey: "competing-rollback-1" })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");
  });

  it("fails publication and signed-original issuance closed during store teardown", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const first = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", first.ids[0], "teardown-blocked-1");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("integrationJobs", { type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: first.jurisdictionId, payload: JSON.stringify({ storeName: "fileSearchStores/ghana-test" }), actorId: "admin", actorRoles: ["super_admin"], idempotencyKey: "teardown-active-1", requestFingerprint: "a".repeat(64), correlationId: "job_teardown_active_1", status: "queued", attemptCount: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
      for (let index = 0; index < 26; index += 1) {
        await ctx.db.insert("integrationJobs", { type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: first.jurisdictionId, payload: JSON.stringify({ storeName: "fileSearchStores/ghana-test" }), actorId: "admin", actorRoles: ["super_admin"], idempotencyKey: `completed-teardown-${index}`, requestFingerprint: String(index).padStart(64, "0"), correlationId: `job_completed_teardown_${index}`, status: "succeeded", attemptCount: 1, createdAt: now + index + 1, updatedAt: now + index + 1 });
      }
    });
    await expect(publisher.client.mutation(publishVersion, { versionId: first.ids[0], confirmation: `PUBLISH ${first.ids[0]}`, reason: "Must wait for teardown", idempotencyKey: "teardown-blocked-1" })).rejects.toThrow("GEMINI_STORE_TEARDOWN_IN_PROGRESS");

    const t2 = createBackend();
    await enablePanel(t2);
    const publisher2 = await asAdmin(t2, "content_reviewer");
    const second = await seedCatalog(t2, "manager", ["approved"]);
    await addStepUp(t2, publisher2, "document_publish", second.ids[0], "teardown-race-1");
    const queued = await publisher2.client.mutation(publishVersion, { versionId: second.ids[0], confirmation: `PUBLISH ${second.ids[0]}`, reason: "Begin publication", idempotencyKey: "teardown-race-1" });
    const claim = await t2.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected claimed publication");
    await t2.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("integrationJobs", { type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: second.jurisdictionId, payload: JSON.stringify({ storeName: "fileSearchStores/ghana-test" }), actorId: "admin", actorRoles: ["super_admin"], idempotencyKey: "teardown-race-job", requestFingerprint: "b".repeat(64), correlationId: "job_teardown_race", status: "running", attemptCount: 1, leaseToken: "lease_teardown", leaseExpiresAt: now + 60_000, nextAttemptAt: now + 60_000, createdAt: now, updatedAt: now });
    });
    await expect(t2.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: claim.leaseToken })).rejects.toThrow("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
    await expect(t2.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "validation" })).rejects.toThrow("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
    const blocked = await t2.run(async (ctx) => ({ version: await ctx.db.get(second.ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(blocked.version?.status).toBe("publishing");
    expect(blocked.locks).toHaveLength(1);
  });

  it("marks uncertain deletion drifted and retains the lifecycle lock and active pointer", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "uncertain-delete-1");
    const queued = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Withdraw indexed original", idempotencyKey: "uncertain-delete-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected delete claim");
    const failure = await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    expect(failure.status).toBe("manual_review");
    const state = await t.run(async (ctx) => ({ jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(state.jurisdiction?.providerSyncState).toBe("drifted");
    expect(state.resource?.activeVersionId).toBe(ids[0]);
    expect(state.version?.status).toBe("published");
    expect(state.locks).toHaveLength(1);
  });

  it("fails a delete completion closed when jurisdiction readiness changes after target issuance", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "readiness-race-1");
    const queued = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Withdraw indexed original", idempotencyKey: "readiness-race-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected delete claim");
    await t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: claim.leaseToken });
    await t.run(async (ctx) => ctx.db.patch(jurisdictionId, { providerSyncState: "drifted" }));
    await expect(t.mutation(applyGeminiProviderResult, { jobId: queued.jobId, leaseToken: claim.leaseToken, result: { kind: "document_deleted" } })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    const state = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(state.resource?.activeVersionId).toBe(ids[0]);
    expect(state.version?.status).toBe("published");
    expect(state.locks).toHaveLength(1);
  });

  it.each([
    "mismatched_payload_operation",
    "wrong_lock_operation",
    "wrong_lock_job",
    "wrong_lock_version",
    "stale_active_pointer",
    "candidate_state_mismatch",
    "candidate_document_mismatch",
    "cross_store_document",
    "nonunique_store_ownership",
    "teardown_in_progress",
  ] as const)("refuses to bind delete recovery provenance for %s", async (adversary) => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const replacement = adversary === "candidate_state_mismatch" || adversary === "candidate_document_mismatch";
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    let jobId: Id<"integrationJobs">;
    if (replacement) {
      await addStepUp(t, publisher, "document_publish", ids[1], `adversarial-${adversary}`);
      const queued = await publisher.client.mutation(publishVersion, {
        versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish replacement", idempotencyKey: `adversarial-${adversary}`,
      });
      await completeIndex(t, queued.jobId, "candidate-mismatch");
      const deleteJob = await t.run(async (ctx) => (await ctx.db.query("integrationJobs").take(5)).find((job) => job.type === "gemini_delete_document"));
      if (!deleteJob) throw new Error("expected replacement delete job");
      jobId = deleteJob._id;
    } else {
      await addStepUp(t, publisher, "document_unpublish", ids[0], `adversarial-${adversary}`);
      const queued = await publisher.client.mutation(unpublishVersion, {
        versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove published original", idempotencyKey: `adversarial-${adversary}`,
      });
      jobId = queued.jobId;
    }
    const claim = await t.mutation(claimJob, { jobId });
    if (!claim) throw new Error("expected delete claim");

    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const locks = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).take(2);
      if (!job || locks.length !== 1) throw new Error("missing adversarial fixture");
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      if (adversary === "mismatched_payload_operation") {
        await ctx.db.patch(jobId, { payload: JSON.stringify({ ...payload, operation: "replace_index" }) });
      } else if (adversary === "wrong_lock_operation") {
        await ctx.db.patch(locks[0]._id, { operation: "rollback" });
      } else if (adversary === "wrong_lock_job") {
        const now = Date.now();
        const unrelatedJobId = await ctx.db.insert("integrationJobs", {
          type: "gemini_delete_document", targetType: "documentVersion", targetId: ids[0],
          payload: JSON.stringify(payload), actorId: "fixture", actorRoles: ["super_admin"],
          idempotencyKey: `unrelated-${crypto.randomUUID()}`, requestFingerprint: "e".repeat(64), correlationId: `job_${crypto.randomUUID().replaceAll("-", "")}`,
          status: "queued", attemptCount: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
        });
        await ctx.db.patch(locks[0]._id, { jobId: unrelatedJobId });
      } else if (adversary === "wrong_lock_version") {
        await ctx.db.patch(locks[0]._id, { versionId: ids[1] });
      } else if (adversary === "stale_active_pointer") {
        await ctx.db.patch(resourceId, { activeVersionId: ids[1] });
      } else if (adversary === "candidate_state_mismatch") {
        await ctx.db.patch(ids[1], { status: "approved" });
      } else if (adversary === "candidate_document_mismatch") {
        await ctx.db.patch(ids[1], { geminiDocumentName: "fileSearchStores/ghana-test/documents/unbound-candidate" });
      } else if (adversary === "cross_store_document") {
        const documentName = "fileSearchStores/other-law/documents/version-1";
        await ctx.db.patch(ids[0], { geminiDocumentName: documentName });
        await ctx.db.patch(jobId, { payload: JSON.stringify({ ...payload, documentName }) });
      } else if (adversary === "nonunique_store_ownership") {
        const now = Date.now();
        await ctx.db.insert("jurisdictions", {
          name: "Duplicate Ghana", slug: `duplicate-${crypto.randomUUID()}`, status: "enabled", isDefault: false,
          geminiFileSearchStoreName: "fileSearchStores/ghana-test", geminiEmbeddingModel: "models/gemini-embedding-2",
          providerSyncState: "synced", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
        });
      } else if (adversary === "teardown_in_progress") {
        const now = Date.now();
        await ctx.db.insert("integrationJobs", {
          type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: jurisdictionId,
          payload: JSON.stringify({ storeName: "fileSearchStores/ghana-test" }), actorId: "fixture", actorRoles: ["super_admin"],
          idempotencyKey: `teardown-${crypto.randomUUID()}`, requestFingerprint: "f".repeat(64), correlationId: `job_${crypto.randomUUID().replaceAll("-", "")}`,
          status: "queued", attemptCount: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
        });
      }
    });

    await expect(t.mutation(recordProviderFailure, {
      jobId, leaseToken: claim.leaseToken, kind: "invalid_response", retryable: false, sideEffectUncertain: true,
    })).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).not.toHaveProperty("recoveryKind");
  });

  it("rejects normal synced index completion when the persisted operation belongs to another store", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "normal-cross-store-operation");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey: "normal-cross-store-operation",
    });
    const poll = await claimAcceptedIndexPoll(t, queued.jobId, "normal-cross-store-operation");
    await t.run(async (ctx) => ctx.db.patch(queued.jobId, {
      providerOperationName: "fileSearchStores/other-law/upload/operations/normal-cross-store-operation",
    }));

    await expect(t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId, leaseToken: poll.leaseToken,
      result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/normal-cross-store-operation" },
    })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    const state = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(state.resource?.activeVersionId).toBeUndefined();
    expect(state.version?.status).toBe("publishing");
    expect(state.locks).toHaveLength(1);
  });

  it("rejects a replacement index result that aliases the still-active prior document", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[1], "replacement-document-alias");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish replacement", idempotencyKey: "replacement-document-alias",
    });
    const poll = await claimAcceptedIndexPoll(t, queued.jobId, "replacement-alias");

    await expect(t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId, leaseToken: poll.leaseToken,
      result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/version-1" },
    })).rejects.toThrow("GEMINI_PROVIDER_RESULT_INVALID");
    const state = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), candidate: await ctx.db.get(ids[1]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(state.resource?.activeVersionId).toBe(ids[0]);
    expect(state.candidate?.status).toBe("publishing");
    expect(state.locks).toHaveLength(1);
  });

  it.each(["target", "recovery_binding", "retry", "completion", "failure"] as const)(
    "rejects an expired lifecycle lock at the %s boundary",
    async (boundary) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const operator = await asAdmin(t, "super_admin");
      const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["approved"]);
      const idempotencyKey = `expired-${boundary}`;
      await addStepUp(t, publisher, "document_publish", ids[0], idempotencyKey);
      const queued = await publisher.client.mutation(publishVersion, {
        versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish governed original", idempotencyKey,
      });
      let lease = await t.mutation(claimJob, { jobId: queued.jobId });
      if (!lease) throw new Error("expected publication lease");

      if (["retry", "completion", "failure"].includes(boundary)) {
        await t.mutation(applyGeminiProviderResult, {
          jobId: queued.jobId, leaseToken: lease.leaseToken,
          result: { kind: "index_accepted", operationName: `fileSearchStores/ghana-test/upload/operations/${boundary}` },
        });
        await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
        lease = await t.mutation(claimJob, { jobId: queued.jobId });
        if (!lease) throw new Error("expected poll lease");
        if (boundary === "retry") {
          await t.mutation(recordProviderFailure, {
            jobId: queued.jobId, leaseToken: lease.leaseToken, kind: "invalid_response", retryable: false, sideEffectUncertain: false,
          });
        }
      }
      await t.run(async (ctx) => {
        const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).unique();
        if (!lock) throw new Error("expected lifecycle lock");
        await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
      });

      if (boundary === "target") {
        await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: lease.leaseToken })).rejects.toThrow("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
      } else if (boundary === "recovery_binding") {
        await expect(t.mutation(recordProviderFailure, {
          jobId: queued.jobId, leaseToken: lease.leaseToken, kind: "invalid_response", retryable: false, sideEffectUncertain: true,
          providerOperationName: "fileSearchStores/ghana-test/upload/operations/expired-binding",
        })).rejects.toThrow("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
      } else if (boundary === "retry") {
        await expect(operator.client.mutation(retryJob, {
          jobId: queued.jobId, reason: "Retry exact persisted operation", idempotencyKey: "expired-retry-control",
        })).rejects.toThrow("Integration job is not retryable");
      } else if (boundary === "completion") {
        await expect(t.mutation(applyGeminiProviderResult, {
          jobId: queued.jobId, leaseToken: lease.leaseToken,
          result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/expired-completion" },
        })).rejects.toThrow("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
      } else {
        await expect(t.mutation(applyGeminiProviderResult, {
          jobId: queued.jobId, leaseToken: lease.leaseToken, result: { kind: "index_failed", errorKind: "validation" },
        })).rejects.toThrow("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
      }
      const state = await t.run(async (ctx) => ({
        jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId),
        candidate: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2),
      }));
      expect(state.jurisdiction?.providerSyncState).toBe(boundary === "retry" ? "drifted" : "synced");
      expect(state.resource?.activeVersionId).toBeUndefined();
      expect(state.candidate?.status).toBe("publishing");
      expect(state.locks).toHaveLength(1);
    },
  );

  it("rejects recovery provenance binding for an expired unpublish lock", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "expired-delete-binding");
    const queued = await publisher.client.mutation(unpublishVersion, {
      versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove indexed original", idempotencyKey: "expired-delete-binding",
    });
    const lease = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!lease) throw new Error("expected delete lease");
    await t.run(async (ctx) => {
      const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).unique();
      if (!lock) throw new Error("expected lifecycle lock");
      await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
    });
    await expect(t.mutation(recordProviderFailure, {
      jobId: queued.jobId, leaseToken: lease.leaseToken, kind: "invalid_response", retryable: false, sideEffectUncertain: true,
    })).rejects.toThrow("DOCUMENT_LIFECYCLE_LOCK_STATE_INVALID");
    expect(await t.run(async (ctx) => ctx.db.get(queued.jobId))).not.toHaveProperty("recoveryKind");
  });

  it.each([
    ["fresh_target", "cross_store"],
    ["operation_binding", "prior_alias"],
    ["poll_target", "cross_store"],
    ["recovery_retry", "prior_alias"],
    ["completion", "cross_store"],
    ["failure", "prior_alias"],
  ] as const)("rejects a preexisting candidate document at %s (%s)", async (boundary, identity) => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const catalog = await seedCatalog(t, "manager", identity === "prior_alias" ? ["published", "approved"] : ["approved"]);
    const candidateId = catalog.ids[catalog.ids.length - 1]!;
    const idempotencyKey = `candidate-${boundary}`;
    await addStepUp(t, publisher, "document_publish", candidateId, idempotencyKey);
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: candidateId, confirmation: `PUBLISH ${candidateId}`, reason: "Publish governed original", idempotencyKey,
    });
    let lease = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!lease) throw new Error("expected publication lease");
    if (!["fresh_target", "operation_binding"].includes(boundary)) {
      await t.mutation(applyGeminiProviderResult, {
        jobId: queued.jobId, leaseToken: lease.leaseToken,
        result: { kind: "index_accepted", operationName: `fileSearchStores/ghana-test/upload/operations/${boundary}` },
      });
      await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
      lease = await t.mutation(claimJob, { jobId: queued.jobId });
      if (!lease) throw new Error("expected poll lease");
      if (boundary === "recovery_retry") {
        await t.mutation(recordProviderFailure, {
          jobId: queued.jobId, leaseToken: lease.leaseToken, kind: "invalid_response", retryable: false, sideEffectUncertain: false,
        });
      }
    }
    await t.run(async (ctx) => ctx.db.patch(candidateId, {
      geminiDocumentName: identity === "prior_alias"
        ? "fileSearchStores/ghana-test/documents/version-1"
        : "fileSearchStores/other-law/documents/stale-candidate",
    }));

    if (boundary === "fresh_target" || boundary === "poll_target") {
      await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: lease.leaseToken })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    } else if (boundary === "operation_binding") {
      await expect(t.mutation(applyGeminiProviderResult, {
        jobId: queued.jobId, leaseToken: lease.leaseToken,
        result: { kind: "index_accepted", operationName: "fileSearchStores/ghana-test/upload/operations/preexisting-candidate" },
      })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    } else if (boundary === "recovery_retry") {
      await expect(operator.client.mutation(retryJob, {
        jobId: queued.jobId, reason: "Retry exact persisted operation", idempotencyKey: "candidate-retry-control",
      })).rejects.toThrow("Integration job is not retryable");
    } else if (boundary === "completion") {
      await expect(t.mutation(applyGeminiProviderResult, {
        jobId: queued.jobId, leaseToken: lease.leaseToken,
        result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/new-candidate" },
      })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    } else {
      await expect(t.mutation(applyGeminiProviderResult, {
        jobId: queued.jobId, leaseToken: lease.leaseToken, result: { kind: "index_failed", errorKind: "validation" },
      })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
  });

  it("does not reconcile a publication job whose lease is still current", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "current-lease-reconcile");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish governed original", idempotencyKey: "current-lease-reconcile",
    });
    const lease = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!lease) throw new Error("expected current lease");
    await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
    const before = await t.run(async (ctx) => ({
      job: await ctx.db.get(queued.jobId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]),
      locks: await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).take(2),
    }));

    await expect(t.mutation(reconcileStaleJobs, {})).resolves.toEqual({ scheduled: 0, hasMore: false });
    const after = await t.run(async (ctx) => ({
      job: await ctx.db.get(queued.jobId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]),
      locks: await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).take(2),
    }));
    expect(after).toEqual(before);
  });

  it.each(["expired_index_lock", "invalid_delete_payload"] as const)(
    "confines invalid stale publication workflow %s to the job",
    async (scenario) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const catalog = await seedCatalog(t, "manager", scenario === "invalid_delete_payload" ? ["published"] : ["approved"]);
      const versionId = catalog.ids[0];
      const operation = scenario === "invalid_delete_payload" ? "unpublish" : "publish";
      const idempotencyKey = `stale-${scenario}`;
      await addStepUp(t, publisher, `document_${operation}`, versionId, idempotencyKey);
      const queued = operation === "publish"
        ? await publisher.client.mutation(publishVersion, { versionId, confirmation: `PUBLISH ${versionId}`, reason: "Publish governed original", idempotencyKey })
        : await publisher.client.mutation(unpublishVersion, { versionId, confirmation: `UNPUBLISH ${versionId}`, reason: "Remove indexed original", idempotencyKey });
      const lease = await t.mutation(claimJob, { jobId: queued.jobId });
      if (!lease) throw new Error("expected stale publication lease");
      await t.run(async (ctx) => {
        const job = await ctx.db.get(queued.jobId);
        const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", catalog.resourceId)).unique();
        if (!job || !lock) throw new Error("expected publication workflow");
        await ctx.db.patch(job._id, {
          leaseExpiresAt: Date.now() - 1,
          nextAttemptAt: Date.now() - 1,
          ...(scenario === "invalid_delete_payload" ? { payload: JSON.stringify({ operation: "replace_index" }) } : {}),
        });
        if (scenario === "expired_index_lock") await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
      });
      const before = await t.run(async (ctx) => ({
        jurisdiction: await ctx.db.get(catalog.jurisdictionId), resource: await ctx.db.get(catalog.resourceId),
        version: await ctx.db.get(versionId),
        locks: await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", catalog.resourceId)).take(2),
      }));

      await expect(t.mutation(reconcileStaleJobs, {})).resolves.toEqual({ scheduled: 0, hasMore: false });
      const after = await t.run(async (ctx) => ({
        job: await ctx.db.get(queued.jobId), jurisdiction: await ctx.db.get(catalog.jurisdictionId), resource: await ctx.db.get(catalog.resourceId),
        version: await ctx.db.get(versionId),
        locks: await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", catalog.resourceId)).take(2),
      }));
      expect({ jurisdiction: after.jurisdiction, resource: after.resource, version: after.version, locks: after.locks }).toEqual(before);
      expect(after.job).toMatchObject({ status: "manual_review", lastErrorKind: "invalid_response" });
      expect(after.job).not.toHaveProperty("recoveryKind");
    },
  );

  it.each(["poll_operation", "delete_document"] as const)(
    "persists only exact %s provenance for a valid stale publication lease",
    async (recoveryKind) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const catalog = await seedCatalog(t, "manager", recoveryKind === "delete_document" ? ["published"] : ["approved"]);
      const versionId = catalog.ids[0];
      const operation = recoveryKind === "delete_document" ? "unpublish" : "publish";
      const idempotencyKey = `stale-valid-${recoveryKind}`;
      await addStepUp(t, publisher, `document_${operation}`, versionId, idempotencyKey);
      const queued = operation === "publish"
        ? await publisher.client.mutation(publishVersion, { versionId, confirmation: `PUBLISH ${versionId}`, reason: "Publish governed original", idempotencyKey })
        : await publisher.client.mutation(unpublishVersion, { versionId, confirmation: `UNPUBLISH ${versionId}`, reason: "Remove indexed original", idempotencyKey });
      let lease = await t.mutation(claimJob, { jobId: queued.jobId });
      if (!lease) throw new Error("expected stale publication lease");
      if (recoveryKind === "poll_operation") {
        await t.mutation(applyGeminiProviderResult, {
          jobId: queued.jobId, leaseToken: lease.leaseToken,
          result: { kind: "index_accepted", operationName: "fileSearchStores/ghana-test/upload/operations/stale-valid-poll" },
        });
        await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
        lease = await t.mutation(claimJob, { jobId: queued.jobId });
        if (!lease) throw new Error("expected stale poll lease");
      }
      await t.run(async (ctx) => ctx.db.patch(queued.jobId, { leaseExpiresAt: Date.now() - 1, nextAttemptAt: Date.now() - 1 }));

      await expect(t.mutation(reconcileStaleJobs, {})).resolves.toEqual({ scheduled: 0, hasMore: false });
      const state = await t.run(async (ctx) => ({
        job: await ctx.db.get(queued.jobId), jurisdiction: await ctx.db.get(catalog.jurisdictionId),
        resource: await ctx.db.get(catalog.resourceId), version: await ctx.db.get(versionId),
        locks: await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", catalog.resourceId)).take(2),
      }));
      expect(state.job).toMatchObject({ status: "manual_review", recoveryKind, lastErrorKind: "timeout" });
      expect(state.jurisdiction?.providerSyncState).toBe("drifted");
      expect(state.resource?.activeVersionId).toBe(recoveryKind === "delete_document" ? versionId : undefined);
      expect(state.version?.status).toBe(recoveryKind === "delete_document" ? "published" : "publishing");
      expect(state.locks).toHaveLength(1);
    },
  );

  it.each(["authentication", "not_found", "invalid_response", "provider"] as const)(
    "quarantines an accepted upload when polling fails with %s",
    async (kind) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
      const idempotencyKey = `poll-${kind}-1`;
      await addStepUp(t, publisher, "document_publish", ids[0], idempotencyKey);
      const queued = await publisher.client.mutation(publishVersion, {
        versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey,
      });
      const poll = await claimAcceptedIndexPoll(t, queued.jobId, `poll-${kind}`);

      await expect(t.mutation(recordProviderFailure, {
        jobId: queued.jobId, leaseToken: poll.leaseToken, kind, retryable: false, sideEffectUncertain: false,
      })).resolves.toMatchObject({ status: "manual_review" });

      const state = await t.run(async (ctx) => ({
        job: await ctx.db.get(queued.jobId),
        jurisdiction: await ctx.db.get(jurisdictionId),
        version: await ctx.db.get(ids[0]),
        locks: await ctx.db.query("documentLifecycleLocks").take(2),
      }));
      expect(state.job).toMatchObject({ status: "manual_review", recoveryKind: "poll_operation", lastErrorKind: kind });
      expect(state.jurisdiction?.providerSyncState).toBe("drifted");
      expect(state.version?.status).toBe("publishing");
      expect(state.locks).toHaveLength(1);
    },
  );

  it("quarantines an accepted upload when the polling action has no API key", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "poll-missing-key-1");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey: "poll-missing-key-1",
    });
    const poll = await claimAcceptedIndexPoll(t, queued.jobId, "poll-missing-key");
    delete process.env.GOOGLE_AI_API_KEY;

    await t.action(runGeminiJob, { jobId: queued.jobId, leaseToken: poll.leaseToken });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId),
      version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2),
    }));
    expect(state.job).toMatchObject({ status: "manual_review", recoveryKind: "poll_operation", lastErrorKind: "authentication" });
    expect(state.jurisdiction?.providerSyncState).toBe("drifted");
    expect(state.version?.status).toBe("publishing");
    expect(state.locks).toHaveLength(1);
  });

  it("uses bounded retries for a retryable poll transport error before manual review", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "poll-network-retries-1");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey: "poll-network-retries-1",
    });
    let claim = await claimAcceptedIndexPoll(t, queued.jobId, "poll-network-retries");

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await t.mutation(recordProviderFailure, {
        jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: false,
      });
      expect(result.status).toBe(attempt < 4 ? "queued" : "manual_review");
      if (attempt < 4) {
        await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
        const next = await t.mutation(claimJob, { jobId: queued.jobId });
        if (!next) throw new Error("expected retry poll claim");
        claim = next;
      }
    }

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId),
      version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2),
    }));
    expect(state.job).toMatchObject({ status: "manual_review", recoveryKind: "poll_operation", attemptCount: 4 });
    expect(state.jurisdiction?.providerSyncState).toBe("drifted");
    expect(state.version?.status).toBe("publishing");
    expect(state.locks).toHaveLength(1);
  });

  it("recovers an accepted upload without uploading twice or being blocked by legacy jobs", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "persist-index-accepted-1");
    const queued = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey: "persist-index-accepted-1",
    });
    const execute = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!execute) throw new Error("expected index execution claim");

    await t.mutation(recordProviderFailure, {
      jobId: queued.jobId,
      leaseToken: execute.leaseToken,
      kind: "invalid_response",
      retryable: false,
      sideEffectUncertain: true,
      providerOperationName: "fileSearchStores/ghana-test/upload/operations/persist-index-accepted",
    });
    expect(await t.run(async (ctx) => ctx.db.get("integrationJobs", queued.jobId))).toMatchObject({
      status: "manual_review", recoveryKind: "poll_operation",
      providerOperationName: "fileSearchStores/ghana-test/upload/operations/persist-index-accepted",
    });

    await operator.client.mutation(retryJob, {
      jobId: queued.jobId, reason: "Reconcile the durably identified upload", idempotencyKey: "retry-persist-index-accepted",
    });
    const recovery = await t.run(async (ctx) => ctx.db.get("integrationJobs", queued.jobId));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    const target = await t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: recovery.leaseToken });
    expect(target).not.toHaveProperty("signedUrl");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 129; index += 1) {
        await ctx.db.insert("integrationJobs", {
          type: "ingest_remote", targetType: "legacyDocument", targetId: `legacy-${index}`,
          payload: "{}", actorId: "legacy", actorRoles: [], idempotencyKey: `legacy-${index}`,
          requestFingerprint: "{}", correlationId: `legacy-${index}`, status: "manual_review",
          attemptCount: 1, lastErrorKind: "provider", createdAt: now + index, updatedAt: now + index,
        });
      }
    });
    await t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId, leaseToken: recovery.leaseToken,
      result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/persist-index-accepted" },
    });

    const final = await t.run(async (ctx) => ({
      job: await ctx.db.get("integrationJobs", queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId),
      resource: await ctx.db.get(resourceId), locks: await ctx.db.query("documentLifecycleLocks").take(2),
    }));
    expect(final.job).toMatchObject({ status: "succeeded" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBe(ids[0]);
    expect(final.locks).toHaveLength(0);
  });

  it("keeps a jurisdiction drifted when another resource job still needs manual review", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
    const secondVersionId = await t.run(async (ctx) => {
      const now = Date.now();
      const resourceId = await ctx.db.insert("legalResources", {
        jurisdictionId, type: "act", title: "Electronic Transactions Act", issuer: "Parliament",
        officialCitation: "Act 772", officialCitationKey: "act 772",
        sourceUrl: "https://laws.example.gov/act-772", topics: ["commerce"], effectiveDate: "2008-12-18",
        status: "active", createdBy: "manager", updatedBy: "manager", createdAt: now, updatedAt: now,
      });
      const body = "second-resource-version";
      const originalStorageId = await ctx.storage.store(new Blob([body], { type: "application/pdf" }));
      return await ctx.db.insert("documentVersions", {
        resourceId, versionNumber: 1, originalStorageId, filename: "act-772-v1.pdf",
        mimeType: "application/pdf", byteSize: body.length, sha256: await sha256(body),
        sourceUrl: "https://laws.example.gov/act-772", effectiveDate: "2008-12-18", status: "approved",
        submittedBy: "manager", submittedAt: now, reviewedBy: "prior-reviewer", reviewedAt: now,
        createdAt: now, updatedAt: now,
      });
    });
    await addStepUp(t, publisher, "document_publish", ids[0], "concurrent-publish-1");
    await addStepUp(t, publisher, "document_publish", secondVersionId, "concurrent-publish-2");
    const first = await publisher.client.mutation(publishVersion, {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`,
      reason: "Publish first verified original", idempotencyKey: "concurrent-publish-1",
    });
    const second = await publisher.client.mutation(publishVersion, {
      versionId: secondVersionId, confirmation: `PUBLISH ${secondVersionId}`,
      reason: "Publish second verified original", idempotencyKey: "concurrent-publish-2",
    });
    const firstPoll = await claimAcceptedIndexPoll(t, first.jobId, "concurrent-first");
    const secondPoll = await claimAcceptedIndexPoll(t, second.jobId, "concurrent-second");
    await t.mutation(recordProviderFailure, {
      jobId: first.jobId, leaseToken: firstPoll.leaseToken,
      kind: "network", retryable: true, sideEffectUncertain: true,
    });

    await t.mutation(applyGeminiProviderResult, {
      jobId: second.jobId, leaseToken: secondPoll.leaseToken,
      result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/concurrent-second" },
    });

    const final = await t.run(async (ctx) => ({
      first: await ctx.db.get("integrationJobs", first.jobId),
      second: await ctx.db.get("integrationJobs", second.jobId),
      jurisdiction: await ctx.db.get(jurisdictionId),
    }));
    expect(final.first?.status).toBe("manual_review");
    expect(final.second?.status).toBe("succeeded");
    expect(final.jurisdiction?.providerSyncState).toBe("drifted");
  });

  it("reconciles a deleted document whose completion write failed by repeating only the exact delete", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "persist-document-deleted-1");
    const queued = await publisher.client.mutation(unpublishVersion, {
      versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove indexed original", idempotencyKey: "persist-document-deleted-1",
    });
    const execute = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!execute) throw new Error("expected delete execution claim");

    await t.mutation(recordProviderFailure, {
      jobId: queued.jobId, leaseToken: execute.leaseToken, kind: "invalid_response",
      retryable: false, sideEffectUncertain: true,
    });
    expect(await t.run(async (ctx) => ctx.db.get("integrationJobs", queued.jobId))).toMatchObject({
      status: "manual_review", recoveryKind: "delete_document",
    });
    await operator.client.mutation(retryJob, {
      jobId: queued.jobId, reason: "Reconcile the exact document deletion", idempotencyKey: "retry-persist-document-deleted",
    });
    const recovery = await t.run(async (ctx) => ctx.db.get("integrationJobs", queued.jobId));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await expect(t.query(getGeminiJobTarget, {
      jobId: queued.jobId, leaseToken: recovery.leaseToken,
    })).resolves.toEqual({ kind: "delete_document", documentName: "fileSearchStores/ghana-test/documents/version-1" });
    await t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId, leaseToken: recovery.leaseToken, result: { kind: "document_deleted" },
    });

    const final = await t.run(async (ctx) => ({
      job: await ctx.db.get("integrationJobs", queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId),
      resource: await ctx.db.get(resourceId), locks: await ctx.db.query("documentLifecycleLocks").take(2),
    }));
    expect(final.job).toMatchObject({ status: "succeeded" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBeUndefined();
    expect(final.locks).toHaveLength(0);
  });

  it("recovers the exact persisted index poll from drift without authorizing a fresh publication", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["approved", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "recover-index-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish verified original", idempotencyKey: "recover-index-1" });
    const execute = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!execute) throw new Error("expected index claim");
    await t.mutation(applyGeminiProviderResult, { jobId: queued.jobId, leaseToken: execute.leaseToken, result: { kind: "index_accepted", operationName: "fileSearchStores/ghana-test/upload/operations/recover-index" } });
    await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
    const poll = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!poll) throw new Error("expected index poll claim");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: poll.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    expect((await t.run(async (ctx) => ctx.db.get(jurisdictionId)))?.providerSyncState).toBe("drifted");
    await expect(publisher.client.mutation(publishVersion, { versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Do not start fresh work", idempotencyKey: "fresh-while-drifted" })).rejects.toThrow("GEMINI_STORE_NOT_READY");
    await operator.client.mutation(retryJob, { jobId: queued.jobId, reason: "Reconcile the persisted Gemini operation", idempotencyKey: "retry-recover-index" });
    const recovery = await t.run(async (ctx) => ctx.db.get(queued.jobId as Id<"integrationJobs">));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    const target = await t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: recovery.leaseToken });
    expect(target).toMatchObject({ kind: "index_document", storeName: "fileSearchStores/ghana-test" });
    expect(target).not.toHaveProperty("signedUrl");
    await t.mutation(applyGeminiProviderResult, { jobId: queued.jobId, leaseToken: recovery.leaseToken, result: { kind: "index_completed", documentName: "fileSearchStores/ghana-test/documents/recovered-index" } });
    const final = await t.run(async (ctx) => ({ job: await ctx.db.get("integrationJobs", queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.job).toMatchObject({ status: "succeeded" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBe(ids[0]);
    expect(final.version?.status).toBe("published");
    expect(final.locks).toHaveLength(0);
  });

  it("restores a consistent jurisdiction after a definitive recovered index failure", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, ids } = await seedCatalog(t, "manager", ["approved"]);
    await addStepUp(t, publisher, "document_publish", ids[0], "definitive-recovery-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`, reason: "Publish governed original", idempotencyKey: "definitive-recovery-1" });
    const execute = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!execute) throw new Error("expected index claim");
    await t.mutation(applyGeminiProviderResult, { jobId: queued.jobId, leaseToken: execute.leaseToken, result: { kind: "index_accepted", operationName: "fileSearchStores/ghana-test/upload/operations/definitive-recovery" } });
    await t.run(async (ctx) => ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 }));
    const poll = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!poll) throw new Error("expected poll claim");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: poll.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    await operator.client.mutation(retryJob, { jobId: queued.jobId, reason: "Resolve the persisted operation", idempotencyKey: "retry-definitive-recovery" });
    const recovery = await t.run(async (ctx) => ctx.db.get(queued.jobId as Id<"integrationJobs">));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId,
      leaseToken: recovery.leaseToken,
      result: { kind: "index_failed", errorKind: "validation" },
    });
    const final = await t.run(async (ctx) => ({ job: await ctx.db.get(queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.job).toMatchObject({ status: "failed", lastErrorKind: "validation" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.version).toMatchObject({ status: "approved", failureSummary: "Publishing failed. No version was published." });
    expect(final.locks).toHaveLength(0);
  });

  it("recovers an uncertain unpublish delete and keeps approved manual-review copy visible until completion", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "recover-unpublish-1");
    const queued = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove indexed original", idempotencyKey: "recover-unpublish-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected delete claim");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    expect(await t.run(async (ctx) => ctx.db.get(ids[0]))).toMatchObject({ status: "published", failureSummary: "Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job." });
    await operator.client.mutation(retryJob, { jobId: queued.jobId, reason: "Reconcile the exact document deletion", idempotencyKey: "retry-recover-unpublish" });
    const recovery = await t.run(async (ctx) => ctx.db.get(queued.jobId as Id<"integrationJobs">));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken: recovery.leaseToken })).resolves.toMatchObject({ kind: "delete_document", documentName: "fileSearchStores/ghana-test/documents/version-1" });
    await t.mutation(applyGeminiProviderResult, { jobId: queued.jobId, leaseToken: recovery.leaseToken, result: { kind: "document_deleted" } });
    const final = await t.run(async (ctx) => ({ job: await ctx.db.get("integrationJobs", queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.job).toMatchObject({ status: "succeeded" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBeUndefined();
    expect(final.version).toMatchObject({ status: "unpublished" });
    expect(final.version?.failureSummary).toBeUndefined();
    expect(final.locks).toHaveLength(0);
  });

  it("restores a consistent active document after a definitive recovered unpublish failure", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "definitive-unpublish-1");
    const queued = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove indexed original", idempotencyKey: "definitive-unpublish-1" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected delete claim");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    await operator.client.mutation(retryJob, { jobId: queued.jobId, reason: "Resolve the exact deletion", idempotencyKey: "retry-definitive-unpublish" });
    const recovery = await t.run(async (ctx) => ctx.db.get(queued.jobId as Id<"integrationJobs">));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: recovery.leaseToken, kind: "validation", retryable: false, sideEffectUncertain: false });
    const final = await t.run(async (ctx) => ({ job: await ctx.db.get("integrationJobs", queued.jobId), jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.job).toMatchObject({ status: "failed", lastErrorKind: "validation" });
    expect(final.job).not.toHaveProperty("recoveryKind");
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBe(ids[0]);
    expect(final.version?.status).toBe("published");
    expect(final.version?.failureSummary).toBeUndefined();
    expect(final.locks).toHaveLength(0);
  });

  it("releases a normal unpublish after a definitive no-effect deletion failure", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published"]);
    await addStepUp(t, publisher, "document_unpublish", ids[0], "definitive-unpublish-normal");
    const queued = await publisher.client.mutation(unpublishVersion, { versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`, reason: "Remove indexed original", idempotencyKey: "definitive-unpublish-normal" });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected delete claim");
    await expect(t.mutation(recordProviderFailure, { jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "validation", retryable: false, sideEffectUncertain: false })).resolves.toMatchObject({ status: "failed" });
    const final = await t.run(async (ctx) => ({ jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), version: await ctx.db.get(ids[0]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBe(ids[0]);
    expect(final.version?.status).toBe("published");
    expect(final.locks).toHaveLength(0);
  });

  it("shows manual-review copy on the replacement candidate and completes its exact delete recovery", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const operator = await asAdmin(t, "super_admin");
    const { jurisdictionId, resourceId, ids } = await seedCatalog(t, "manager", ["published", "approved"]);
    await addStepUp(t, publisher, "document_publish", ids[1], "recover-replacement-1");
    const queued = await publisher.client.mutation(publishVersion, { versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`, reason: "Publish replacement", idempotencyKey: "recover-replacement-1" });
    await completeIndex(t, queued.jobId, "replacement-recovery");
    const deletion = await t.run(async (ctx) => (await ctx.db.query("integrationJobs").take(5)).find((job) => job.type === "gemini_delete_document"));
    if (!deletion) throw new Error("expected replacement deletion");
    const claim = await t.mutation(claimJob, { jobId: deletion._id });
    if (!claim) throw new Error("expected replacement delete claim");
    await t.mutation(recordProviderFailure, { jobId: deletion._id, leaseToken: claim.leaseToken, kind: "network", retryable: true, sideEffectUncertain: true });
    expect(await t.run(async (ctx) => ctx.db.get(ids[1]))).toMatchObject({ status: "publishing", failureSummary: "Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job." });
    await operator.client.mutation(retryJob, { jobId: deletion._id, reason: "Reconcile replacement deletion", idempotencyKey: "retry-recover-replacement" });
    const recovery = await t.run(async (ctx) => ctx.db.get(deletion._id as Id<"integrationJobs">));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await t.query(getGeminiJobTarget, { jobId: deletion._id, leaseToken: recovery.leaseToken });
    await t.mutation(applyGeminiProviderResult, { jobId: deletion._id, leaseToken: recovery.leaseToken, result: { kind: "document_deleted" } });
    const final = await t.run(async (ctx) => ({ jurisdiction: await ctx.db.get(jurisdictionId), resource: await ctx.db.get(resourceId), candidate: await ctx.db.get(ids[1]), locks: await ctx.db.query("documentLifecycleLocks").take(2) }));
    expect(final.jurisdiction?.providerSyncState).toBe("synced");
    expect(final.resource?.activeVersionId).toBe(ids[1]);
    expect(final.candidate).toMatchObject({ status: "published" });
    expect(final.candidate?.failureSummary).toBeUndefined();
    expect(final.locks).toHaveLength(0);
  });
});
