/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { insertDocumentVersion } from "./reviewCounts";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
const claimRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:claimFailedDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:completeFailedDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:abortFailedDocumentRecovery");
const retryRef = makeFunctionReference<"mutation">("admin/jobs:retryJob");
const resultRef = makeFunctionReference<"mutation">("admin/jobs:applyGeminiProviderResult");
const publishRef = makeFunctionReference<"mutation">("admin/publication:publishVersion");
const retentionRef = makeFunctionReference<"mutation">("admin/operations:runRetentionBatch");
const STORE = "fileSearchStores/failed-recovery";
async function reference(value: string) { return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("")}`; }
async function fixture(two = false) {
  vi.stubEnv("ADMIN_PANEL_ENABLED", "true"); vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = convexTest(schema, modules); t.registerComponent("betterAuth", authSchema, authModules);
  const ids = await t.run(async ctx => {
    const now = Date.now(); await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: now });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Reviewer", email: "reviewer@example.invalid", emailVerified: true, role: "super_admin", banned: false, twoFactorEnabled: true, createdAt: now, updatedAt: now } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: "fixture-session", userId: user._id, expiresAt: now + 600_000, createdAt: now, updatedAt: now, adminTwoFactorVerifiedAt: now } } });
    const jurisdictionId = await ctx.db.insert("jurisdictions", { name: "Failed recovery", slug: "failed-recovery", status: "enabled", isDefault: false, providerSyncState: "drifted", geminiFileSearchStoreName: STORE, createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now });
    const originalStorageId = await ctx.storage.store(new Blob(["law"], { type: "application/pdf" }));
    const sha256 = (await reference("law")).slice(7);
    const targets = [];
    for (let i = 0; i < (two ? 2 : 1); i++) {
      const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "act", title: `Excluded ${i}`, issuer: "Fixture", officialCitation: `Excluded ${i}`, officialCitationKey: `excluded-${i}`, sourceUrl: "https://example.invalid/law", topics: [], status: "active", createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now });
      const versionId = await insertDocumentVersion(ctx, { resourceId, versionNumber: 1, originalStorageId, filename: "law.pdf", mimeType: "application/pdf", byteSize: 3, sha256, sourceUrl: "https://example.invalid/law", status: "publishing", submittedBy: user._id, failureSummary: "App polling window elapsed", createdAt: now, updatedAt: now });
      const operationName = `${STORE}/upload/operations/retained-${i}`;
      const jobId = await ctx.db.insert("integrationJobs", { type: "gemini_index_document", targetType: "documentVersion", targetId: versionId, payload: JSON.stringify({ operation: "publish", storeName: STORE, sha256 }), actorId: user._id, actorRoles: ["super_admin"], idempotencyKey: `original-${i}`, requestFingerprint: `original-${i}`, correlationId: `job_${i}`, status: "manual_review", attemptCount: 0, providerOperationName: operationName, recoveryKind: "poll_operation", providerPollCount: 144, lastErrorKind: "timeout", createdAt: now - 7 * 60 * 60_000, updatedAt: now,
        failedDocumentObservation: { documentReference: await reference(`${STORE}/documents/failed-${i}`), operationReference: await reference(operationName), observedAt: now - 300_000 } });
      const lockId = await ctx.db.insert("documentLifecycleLocks", { jurisdictionId, resourceId, versionId, operation: "publish", actorId: user._id, idempotencyKey: `original-${i}`, jobId, expiresAt: now + 60 * 60_000, createdAt: now, updatedAt: now });
      targets.push({ resourceId, versionId, jobId, lockId, operationName });
    }
    const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "act", title: "Published", issuer: "Fixture", officialCitation: "Published", officialCitationKey: "published", sourceUrl: "https://example.invalid/law", topics: [], status: "active", createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now });
    const versionId = await insertDocumentVersion(ctx, { resourceId, versionNumber: 1, originalStorageId, filename: "law.pdf", mimeType: "application/pdf", byteSize: 3, sha256, sourceUrl: "https://example.invalid/law", status: "published", submittedBy: user._id, geminiDocumentName: `${STORE}/documents/published`, createdAt: now, updatedAt: now });
    await ctx.db.patch(resourceId, { activeVersionId: versionId, catalogPublished: true });
    return { userId: user._id, sessionId: session._id, jurisdictionId, targets, publishedVersionId: versionId, sha256, originalStorageId };
  });
  return { t, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function attempt(f: Fixture, index = 0, idempotencyKey = `reconcile-${index}`) {
  const target = f.targets[index]; const request = { jobId: target.jobId, reason: "Exclude confirmed failed provider document", idempotencyKey };
  const claim = await f.t.mutation(claimRef, request); expect(claim.kind).toBe("claimed");
  const { kind, coverage, ...owned } = claim; void kind;
  const observedAt = Date.now();
  const proof = { documentReference: await reference(`${STORE}/documents/failed-${index}`), operationReference: await reference(target.operationName), firstObservedAt: observedAt, confirmedAt: observedAt, coverageVerifiedAt: observedAt, publishedCount: coverage.published.length };
  return { request, owned, proof, coverage };
}
async function state(f: Fixture) { return await f.t.run(async ctx => ({ jobs: await ctx.db.query("integrationJobs").take(10), resources: await ctx.db.query("legalResources").take(10), versions: await ctx.db.query("documentVersions").take(10), jurisdiction: await ctx.db.get(f.jurisdictionId), locks: await ctx.db.query("documentLifecycleLocks").take(10), receipts: await ctx.db.query("adminOperations").take(10), schedules: await ctx.db.system.query("_scheduled_functions").take(10) })); }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("guarded failed document reconciliation", () => {
  it("fails and excludes publication while preserving operation and prior timeout evidence", async () => {
    const f = await fixture(); const a = await attempt(f);
    expect(await f.t.mutation(completeRef, { ...a.owned, ...a.proof })).toMatchObject({ status: "succeeded", jobId: f.targets[0].jobId });
    const after = await state(f); expect(after.jobs[0]).toMatchObject({ status: "failed", providerOperationName: f.targets[0].operationName, providerPollCount: 144,
      failedDocumentEvidence: { priorErrorKind: "timeout", observedOperationDone: false, observedDocumentState: "STATE_FAILED", publishedCount: 1 } });
    expect(after.versions.find(v => v._id === f.targets[0].versionId)).toMatchObject({ status: "failed" });
    expect(after.resources[0]).toMatchObject({ geminiPublicationBlock: { jobId: f.targets[0].jobId, versionId: f.targets[0].versionId } });
    expect(after.jurisdiction).toMatchObject({ providerSyncState: "synced", geminiSearchRestriction: { kind: "published_only", failedVersionIds: [f.targets[0].versionId] } });
    expect(after.locks).toHaveLength(0); expect(after.schedules).toHaveLength(0); expect(after.jurisdiction?.geminiExecutionPermit).toBeUndefined();
  });
  it("keeps the jurisdiction paused until both failed publications are reconciled", async () => {
    const f = await fixture(true); const a = await attempt(f);
    await f.t.mutation(completeRef, { ...a.owned, ...a.proof });
    expect((await state(f)).jurisdiction?.providerSyncState).toBe("drifted");
    const b = await attempt(f, 1); expect(b.coverage.excluded).toHaveLength(1);
    await f.t.mutation(completeRef, { ...b.owned, ...b.proof });
    expect((await state(f)).jurisdiction?.providerSyncState).toBe("synced");
    expect((await state(f)).jurisdiction?.geminiSearchRestriction?.failedVersionIds).toHaveLength(2);
  });
  it("replays only identical completed intent without another lease or provider read", async () => {
    const f = await fixture(); const a = await attempt(f); const result = await f.t.mutation(completeRef, { ...a.owned, ...a.proof }); const before = await state(f);
    expect(await f.t.mutation(claimRef, a.request)).toEqual({ kind: "completed", result });
    expect(await f.t.mutation(completeRef, { ...a.owned, ...a.proof })).toEqual(result);
    await expect(f.t.mutation(claimRef, { ...a.request, reason: "Changed recovery purpose" })).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it.each(["published version", "resource pointer", "restriction", "lock"])("rejects changed %s after provider proof", async change => {
    const f = await fixture(); const a = await attempt(f);
    await f.t.run(async ctx => {
      if (change === "published version") await ctx.db.patch(f.publishedVersionId, { sha256: "b".repeat(64) });
      if (change === "resource pointer") await ctx.db.patch(f.targets[0].resourceId, { activeVersionId: f.publishedVersionId });
      if (change === "restriction") await ctx.db.patch(f.jurisdictionId, { contentRevision: 99 });
      if (change === "lock") await ctx.db.patch(f.targets[0].lockId, { expiresAt: Date.now() + 30_000 });
    });
    const before = await state(f); await expect(f.t.mutation(completeRef, { ...a.owned, ...a.proof })).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it("cleans up only its matching lease and permit after proof failure", async () => {
    const f = await fixture(); const a = await attempt(f); await f.t.mutation(abortRef, a.owned);
    const after = await state(f); expect(after.jobs[0].status).toBe("manual_review"); expect(after.locks).toHaveLength(1); expect(after.jurisdiction?.providerSyncState).toBe("drifted"); expect(after.receipts[0].status).toBe("failed");
  });
  it("records the first candidate without releasing its lifecycle lock or restoring search", async () => {
    const f = await fixture(); await f.t.run(ctx => ctx.db.patch(f.targets[0].jobId, { failedDocumentObservation: undefined }));
    const a = await attempt(f); expect(await f.t.mutation(completeRef, { ...a.owned, ...a.proof })).toMatchObject({ status: "failed" });
    const after = await state(f); expect(after.jobs[0]).toMatchObject({ status: "manual_review", failedDocumentObservation: { observedAt: a.proof.firstObservedAt } });
    expect(after.locks).toHaveLength(1); expect(after.jurisdiction?.providerSyncState).toBe("drifted"); expect(after.resources[0].geminiPublicationBlock).toBeUndefined();
  });
  it("claims detector-confirmed evidence while ordinary polling stays blocked", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const job = (await ctx.db.get(f.targets[0].jobId))!; const observation = job.failedDocumentObservation!;
      await ctx.db.patch(job._id, { failedDocumentEvidence: { documentReference: observation.documentReference,
        operationReference: observation.operationReference, firstObservedAt: observation.observedAt, confirmedAt: Date.now() - 60_000,
        priorErrorKind: "timeout", priorProviderPollCount: 144, observedOperationDone: false, observedDocumentState: "STATE_FAILED" } });
    });
    const a = await attempt(f); await f.t.mutation(completeRef, { ...a.owned, ...a.proof });
    expect((await state(f)).jobs[0].status).toBe("failed");
  });
  it.each([1, 129])("ignores %i unrelated pending legacy jobs when proving Gemini recovery eligibility", async count => {
    const f = await fixture();
    await f.t.run(async ctx => {
      for (let index = 0; index < count; index++) await ctx.db.insert("integrationJobs", {
        type: "ingest_remote", targetType: "legacyDocument", targetId: `legacy-unrelated-${index}`,
        payload: "{}", actorId: f.userId, actorRoles: [], idempotencyKey: `legacy-pending-${index}`,
        requestFingerprint: `legacy-pending-${index}`, correlationId: `legacy-pending-${index}`,
        status: "queued", attemptCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const a = await attempt(f);
    expect(await f.t.mutation(completeRef, { ...a.owned, ...a.proof })).toMatchObject({ status: "succeeded", jobId: f.targets[0].jobId });
    const result = await f.t.run(async ctx => ({ target: await ctx.db.get(f.targets[0].jobId), jurisdiction: await ctx.db.get(f.jurisdictionId),
      legacy: await ctx.db.query("integrationJobs").withIndex("by_status_and_type_and_createdAt", q => q.eq("status", "queued").eq("type", "ingest_remote")).take(130) }));
    expect(result.target?.status).toBe("failed"); expect(result.jurisdiction?.providerSyncState).toBe("synced");
    expect(result.legacy).toHaveLength(count); expect(result.legacy.every(job => job.status === "queued")).toBe(true);
  });
  it("denies a pending Gemini job whose jurisdiction cannot be determined", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.insert("integrationJobs", { type: "gemini_index_document", targetType: "unknownGeminiScope", targetId: "unknown-scope",
      payload: "{}", actorId: f.userId, actorRoles: [], idempotencyKey: "unknown-gemini-scope", requestFingerprint: "unknown-gemini-scope",
      correlationId: "unknown-gemini-scope", status: "queued", attemptCount: 0, createdAt: Date.now(), updatedAt: Date.now() }));
    const before = await state(f); await expect(attempt(f)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it("requires five minutes between observations even when two fresh scans agree", async () => {
    const f = await fixture();
    await f.t.run(async ctx => { const job = (await ctx.db.get(f.targets[0].jobId))!;
      await ctx.db.patch(job._id, { failedDocumentObservation: { ...job.failedDocumentObservation!, observedAt: Date.now() } }); });
    const a = await attempt(f); expect(await f.t.mutation(completeRef, { ...a.owned, ...a.proof })).toMatchObject({ status: "failed" });
    expect((await state(f)).locks).toHaveLength(1);
    await f.t.run(async ctx => { const job = (await ctx.db.get(f.targets[0].jobId))!;
      await ctx.db.patch(job._id, { failedDocumentObservation: { ...job.failedDocumentObservation!, observedAt: Date.now() - 300_000 } }); });
    const b = await attempt(f, 0, "second-temporal-observation");
    expect(await f.t.mutation(completeRef, { ...b.owned, ...b.proof })).toMatchObject({ status: "succeeded" });
  });
  it.each(["publisher disabled", "other pending job", "execution permit", "inconsistent exclusion"])("denies a new claim when %s", async change => {
    const f = await fixture();
    await f.t.run(async ctx => {
      if (change === "publisher disabled") await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: { model: "user", where: [{ field: "_id", operator: "eq", value: f.userId }], update: { banned: true } } });
      if (change === "other pending job") await ctx.db.insert("integrationJobs", { type: "gemini_delete_store", targetType: "jurisdictionGeminiStore",
        targetId: f.jurisdictionId, payload: JSON.stringify({ storeName: STORE }), actorId: f.userId, actorRoles: ["super_admin"],
        idempotencyKey: "other-pending", requestFingerprint: "other-pending", correlationId: "other-pending", status: "queued", attemptCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
      if (change === "execution permit") await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: f.targets[0].jobId, leaseExpiresAt: Date.now() + 60_000 } });
      if (change === "inconsistent exclusion") await ctx.db.patch(f.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [f.publishedVersionId] } });
    });
    const before = await state(f); await expect(attempt(f)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it("rejects proof older than the claim without recording a candidate", async () => {
    const f = await fixture(); const a = await attempt(f); const before = await state(f);
    await expect(f.t.mutation(completeRef, { ...a.owned, ...a.proof, firstObservedAt: Date.now() - 60_000,
      confirmedAt: Date.now() - 40_000, coverageVerifiedAt: Date.now() - 40_000 })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it("rejects a legacy lifecycle lock on an otherwise published source", async () => {
    const f = await fixture();
    await f.t.run(async ctx => { const published = (await ctx.db.get(f.publishedVersionId))!;
      await ctx.db.insert("documentLifecycleLocks", { resourceId: published.resourceId, versionId: published._id,
        operation: "unpublish", actorId: f.userId, idempotencyKey: "legacy-published-lock", jobId: f.targets[0].jobId,
        expiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now() }); });
    const before = await state(f); await expect(attempt(f)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it("rejects authority revoked between claim and provider confirmation", async () => {
    const f = await fixture(); const a = await attempt(f);
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: { model: "user", where: [{ field: "_id", operator: "eq", value: f.userId }], update: { banned: true } } }));
    const before = await state(f); await expect(f.t.mutation(completeRef, { ...a.owned, ...a.proof })).rejects.toThrow();
    expect(await state(f)).toEqual(before); await f.t.mutation(abortRef, a.owned);
    expect((await state(f)).jobs[0].status).toBe("manual_review");
  });
  it("rejects changed document identity from the earlier durable observation", async () => {
    const f = await fixture(); const a = await attempt(f); const before = await state(f);
    await expect(f.t.mutation(completeRef, { ...a.owned, ...a.proof, documentReference: `sha256:${"e".repeat(64)}` })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it("rejects completion after its lease expires without releasing the lock", async () => {
    const f = await fixture(); const a = await attempt(f);
    await f.t.run(async ctx => {
      await ctx.db.patch(f.targets[0].jobId, { leaseExpiresAt: Date.now() - 1 });
      await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: f.targets[0].jobId, leaseExpiresAt: Date.now() - 1 } });
    });
    const before = await state(f); await expect(f.t.mutation(completeRef, { ...a.owned, ...a.proof })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
  it("does not clear a newer recovery lease when an old action aborts late", async () => {
    const f = await fixture(); const old = await attempt(f);
    // Model the stale-job reconciler returning this attempt to manual review.
    await f.t.run(async ctx => {
      await ctx.db.patch(f.targets[0].jobId, { status: "manual_review", leaseToken: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined });
      await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: undefined });
    });
    const newer = await attempt(f, 0, "newer-recovery-attempt"); const before = await state(f);
    expect(await f.t.mutation(abortRef, old.owned)).toMatchObject({ status: "failed" });
    const after = await state(f); expect(after.jobs).toEqual(before.jobs); expect(after.locks).toEqual(before.locks);
    expect(after.jurisdiction).toEqual(before.jurisdiction);
    expect(after.jobs[0].leaseToken).toBe(newer.owned.leaseToken);
  });
  it("allows only one of two concurrent claims to own the lease", async () => {
    const f = await fixture();
    const requests = ["concurrent-recovery-a", "concurrent-recovery-b"].map(idempotencyKey => ({
      jobId: f.targets[0].jobId, reason: "Exclude confirmed failed provider document", idempotencyKey }));
    const results = await Promise.allSettled(requests.map(request => f.t.mutation(claimRef, request)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const after = await state(f); expect(after.receipts).toHaveLength(1); expect(after.jobs[0].status).toBe("running");
    expect(after.jurisdiction?.geminiExecutionPermit?.jobId).toBe(f.targets[0].jobId); expect(after.locks).toHaveLength(1);
  });
  it("preserves the failed-operation tombstone while retention removes raw diagnostics", async () => {
    const f = await fixture(); const a = await attempt(f); await f.t.mutation(completeRef, { ...a.owned, ...a.proof });
    const retainedPayload = (await state(f)).jobs[0].payload;
    await f.t.run(async ctx => {
      await ctx.db.patch(f.targets[0].jobId, { createdAt: Date.now() - 100 * 86_400_000, lastProviderRawResponse: "private provider body", providerDiagnosticExpiresAt: Date.now() - 1 });
      await ctx.db.insert("retentionState", { key: "default", phase: "job_provider_diagnostics", deletedTotal: 0, lastStartedAt: Date.now(), updatedAt: Date.now() });
    });
    await f.t.mutation(retentionRef, { cursor: null });
    const after = await state(f); expect(after.jobs[0]).toMatchObject({ payload: retainedPayload, providerOperationName: f.targets[0].operationName,
      failedDocumentEvidence: { documentReference: a.proof.documentReference }, retentionPending: false });
    expect(after.jobs[0].lastProviderRawResponse).toBeUndefined();
    expect(after.resources[0].geminiPublicationBlock).toBeDefined();
    expect(after.jurisdiction?.geminiSearchRestriction).toBeDefined();
  });
  it("rejects a stale terminal callback after reconciliation", async () => {
    const f = await fixture(); const a = await attempt(f); await f.t.mutation(completeRef, { ...a.owned, ...a.proof });
    await expect(f.t.mutation(resultRef, { jobId: f.targets[0].jobId, leaseToken: a.owned.leaseToken, result: { kind: "index_completed", documentName: `${STORE}/documents/late` } })).rejects.toThrow();
    expect((await state(f)).versions[0].status).toBe("failed");
  });
  it("blocks publication of a new version on the same unresolved resource", async () => {
    const f = await fixture(); const a = await attempt(f); await f.t.mutation(completeRef, { ...a.owned, ...a.proof });
    const versionId = await f.t.run(ctx => insertDocumentVersion(ctx, { resourceId: f.targets[0].resourceId, versionNumber: 2, originalStorageId: f.originalStorageId, filename: "replacement.pdf", mimeType: "application/pdf", byteSize: 3, sha256: f.sha256, sourceUrl: "https://example.invalid/law", status: "approved", submittedBy: f.userId, createdAt: Date.now(), updatedAt: Date.now() }));
    const client = f.t.withIdentity({ subject: f.userId, sessionId: f.sessionId });
    await expect(client.mutation(publishRef, { versionId, confirmation: `PUBLISH ${versionId}`, reason: "Try replacement publication", idempotencyKey: "replacement-publish" })).rejects.toThrow("GEMINI_RESOURCE_PUBLICATION_BLOCKED");
    await expect(client.mutation(retryRef, { jobId: f.targets[0].jobId, reason: "Retry excluded operation", idempotencyKey: "excluded-retry" })).rejects.toThrow();
    expect((await state(f)).jobs).toHaveLength(1);
  });
});
