/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { E2E_PRIVILEGED_FUNCTIONS } from "./e2eAccessMatrix";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);
type Backend = TestConvex<typeof schema>;

const enqueueJob = makeFunctionReference<"mutation">("admin/jobs:enqueueSystemJob");
const claimJob = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const recordProviderFailure = makeFunctionReference<"mutation">(
  "admin/jobs:recordProviderFailure",
);
const provisionJurisdictionGeminiStore = makeFunctionReference<"mutation">(
  "admin/jobs:provisionJurisdictionGeminiStore",
);
const deleteJurisdictionGeminiStore = makeFunctionReference<"mutation">(
  "admin/jobs:deleteJurisdictionGeminiStore",
);
const applyGeminiProviderResult = makeFunctionReference<"mutation">(
  "admin/jobs:applyGeminiProviderResult",
);
const getGeminiJobTarget = makeFunctionReference<"query">("admin/jobs:getGeminiJobTarget");
const retryJob = makeFunctionReference<"mutation">("admin/jobs:retryJob");
const runGeminiJob = makeFunctionReference<"action">("admin/geminiActions:runGeminiJob");
const reconcileStaleJobs = makeFunctionReference<"mutation">("admin/jobs:reconcileStaleJobs");
const listJobs = makeFunctionReference<"query">("admin/jobs:listJobs");
const listIntegrationHealth = makeFunctionReference<"query">("admin/operations:listIntegrationHealth");
const reconcileManualReviewJob = makeFunctionReference<"mutation">("admin/jobs:reconcileManualReviewJob");

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", {
      key: "admin_panel",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    });
  });
}

async function seedBoundGeminiIndexJob(
  t: Backend,
  input: { suffix: string; status: "queued" | "waiting_provider" | "manual_review"; providerSyncState: "synced" | "drifted"; lastErrorKind?: "provider"; lockDurationMs?: number },
) {
  const fixture = await t.run(async (ctx) => {
    const now = Date.now();
    const storeName = `fileSearchStores/${input.suffix}`;
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: input.suffix, slug: input.suffix, status: "enabled", isDefault: false,
      geminiFileSearchStoreName: storeName, geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: input.providerSyncState, createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: input.suffix, issuer: "fixture", officialCitation: input.suffix,
      officialCitationKey: input.suffix, sourceUrl: "https://example.invalid/law", topics: [], effectiveDate: "2026-01-01",
      status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const storageId = await ctx.storage.store(new Blob(["law"]));
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 1, originalStorageId: storageId, filename: "law.pdf", mimeType: "application/pdf",
      byteSize: 3, sha256: "a".repeat(64), sourceUrl: "https://example.invalid/law", status: "publishing",
      submittedBy: "fixture", createdAt: now, updatedAt: now,
    });
    return { jurisdictionId, storeName, resourceId, versionId };
  });
  const queued: { jobId: Id<"integrationJobs">; duplicate: boolean } = await t.mutation(enqueueJob, {
    type: "gemini_index_document", targetType: "documentVersion", targetId: fixture.versionId,
    payload: { operation: "publish", storeName: fixture.storeName, sha256: "a".repeat(64) },
    idempotencyKey: `job-${input.suffix}`, systemActor: "gemini_orchestrator",
  });
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("documentLifecycleLocks", {
      resourceId: fixture.resourceId, versionId: fixture.versionId, operation: "publish", actorId: "gemini_orchestrator",
      idempotencyKey: `job-${input.suffix}`, jobId: queued.jobId, expiresAt: now + (input.lockDurationMs ?? 60_000), createdAt: now, updatedAt: now,
    });
    if (input.status !== "queued") {
      await ctx.db.patch(queued.jobId, {
        status: input.status,
        providerOperationName: `${fixture.storeName}/upload/operations/${input.suffix}`,
        recoveryKind: "poll_operation",
        nextAttemptAt: input.status === "waiting_provider" ? now : undefined,
        lastErrorKind: input.lastErrorKind,
      });
    }
  });
  return { ...queued, ...fixture };
}

async function asAdmin(t: Backend, role: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: `${role} fixture`,
          email: `${role}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: true,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `session-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return {
    client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }),
    userId: identity.userId,
    sessionId: identity.sessionId,
  };
}

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;

it("withdraws an organization owner's queued publication authority after transfer", async () => {
  const t = createBackend();
  await enablePanel(t);
  const fixture = await seedBoundGeminiIndexJob(t, { suffix: "owner-transfer-publication", status: "queued", providerSyncState: "synced" });
  const owner = await asAdmin(t, "user");
  const organizationId = await t.run(async ctx => {
    const now = Date.now();
    const id = await ctx.db.insert("organizations", { name: "University", slug: "owner-transfer", class: "university", status: "active", ownerUserId: owner.userId, createdBy: owner.userId, updatedBy: owner.userId, createdAt: now, updatedAt: now });
    await ctx.db.insert("organizationMemberships", { organizationId: id, userId: owner.userId, role: "manager", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.patch(fixture.jurisdictionId, { kind: "organizational", organizationId: id, visibility: "members" });
    await ctx.db.patch(fixture.jobId, { organizationId: id, organizationRole: "manager", actorId: owner.userId, actorRoles: [] });
    const version = (await ctx.db.get("documentVersions", fixture.versionId))!;
    const metadata = (await ctx.db.system.get("_storage", version.originalStorageId))!;
    const sha256 = /^[a-f0-9]{64}$/i.test(metadata.sha256) ? metadata.sha256.toLowerCase() : Array.from(Uint8Array.from(atob(metadata.sha256), c => c.charCodeAt(0)), b => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.patch(version._id, { sha256 });
    await ctx.db.patch(fixture.jobId, { payload: JSON.stringify({ operation: "publish", storeName: fixture.storeName, sha256 }) });
    return id;
  });
  const claim = await t.mutation(claimJob, { jobId: fixture.jobId });
  expect(claim).not.toBeNull();
  await expect(t.query(getGeminiJobTarget, { jobId: fixture.jobId, leaseToken: claim!.leaseToken })).resolves.toBeTruthy();
  await t.run(ctx => ctx.db.patch(organizationId, { ownerUserId: "new-owner" }));
  await expect(t.query(getGeminiJobTarget, { jobId: fixture.jobId, leaseToken: claim!.leaseToken })).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
  expect((await t.run(ctx => ctx.db.get("legalResources", fixture.resourceId)))?.activeVersionId).toBeUndefined();
});
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;
const previousGoogleAiApiKey = process.env.GOOGLE_AI_API_KEY;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  if (previousAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
  if (previousGoogleAiApiKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
  else process.env.GOOGLE_AI_API_KEY = previousGoogleAiApiKey;
});

async function claimLease(t: Backend, jobId: Id<"integrationJobs">) {
  const claim = await t.mutation(claimJob, { jobId });
  if (!claim || typeof claim.leaseToken !== "string") {
    throw new Error("expected job lease");
  }
  return claim.leaseToken as string;
}

describe("durable Gemini jobs", () => {
  it("preserves an existing retention marker when a job is claimed again", async () => {
    const t = createBackend();
    const fixture = await seedBoundGeminiIndexJob(t, { suffix: "retained-claim", status: "queued", providerSyncState: "synced" });
    await t.run(ctx => ctx.db.patch(fixture.jobId, { retentionPending: true }));
    const claim = await t.mutation(claimJob, { jobId: fixture.jobId });
    expect(claim).toMatchObject({ job: { retentionPending: true, status: "running" } });
    await expect(t.query(makeFunctionReference<"query">("admin/jobs:getJobForRun"), { jobId: fixture.jobId, leaseToken: claim!.leaseToken })).resolves.toMatchObject({ retentionPending: true });
  });

  async function failedObservation(fixture: Awaited<ReturnType<typeof seedBoundGeminiIndexJob>>) {
    const { hashJobValue } = await import("./jobs");
    return {
      documentReference: `sha256:${await hashJobValue(`${fixture.storeName}/documents/failed-1`)}`,
      operationReference: `sha256:${await hashJobValue(`${fixture.storeName}/upload/operations/${fixture.storeName.slice("fileSearchStores/".length)}`)}`,
      observedAt: Date.now(),
      metadata: { environment: "test", jurisdiction_id: fixture.jurisdictionId, resource_id: fixture.resourceId, version_id: fixture.versionId, version_number: "1", sha256: "a".repeat(64) },
    };
  }

  it("confirms contradictory failed document observations on separate polls, preserving evidence and locks", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 10, 15));
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-confirm", status: "waiting_provider", providerSyncState: "synced", lockDurationMs: 24 * 60 * 60_000 });
      await t.run(ctx => ctx.db.patch(fixture.jobId, { lastErrorKind: "timeout", providerPollCount: 7 }));
      const first = await failedObservation(fixture);
      let leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: first } });
      let job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "waiting_provider", failedDocumentObservation: { documentReference: first.documentReference, operationReference: first.operationReference, observedAt: first.observedAt } });
      expect(job).not.toHaveProperty("failedDocumentEvidence");
      vi.setSystemTime(job.nextAttemptAt!);
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "manual_review", lastErrorKind: "provider", providerPollCount: 9, failedDocumentEvidence: { documentReference: first.documentReference, operationReference: first.operationReference, firstObservedAt: first.observedAt, confirmedAt: Date.now(), priorErrorKind: "timeout", priorProviderPollCount: 8, observedOperationDone: false, observedDocumentState: "STATE_FAILED" } });
      expect(job).not.toHaveProperty("nextAttemptAt");
      expect(job).not.toHaveProperty("lastProviderStatus");
      const version = await t.run(ctx => ctx.db.get(fixture.versionId));
      expect(version).toMatchObject({ status: "publishing", failureSummary: expect.stringContaining("STATE_FAILED") });
      expect(version?.failureSummary).toContain("Google service or the document");
      expect(version).not.toHaveProperty("geminiDocumentName");
      await expect(t.run(ctx => ctx.db.get(fixture.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted" });
      await expect(t.run(ctx => ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", q => q.eq("resourceId", fixture.resourceId)).unique())).resolves.toMatchObject({ jobId: fixture.jobId });
      await expect(t.run(ctx => ctx.db.get(fixture.resourceId))).resolves.not.toHaveProperty("activeVersionId");
      await expect(t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_completed", documentName: `${fixture.storeName}/documents/failed-1` } })).rejects.toThrow("INTEGRATION_LEASE_INVALID");
      const admin = await asAdmin(t, "super_admin");
      await expect(admin.client.mutation(retryJob, { jobId: fixture.jobId, reason: "Inspect failed document", idempotencyKey: "failed-confirm-retry" })).rejects.toThrow("GEMINI_FAILED_DOCUMENT_RECONCILIATION_REQUIRED");
      await expect(t.mutation(reconcileManualReviewJob, { jobId: fixture.jobId })).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("resets an unconfirmed failure when the next poll cannot prove it", async () => {
    vi.useFakeTimers();
    try {
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-reset", status: "waiting_provider", providerSyncState: "synced" });
      let leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      let job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      vi.setSystemTime(job.nextAttemptAt!);
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending" } });
      job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "waiting_provider" });
      expect(job).not.toHaveProperty("failedDocumentObservation");
      expect(job).not.toHaveProperty("failedDocumentEvidence");
    } finally { vi.useRealTimers(); }
  });

  it("does not confirm changed document identity or a poll earlier than its required interval", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 10, 15));
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-spacing", status: "waiting_provider", providerSyncState: "synced" });
      const first = await failedObservation(fixture);
      let leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: first } });
      // Simulate an early scheduler wake-up. Normal claims also gate nextAttemptAt.
      vi.setSystemTime(first.observedAt + 1_000);
      await t.run(ctx => ctx.db.patch(fixture.jobId, { nextAttemptAt: Date.now() }));
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      let job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "waiting_provider", failedDocumentObservation: { observedAt: first.observedAt } });
      expect(job).not.toHaveProperty("failedDocumentEvidence");
      vi.setSystemTime(job.nextAttemptAt!);
      leaseToken = await claimLease(t, fixture.jobId);
      const changed = { ...await failedObservation(fixture), documentReference: `sha256:${"b".repeat(64)}` };
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: changed } });
      job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "waiting_provider", failedDocumentObservation: { documentReference: changed.documentReference, observedAt: changed.observedAt } });
      expect(job).not.toHaveProperty("failedDocumentEvidence");
    } finally { vi.useRealTimers(); }
  });

  it("resets unconfirmed failure evidence on a provider request error", async () => {
    vi.useFakeTimers();
    try {
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-error-reset", status: "waiting_provider", providerSyncState: "synced" });
      let leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      const job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      vi.setSystemTime(job.nextAttemptAt!);
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(recordProviderFailure, { jobId: fixture.jobId, leaseToken, kind: "network", retryable: true });
      await expect(t.run(ctx => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "queued", lastErrorKind: "network" });
      await expect(t.run(ctx => ctx.db.get(fixture.jobId))).resolves.not.toHaveProperty("failedDocumentObservation");
    } finally { vi.useRealTimers(); }
  });

  it("requires mature failures to remain contradictory for the five-minute poll cadence", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.UTC(2026, 9, 10, 12);
      vi.setSystemTime(startedAt);
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-mature-spacing", status: "waiting_provider", providerSyncState: "synced", lockDurationMs: 24 * 60 * 60_000 });
      vi.setSystemTime(startedAt + 3 * 60 * 60_000);
      let leaseToken = await claimLease(t, fixture.jobId);
      const first = await failedObservation(fixture);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: first } });
      let job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job.nextAttemptAt).toBe(first.observedAt + 300_000);
      vi.setSystemTime(first.observedAt + 60_000);
      await t.run(ctx => ctx.db.patch(fixture.jobId, { nextAttemptAt: Date.now() }));
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job).toMatchObject({ status: "waiting_provider" });
      expect(job).not.toHaveProperty("failedDocumentEvidence");
      vi.setSystemTime(job.nextAttemptAt!);
      leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: await failedObservation(fixture) } });
      await expect(t.run(ctx => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "manual_review", failedDocumentEvidence: { firstObservedAt: first.observedAt } });
    } finally { vi.useRealTimers(); }
  });

  it("preserves the previous published version when a replacement's Gemini document fails", async () => {
    vi.useFakeTimers();
    try {
      const t = createBackend();
      await enablePanel(t);
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-replacement", status: "waiting_provider", providerSyncState: "synced", lockDurationMs: 24 * 60 * 60_000 });
      const previousVersionId = await t.run(async ctx => {
        const candidate = (await ctx.db.get(fixture.versionId))!;
        const previousId = await ctx.db.insert("documentVersions", {
          resourceId: fixture.resourceId, versionNumber: 1, originalStorageId: candidate.originalStorageId,
          filename: "old.pdf", mimeType: "application/pdf", byteSize: 3, sha256: "b".repeat(64), sourceUrl: "https://example.invalid/old", status: "published", geminiDocumentName: `${fixture.storeName}/documents/old-active`, geminiIndexedAt: Date.now(), publishedAt: Date.now(), submittedBy: "fixture", createdAt: Date.now(), updatedAt: Date.now(),
        });
        await ctx.db.patch(candidate._id, { versionNumber: 2 });
        await ctx.db.patch(fixture.resourceId, { activeVersionId: previousId, catalogPublished: true });
        await ctx.db.patch(fixture.jobId, { payload: JSON.stringify({ operation: "replace_index", previousVersionId: previousId, storeName: fixture.storeName, sha256: "a".repeat(64) }) });
        return previousId;
      });
      const previous = await t.run(ctx => ctx.db.get(previousVersionId));
      for (let index = 0; index < 2; index += 1) {
        const leaseToken = await claimLease(t, fixture.jobId);
        const observation = await failedObservation(fixture);
        observation.metadata.version_number = "2";
        await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument: observation } });
        const job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
        if (index === 0) vi.setSystemTime(job.nextAttemptAt!);
      }
      await expect(t.run(ctx => ctx.db.get(previousVersionId))).resolves.toEqual(previous);
      await expect(t.run(ctx => ctx.db.get(fixture.resourceId))).resolves.toMatchObject({ activeVersionId: previousVersionId, catalogPublished: true });
      await expect(t.run(ctx => ctx.db.get(fixture.versionId))).resolves.toMatchObject({ status: "publishing" });
      await expect(t.run(ctx => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "manual_review", failedDocumentEvidence: { observedDocumentState: "STATE_FAILED" } });
      await expect(t.run(ctx => ctx.db.query("integrationJobs").take(2))).resolves.toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("preserves bounded failed-document evidence through ordinary diagnostic retention", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 10, 15));
      const t = createBackend();
      const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-retention", status: "manual_review", providerSyncState: "drifted" });
      const evidence = { documentReference: `sha256:${"b".repeat(64)}`, operationReference: `sha256:${"c".repeat(64)}`, firstObservedAt: Date.now() - 300_000, confirmedAt: Date.now(), priorErrorKind: "timeout", priorProviderPollCount: 144, observedOperationDone: false as const, observedDocumentState: "STATE_FAILED" as const, coverageVerifiedAt: Date.now(), publishedCount: 18 };
      await t.run(ctx => ctx.db.patch(fixture.jobId, { status: "failed", failedDocumentEvidence: evidence, retentionPending: true, createdAt: Date.now() - 100 * 24 * 60 * 60_000, lastProviderRawResponse: "old diagnostic" }));
      const originalPayload = (await t.run(ctx => ctx.db.get("integrationJobs", fixture.jobId)))!.payload;
      await t.mutation(makeFunctionReference<"mutation">("admin/operations:runRetentionBatch"), { cursor: null });
      const job = (await t.run(ctx => ctx.db.get(fixture.jobId)))!;
      expect(job.failedDocumentEvidence).toEqual(evidence);
      expect(job.payload).toBe(originalPayload);
      expect(job).not.toHaveProperty("lastProviderRawResponse");
    } finally { vi.useRealTimers(); }
  });

  it("rejects failure evidence for a changed operation, metadata or stale lease", async () => {
    const t = createBackend();
    await enablePanel(t);
    const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-binding", status: "waiting_provider", providerSyncState: "synced" });
    const leaseToken = await claimLease(t, fixture.jobId);
    const observation = await failedObservation(fixture);
    for (const failedDocument of [{ ...observation, operationReference: `sha256:${"b".repeat(64)}` }, { ...observation, metadata: { ...observation.metadata, sha256: "b".repeat(64) } }]) {
      await expect(t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending", failedDocument } })).rejects.toThrow("GEMINI_PROVIDER_RESULT_INVALID");
    }
    await expect(t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken: "stale", result: { kind: "index_pending", failedDocument: observation } })).rejects.toThrow("INTEGRATION_LEASE_INVALID");
    await expect(t.run(ctx => ctx.db.get(fixture.jobId))).resolves.not.toHaveProperty("failedDocumentObservation");
  });

  it("keeps a restricted jurisdiction drifted after an unrelated terminal publication failure", async () => {
    const t = createBackend();
    const fixture = await seedBoundGeminiIndexJob(t, { suffix: "failed-restriction", status: "waiting_provider", providerSyncState: "drifted" });
    await t.run(ctx => ctx.db.patch(fixture.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [fixture.versionId] } }));
    const leaseToken = await claimLease(t, fixture.jobId);
    await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_failed", errorKind: "provider" } });
    await expect(t.run(ctx => ctx.db.get(fixture.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted", geminiSearchRestriction: { kind: "published_only" } });
  });

  it("does not expose the generic provider dispatcher as a privileged public function", () => {
    expect(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).not.toContain("admin/jobs:enqueueJob");
  });

  it("projects Gemini legal search configuration from the server key without exposing secrets or resource names", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    process.env.GOOGLE_AI_API_KEY = "server-only-test-key";

    const result = await admin.client.query(listIntegrationHealth, {
      paginationOpts: { numItems: 20, cursor: null },
    }) as { page: Array<{ id: string; label: string; configured: boolean; status: string }> };
    expect(result.page).toContainEqual({
      id: "legal-search",
      label: "Gemini legal search and indexing",
      configured: true,
      status: "configured",
    });
    expect(JSON.stringify(result)).not.toContain("server-only-test-key");
    expect(JSON.stringify(result)).not.toContain("fileSearchStores/");
  });

  it("reports Gemini legal search as unconfigured when the server key is blank", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    process.env.GOOGLE_AI_API_KEY = "   ";

    const result = await admin.client.query(listIntegrationHealth, {
      paginationOpts: { numItems: 20, cursor: null },
    }) as { page: Array<{ id: string; label: string; configured: boolean; status: string }> };
    expect(result.page.find((row) => row.id === "legal-search")).toEqual({
      id: "legal-search",
      label: "Gemini legal search and indexing",
      configured: false,
      status: "configuration_required",
    });
  });

  it("projects the persisted next provider check without provider identities", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const created = await t.mutation(enqueueJob, {
      type: "gemini_create_store",
      targetType: "jurisdictionGeminiStore",
      targetId: "jurisdiction-safe-id",
      payload: { displayName: "fixture", embeddingModel: "models/gemini-embedding-2" },
      idempotencyKey: "operations-next-check",
      systemActor: "gemini_orchestrator",
    });
    const nextAttemptAt = 1_900_000_000_000;
    await t.run((ctx) => ctx.db.patch(created.jobId as Id<"integrationJobs">, { nextAttemptAt }));

    const result = await admin.client.query(listJobs, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page[0]).toMatchObject({
      id: created.jobId,
      nextAttemptAt,
    });
    expect(result.page[0]).not.toHaveProperty("providerOperationName");
    expect(result.page[0]).not.toHaveProperty("payload");
  });

  it("keeps legacy GroundX jobs out of Gemini reads and execution", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const legacyJobIds = await t.run(async (ctx) => {
      const now = Date.now();
      return await Promise.all(Array.from({ length: 26 }, async (_, index) =>
        await ctx.db.insert("integrationJobs", {
          type: "ingest_remote",
          targetType: "documentVersion",
          targetId: `legacy-version-${index}`,
          payload: "{}",
          actorId: "legacy",
          actorRoles: [],
          idempotencyKey: `legacy-groundx-job-${index}`,
          requestFingerprint: "{}",
          correlationId: `legacy-groundx-correlation-${index}`,
          callbackTokenHash: `legacy-callback-hash-${index}`,
          status: "queued",
          attemptCount: 0,
          nextAttemptAt: now - 1,
          createdAt: now + index,
          updatedAt: now + index,
        })));
    });

    await expect(admin.client.query(listJobs, {
      paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(t.mutation(claimJob, { jobId: legacyJobIds[0] })).resolves.toBeNull();
    await expect(t.mutation(reconcileStaleJobs, {})).resolves.toEqual({
      scheduled: 0,
      hasMore: false,
    });
  });

  it("terminalizes a stubbed Gemini job before API-key or client construction", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const jurisdictionId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("jurisdictions", {
        name: "Fixture Ghana", slug: "fixture-ghana", status: "draft", isDefault: false,
        providerSyncState: "pending", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
    });
    const created = await admin.client.mutation(provisionJurisdictionGeminiStore, {
      jurisdictionId,
      reason: "Set up isolated fixture search",
      idempotencyKey: "fixture-gemini-store",
    });
    Object.assign(process.env, {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "test",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    });
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      await t.action(runGeminiJob, { jobId: created.jobId });
      await expect(t.run((ctx) => ctx.db.get(created.jobId))).resolves.toMatchObject({ status: "succeeded" });
      await expect(t.run((ctx) => ctx.db.get(jurisdictionId))).resolves.toMatchObject({
        providerSyncState: "synced",
        geminiFileSearchStoreName: expect.stringMatching(/^fileSearchStores\/[a-z0-9-]{1,40}$/),
      });
    } finally {
      for (const key of ["ADMIN_E2E_FIXTURE_MODE", "ADMIN_E2E_TARGET_ENV", "ADMIN_E2E_ISOLATED_TARGET_MARKER", "ADMIN_E2E_PROVIDER_STUB_MODE"]) delete process.env[key];
    }
  });
  it("provisions one idempotent environment-qualified Gemini store without callback credentials", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Ghana",
        slug: "ghana",
        status: "draft",
        isDefault: true,
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    const first = await admin.client.mutation(provisionJurisdictionGeminiStore, {
      jurisdictionId,
      reason: "Set up legal search",
      idempotencyKey: "gemini-store-ghana-1",
    });
    const duplicate = await admin.client.mutation(provisionJurisdictionGeminiStore, {
      jurisdictionId,
      reason: "Retry legal search setup",
      idempotencyKey: "gemini-store-ghana-2",
    });

    expect(duplicate).toMatchObject({ jobId: first.jobId, duplicate: true });
    expect(first).not.toHaveProperty("storeName");
    expect(first).not.toHaveProperty("providerOperationName");
    const queued = await t.run(async (ctx) => ctx.db.get("integrationJobs", first.jobId));
    expect(queued).toMatchObject({
      type: "gemini_create_store",
      targetType: "jurisdictionGeminiStore",
      targetId: jurisdictionId,
      status: "queued",
    });
    expect(JSON.parse(queued?.payload ?? "{}")).toEqual({
      displayName: "law-of-the-land-test-ghana",
      embeddingModel: "models/gemini-embedding-2",
    });
    const provisionAudits = await t.run(async (ctx) => await ctx.db
      .query("auditEvents")
      .withIndex("by_targetType_and_targetId", (q) => q
        .eq("targetType", "jurisdiction")
        .eq("targetId", jurisdictionId))
      .collect());
    expect(provisionAudits.filter((event) =>
      event.action === "jurisdiction.gemini_store.provision_queued",
    )).toHaveLength(1);
    const leaseToken = await claimLease(t, first.jobId);
    await t.run((ctx) => ctx.db.patch(first.jobId, {
      lastErrorKind: "rate_limit",
      lastProviderOperation: "store_create",
      lastProviderStatus: 429,
      lastProviderRawResponse: "temporary Gemini error body",
    }));
    await t.mutation(applyGeminiProviderResult, {
      jobId: first.jobId,
      leaseToken,
      result: {
        kind: "store_created",
        storeName: "fileSearchStores/ghana-test",
        embeddingModel: "models/gemini-embedding-2",
      },
    });
    await expect(t.run((ctx) => ctx.db.get(jurisdictionId))).resolves.toMatchObject({
      geminiFileSearchStoreName: "fileSearchStores/ghana-test",
      geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced",
    });
    const completedJob = await t.run((ctx) => ctx.db.get(first.jobId));
    expect(completedJob).not.toHaveProperty("lastErrorKind");
    expect(completedJob).not.toHaveProperty("lastProviderOperation");
    expect(completedJob).not.toHaveProperty("lastProviderStatus");
    expect(completedJob).not.toHaveProperty("lastProviderRawResponse");
  });

  it("recovers a known store result without replaying the provider operation", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Ghana recovery",
        slug: "ghana-recovery",
        status: "draft",
        isDefault: false,
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    const created = await admin.client.mutation(provisionJurisdictionGeminiStore, {
      jurisdictionId,
      reason: "Set up recoverable legal search",
      idempotencyKey: "gemini-store-recovery",
    });
    const leaseToken = await claimLease(t, created.jobId);
    const knownStoreResult = {
      kind: "store_created" as const,
      storeName: "fileSearchStores/ghana-recovery",
      embeddingModel: "models/gemini-embedding-2",
    };

    await t.mutation(recordProviderFailure, {
      jobId: created.jobId,
      leaseToken,
      kind: "invalid_response",
      retryable: false,
      sideEffectUncertain: true,
      knownStoreResult,
    });
    await expect(t.run((ctx) => ctx.db.get(created.jobId))).resolves.toMatchObject({
      status: "manual_review",
      recoveryKind: "apply_store_result",
      knownStoreResult,
    });

    await expect(admin.client.mutation(retryJob, {
      jobId: created.jobId,
      reason: "Apply the known Gemini store result",
      idempotencyKey: "retry-known-store-result",
    })).resolves.toMatchObject({ status: "running" });
    await t.run(async (ctx) => {
      const leaseExpiresAt = Date.now() - 1;
      await ctx.db.patch(created.jobId as Id<"integrationJobs">, {
        leaseExpiresAt,
        nextAttemptAt: leaseExpiresAt,
      });
      await ctx.db.patch(jurisdictionId, {
        geminiExecutionPermit: { jobId: created.jobId, leaseExpiresAt },
      });
    });
    await t.mutation(reconcileStaleJobs, {});
    await expect(t.run((ctx) => ctx.db.get("integrationJobs", created.jobId))).resolves.toMatchObject({
      status: "manual_review",
      recoveryKind: "apply_store_result",
      knownStoreResult,
    });
    expect((await t.run((ctx) => ctx.db.get(jurisdictionId)))?.geminiExecutionPermit).toBeUndefined();
    await expect(admin.client.mutation(retryJob, {
      jobId: created.jobId,
      reason: "Apply the preserved Gemini store result",
      idempotencyKey: "retry-preserved-store-result",
    })).resolves.toMatchObject({ status: "running" });
    const recovery = await t.run((ctx) => ctx.db.get("integrationJobs", created.jobId));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    delete process.env.GOOGLE_AI_API_KEY;
    await t.action(runGeminiJob, { jobId: created.jobId, leaseToken: recovery.leaseToken });

    await expect(t.run((ctx) => ctx.db.get(created.jobId))).resolves.toMatchObject({ status: "succeeded" });
    await expect(t.run((ctx) => ctx.db.get(jurisdictionId))).resolves.toMatchObject({
      providerSyncState: "synced",
      geminiFileSearchStoreName: knownStoreResult.storeName,
    });
  });

  it("polls an accepted Gemini upload at 5, 10, 20, 30, then capped 60 second intervals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    try {
      const t = createBackend();
      const versionId = await t.run(async (ctx) => {
        const now = Date.now();
        const jurisdictionId = await ctx.db.insert("jurisdictions", {
          code: "GH", name: "Ghana", slug: "ghana-poll", status: "enabled", isDefault: false,
          geminiFileSearchStoreName: "fileSearchStores/ghana-poll", geminiEmbeddingModel: "models/gemini-embedding-2",
          providerSyncState: "synced", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
        });
        const resourceId = await ctx.db.insert("legalResources", {
          jurisdictionId, type: "act", title: "Poll Act", issuer: "Parliament", officialCitation: "Act poll",
          officialCitationKey: "act poll", sourceUrl: "https://example.invalid/poll", topics: [], effectiveDate: "2026-01-01",
          status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
        });
        const storageId = await ctx.storage.store(new Blob(["poll"]));
        return await ctx.db.insert("documentVersions", {
          resourceId, versionNumber: 1, originalStorageId: storageId, filename: "poll.pdf", mimeType: "application/pdf",
          byteSize: 4, sha256: "b".repeat(64), sourceUrl: "https://example.invalid/poll", status: "publishing",
          submittedBy: "fixture", createdAt: now, updatedAt: now,
        });
      });
      const created = await t.mutation(enqueueJob, {
        type: "gemini_index_document",
        targetType: "documentVersion",
        targetId: versionId,
        payload: { operation: "publish", storeName: "fileSearchStores/ghana-poll", sha256: "b".repeat(64) },
        idempotencyKey: "gemini-index-poll",
        systemActor: "gemini_orchestrator",
      });
      await t.run(async (ctx) => {
        const version = await ctx.db.get(versionId);
        if (!version) throw new Error("missing version fixture");
        await ctx.db.insert("documentLifecycleLocks", {
          resourceId: version.resourceId,
          versionId,
          operation: "publish",
          actorId: "gemini_orchestrator",
          idempotencyKey: "gemini-index-poll",
          jobId: created.jobId,
          expiresAt: Date.now() + 24 * 60 * 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
      let leaseToken = await claimLease(t, created.jobId);
      await expect(t.mutation(applyGeminiProviderResult, {
        jobId: created.jobId,
        leaseToken,
        result: { kind: "index_accepted", operationName: "fileSearchStores/other-store/upload/operations/index-poll" },
      })).rejects.toThrow("DOCUMENT_PUBLICATION_STATE_INVALID");
      await t.mutation(applyGeminiProviderResult, {
        jobId: created.jobId,
        leaseToken,
        result: { kind: "index_accepted", operationName: "fileSearchStores/ghana-poll/upload/operations/index-poll" },
      });
      let job = await t.run((ctx) => ctx.db.get("integrationJobs", created.jobId));
      expect(job).toMatchObject({
        status: "waiting_provider",
        providerOperationName: "fileSearchStores/ghana-poll/upload/operations/index-poll",
        providerPollingStartedAt: Date.now(),
        nextAttemptAt: Date.now() + 5_000,
      });

      for (const delay of [10_000, 20_000, 30_000, 60_000, 60_000]) {
        vi.setSystemTime(job!.nextAttemptAt!);
        leaseToken = await claimLease(t, created.jobId);
        await t.mutation(applyGeminiProviderResult, {
          jobId: created.jobId,
          leaseToken,
          result: { kind: "index_pending" },
        });
        job = await t.run((ctx) => ctx.db.get("integrationJobs", created.jobId));
        expect(job?.nextAttemptAt).toBe(Date.now() + delay);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a safe Gemini poll but quarantines an uncertain initial Gemini mutation", async () => {
    const t = createBackend();
    const safePoll = await seedBoundGeminiIndexJob(t, { suffix: "safe-poll", status: "waiting_provider", providerSyncState: "synced" });
    const safeLease = await claimLease(t, safePoll.jobId);
    await expect(t.mutation(recordProviderFailure, {
      jobId: safePoll.jobId, leaseToken: safeLease, kind: "provider", retryable: true,
    })).resolves.toMatchObject({ status: "queued" });

    const uncertain = await t.mutation(enqueueJob, {
      type: "gemini_create_store", targetType: "jurisdictionGeminiStore", targetId: "initial-create",
      payload: { displayName: "law-of-the-land-test", embeddingModel: "models/gemini-embedding-2" },
      idempotencyKey: "gemini-uncertain-create", systemActor: "gemini_orchestrator",
    });
    const uncertainLease = await claimLease(t, uncertain.jobId);
    await expect(t.mutation(recordProviderFailure, {
      jobId: uncertain.jobId, leaseToken: uncertainLease, kind: "provider", retryable: true, sideEffectUncertain: true,
    })).resolves.toEqual({ status: "manual_review", nextAttemptAt: null });
  });

  it("requires review on exhausted provider errors before the polling window expires", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.UTC(2026, 8, 4, 12);
      vi.setSystemTime(startedAt);
      const t = createBackend();

      const earlyTimeout = await seedBoundGeminiIndexJob(t, {
        suffix: "early-poll-timeout",
        status: "waiting_provider",
        providerSyncState: "synced",
      });
      await t.run((ctx) => ctx.db.patch(earlyTimeout.jobId, { attemptCount: 3 }));
      const earlyLease = await claimLease(t, earlyTimeout.jobId);
      await t.mutation(recordProviderFailure, {
        jobId: earlyTimeout.jobId,
        leaseToken: earlyLease,
        kind: "timeout",
        retryable: true,
      });
      await expect(t.run((ctx) => ctx.db.get(earlyTimeout.versionId))).resolves.toMatchObject({
        failureSummary: "Gemini did not confirm the index update. Search is paused until an administrator reviews the job.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("slows pending polls after two hours and requires review after six hours", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.UTC(2026, 8, 4, 12);
      vi.setSystemTime(startedAt);
      const t = createBackend();
      const elapsedWindow = await seedBoundGeminiIndexJob(t, {
        suffix: "elapsed-index-window",
        status: "waiting_provider",
        providerSyncState: "synced",
        lockDurationMs: 24 * 60 * 60_000,
      });
      const operationName = `${elapsedWindow.storeName}/upload/operations/elapsed-index-window`;
      await t.run((ctx) => ctx.db.patch(elapsedWindow.jobId, { providerPollCount: 359 }));
      for (const [elapsedMinutes, delayMs] of [[119, 60_000], [120, 300_000], [355, 300_000]]) {
        vi.setSystemTime(startedAt + elapsedMinutes * 60_000);
        const leaseToken = await claimLease(t, elapsedWindow.jobId);
        await t.mutation(applyGeminiProviderResult, {
          jobId: elapsedWindow.jobId,
          leaseToken,
          result: { kind: "index_pending" },
        });
        await expect(t.run((ctx) => ctx.db.get("integrationJobs", elapsedWindow.jobId))).resolves.toMatchObject({
          status: "waiting_provider",
          providerOperationName: operationName,
          nextAttemptAt: Date.now() + delayMs,
        });
        await expect(t.run((ctx) => ctx.db.get(elapsedWindow.versionId))).resolves.not.toHaveProperty("failureSummary");
        await expect(t.mutation(claimJob, { jobId: elapsedWindow.jobId })).resolves.toBeNull();
        await expect(t.mutation(reconcileStaleJobs, {})).resolves.toEqual({ scheduled: 0, hasMore: false });
      }

      vi.setSystemTime(startedAt + 360 * 60_000);
      const elapsedLease = await claimLease(t, elapsedWindow.jobId);
      await t.mutation(applyGeminiProviderResult, {
        jobId: elapsedWindow.jobId,
        leaseToken: elapsedLease,
        result: { kind: "index_pending" },
      });
      const reviewedJob = await t.run((ctx) => ctx.db.get("integrationJobs", elapsedWindow.jobId));
      expect(reviewedJob).toMatchObject({ status: "manual_review", lastErrorKind: "timeout", providerOperationName: operationName });
      expect(reviewedJob).not.toHaveProperty("nextAttemptAt");
      await expect(t.run((ctx) => ctx.db.get(elapsedWindow.versionId))).resolves.toMatchObject({
        status: "publishing",
        failureSummary: "Gemini did not confirm the index update within 6 hours. Search is paused until an administrator reviews the job.",
      });
      await expect(t.run((ctx) => ctx.db.get(elapsedWindow.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted" });
      await expect(t.run((ctx) => ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", elapsedWindow.resourceId)).unique())).resolves.toMatchObject({ jobId: elapsedWindow.jobId });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["index_completed", "index_failed"] as const)("reconciles %s after the old two-hour window", async (outcome) => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.UTC(2026, 8, 4, 12);
      vi.setSystemTime(startedAt);
      const t = createBackend();
      const suffix = outcome === "index_completed" ? "late-completed" : "late-failed";
      const fixture = await seedBoundGeminiIndexJob(t, {
        suffix,
        status: "waiting_provider",
        providerSyncState: "drifted",
        lockDurationMs: 24 * 60 * 60_000,
      });
      vi.setSystemTime(startedAt + 180 * 60_000);
      const leaseToken = await claimLease(t, fixture.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: fixture.jobId, leaseToken, result: { kind: "index_pending" } });
      await expect(t.run((ctx) => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "waiting_provider", nextAttemptAt: startedAt + 185 * 60_000 });
      await expect(t.run((ctx) => ctx.db.get(fixture.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted" });
      await expect(t.run((ctx) => ctx.db.get(fixture.resourceId))).resolves.not.toHaveProperty("activeVersionId");

      vi.setSystemTime(startedAt + 185 * 60_000);
      const claim = await t.mutation(claimJob, { jobId: fixture.jobId });
      expect(claim).toMatchObject({ workKind: "poll", job: { providerOperationName: `${fixture.storeName}/upload/operations/${suffix}` } });
      const documentName = `${fixture.storeName}/documents/late-result`;
      await t.mutation(applyGeminiProviderResult, {
        jobId: fixture.jobId,
        leaseToken: claim!.leaseToken,
        result: outcome === "index_completed" ? { kind: "index_completed", documentName } : { kind: "index_failed", errorKind: "validation" },
      });
      const version = await t.run((ctx) => ctx.db.get(fixture.versionId));
      const resource = await t.run((ctx) => ctx.db.get(fixture.resourceId));
      if (outcome === "index_completed") {
        await expect(t.run((ctx) => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "succeeded" });
        expect(version).toMatchObject({ status: "published", geminiDocumentName: documentName });
        expect(resource).toMatchObject({ activeVersionId: fixture.versionId });
      } else {
        await expect(t.run((ctx) => ctx.db.get(fixture.jobId))).resolves.toMatchObject({ status: "failed", lastErrorKind: "validation" });
        expect(version).toMatchObject({ status: "approved", failureSummary: "Publishing failed. No version was published." });
        expect(version).not.toHaveProperty("geminiDocumentName");
        expect(resource).not.toHaveProperty("activeVersionId");
      }
      await expect(t.run((ctx) => ctx.db.get(fixture.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "synced" });
      await expect(t.run((ctx) => ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", fixture.resourceId)).unique())).resolves.toBeNull();
      await expect(t.run((ctx) => ctx.db.query("integrationJobs").take(2))).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a safe Gemini diagnostic for a denied document upload", async () => {
    const t = createBackend();
    await enablePanel(t);
    const superAdmin = await asAdmin(t, "super_admin");
    const auditor = await asAdmin(t, "auditor");
    const failed = await seedBoundGeminiIndexJob(t, {
      suffix: "denied-upload",
      status: "queued",
      providerSyncState: "synced",
    });
    const leaseToken = await claimLease(t, failed.jobId);
    const rawProviderResponse = "{\"error\":{\"code\":403,\"message\":\"Caller does not have permission\"}}";
    const failureStartedAt = Date.now();

    await expect(t.mutation(recordProviderFailure, {
      jobId: failed.jobId,
      leaseToken,
      kind: "authentication",
      retryable: false,
      sideEffectUncertain: false,
      providerOperation: "document_upload",
      providerStatus: 403,
      providerRawResponse: rawProviderResponse,
    })).resolves.toEqual({ status: "failed", nextAttemptAt: null });

    await expect(t.run((ctx) => ctx.db.get(failed.jobId))).resolves.toMatchObject({
      lastProviderOperation: "document_upload",
      lastProviderStatus: 403,
      lastProviderRawResponse: rawProviderResponse,
      providerDiagnosticExpiresAt: expect.any(Number),
    });
    const recorded = await t.run((ctx) => ctx.db.get(failed.jobId)) as Doc<"integrationJobs"> | null;
    const expiresAt = recorded?.providerDiagnosticExpiresAt;
    expect(expiresAt).toBeDefined();
    expect(expiresAt!).toBeGreaterThanOrEqual(
      failureStartedAt + 24 * 60 * 60_000,
    );
    expect(expiresAt!).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60_000,
    );
    await expect(superAdmin.client.query(listJobs, {
      paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({
      page: [expect.objectContaining({
        id: failed.jobId,
        lastProviderRawResponse: rawProviderResponse,
      })],
    });
    const auditorJobs = await auditor.client.query(listJobs, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(auditorJobs.page[0]).not.toHaveProperty("lastProviderRawResponse");
  });

  it("retains an expired permit for an unresolved provider mutation", async () => {
    const t = createBackend();
    const first = await seedBoundGeminiIndexJob(t, {
      suffix: "expired-mutation",
      status: "queued",
      providerSyncState: "synced",
    });
    await claimLease(t, first.jobId);
    const second = await t.mutation(enqueueJob, {
      type: "gemini_index_document",
      targetType: "documentVersion",
      targetId: first.versionId,
      payload: { operation: "publish", storeName: first.storeName, sha256: "a".repeat(64) },
      idempotencyKey: "expired-mutation-second",
      systemActor: "gemini_orchestrator",
    });
    const leaseExpiresAt = Date.now() - 1;
    await t.run(async (ctx) => {
      await ctx.db.patch(first.jobId, { leaseExpiresAt, nextAttemptAt: leaseExpiresAt });
      await ctx.db.patch(first.jurisdictionId, {
        geminiExecutionPermit: { jobId: first.jobId, leaseExpiresAt },
      });
    });

    await expect(t.mutation(reconcileStaleJobs, {})).resolves.toMatchObject({ scheduled: 0 });
    const state = await t.run(async (ctx) => ({
      first: await ctx.db.get("integrationJobs", first.jobId),
      second: await ctx.db.get("integrationJobs", second.jobId),
      jurisdiction: await ctx.db.get("jurisdictions", first.jurisdictionId),
    }));
    expect(state.first?.status).toBe("manual_review");
    expect(state.first?.recoveryKind).toBeUndefined();
    expect(state.jurisdiction).toMatchObject({
      providerSyncState: "drifted",
      geminiExecutionPermit: { jobId: first.jobId, leaseExpiresAt },
    });
    await expect(t.mutation(claimJob, { jobId: second.jobId })).resolves.toBeNull();
  });

  it("permits an admin retry only for a Gemini manual-review poll with persisted recovery provenance", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const safePoll = await seedBoundGeminiIndexJob(t, { suffix: "retry-poll", status: "manual_review", providerSyncState: "drifted", lastErrorKind: "provider" });
    await expect(admin.client.mutation(retryJob, {
      jobId: safePoll.jobId, reason: "Retry safe provider poll", idempotencyKey: "retry-safe-gemini-poll-admin",
    })).resolves.toMatchObject({ status: "running" });

    const uncertain = await t.mutation(enqueueJob, {
      type: "gemini_create_store", targetType: "jurisdictionGeminiStore", targetId: "retry-initial-create",
      payload: { displayName: "law-of-the-land-test", embeddingModel: "models/gemini-embedding-2" },
      idempotencyKey: "retry-initial-create", systemActor: "gemini_orchestrator",
    });
    await t.run((ctx) => ctx.db.patch(uncertain.jobId, {
      status: "manual_review", lastErrorKind: "provider", nextAttemptAt: undefined,
    }));
    await expect(admin.client.mutation(retryJob, {
      jobId: uncertain.jobId, reason: "Do not replay uncertain creation", idempotencyKey: "retry-initial-create-admin",
    })).rejects.toThrow("Integration job is not retryable");
  });

  it("starts a fresh six-hour polling window on retry despite an old cumulative poll count", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-09-04T10:00:00.000Z");
      vi.setSystemTime(startedAt);
      const t = createBackend();
      await enablePanel(t);
      const safePoll = await seedBoundGeminiIndexJob(t, {
        suffix: "retry-poll-window",
        status: "manual_review",
        providerSyncState: "drifted",
        lastErrorKind: "provider",
        lockDurationMs: 24 * 60 * 60_000,
      });

      await t.run((ctx) => ctx.db.patch(safePoll.jobId, { providerPollingStartedAt: startedAt.getTime(), providerPollCount: 359 }));
      const retriedAt = startedAt.getTime() + 7 * 60 * 60_000;
      vi.setSystemTime(retriedAt);
      const admin = await asAdmin(t, "super_admin");

      await admin.client.mutation(retryJob, {
        jobId: safePoll.jobId,
        reason: "Resume the existing Gemini operation",
        idempotencyKey: "retry-safe-gemini-poll-window",
      });
      const running = await t.run((ctx) => ctx.db.get("integrationJobs", safePoll.jobId));
      if (!running?.leaseToken) throw new Error("expected retry lease");

      await t.mutation(applyGeminiProviderResult, {
        jobId: safePoll.jobId,
        leaseToken: running.leaseToken,
        result: { kind: "index_pending" },
      });

      await expect(t.run((ctx) => ctx.db.get("integrationJobs", safePoll.jobId))).resolves.toMatchObject({
        status: "waiting_provider",
        providerPollingStartedAt: retriedAt,
        providerOperationName: `${safePoll.storeName}/upload/operations/retry-poll-window`,
        providerPollCount: 360,
        nextAttemptAt: retriedAt + 60_000,
      });
      await expect(t.run((ctx) => ctx.db.get(safePoll.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted" });
      vi.setSystemTime(retriedAt + 355 * 60_000);
      const leaseToken = await claimLease(t, safePoll.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: safePoll.jobId, leaseToken, result: { kind: "index_pending" } });
      await expect(t.run((ctx) => ctx.db.get(safePoll.jobId))).resolves.toMatchObject({ status: "waiting_provider", providerPollingStartedAt: retriedAt, nextAttemptAt: retriedAt + 360 * 60_000 });
      vi.setSystemTime(retriedAt + 360 * 60_000);
      const finalLease = await claimLease(t, safePoll.jobId);
      await t.mutation(applyGeminiProviderResult, { jobId: safePoll.jobId, leaseToken: finalLease, result: { kind: "index_pending" } });
      await expect(t.run((ctx) => ctx.db.get(safePoll.jobId))).resolves.toMatchObject({ status: "manual_review", lastErrorKind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an uncertain store deletion using its exact persisted target", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const storeName = "fileSearchStores/delete-store-recovery";
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Delete store recovery",
        slug: "delete-store-recovery",
        status: "draft",
        isDefault: false,
        geminiFileSearchStoreName: storeName,
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: "drifted",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    const queued = await t.mutation(enqueueJob, {
      type: "gemini_delete_store",
      targetType: "jurisdictionGeminiStore",
      targetId: jurisdictionId,
      payload: { storeName },
      idempotencyKey: "delete-store-recovery",
      systemActor: "gemini_orchestrator",
    });
    const leaseToken = await claimLease(t, queued.jobId);
    await expect(t.mutation(recordProviderFailure, {
      jobId: queued.jobId,
      leaseToken,
      kind: "network",
      retryable: true,
      sideEffectUncertain: true,
    })).resolves.toMatchObject({ status: "manual_review" });
    const quarantined = await t.run(async (ctx) => ({
      job: await ctx.db.get("integrationJobs", queued.jobId),
      jurisdiction: await ctx.db.get(jurisdictionId),
    }));
    expect(quarantined.job).toMatchObject({ status: "manual_review", recoveryKind: "delete_store" });
    expect(quarantined.jurisdiction).toMatchObject({
      geminiExecutionPermit: { jobId: queued.jobId },
    });
    await expect(admin.client.mutation(retryJob, {
      jobId: queued.jobId,
      reason: "Reconcile exact store deletion",
      idempotencyKey: "retry-delete-store-recovery",
    })).resolves.toMatchObject({ status: "running" });
    const recovery = await t.run((ctx) => ctx.db.get("integrationJobs", queued.jobId));
    if (!recovery?.leaseToken) throw new Error("expected recovery lease");
    await expect(t.query(getGeminiJobTarget, {
      jobId: queued.jobId,
      leaseToken: recovery.leaseToken,
    })).resolves.toMatchObject({ kind: "delete_store", storeName });
    await t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId,
      leaseToken: recovery.leaseToken,
      result: { kind: "store_deleted", storeName },
    });
    const final = await t.run(async (ctx) => ({
      job: await ctx.db.get("integrationJobs", queued.jobId),
      jurisdiction: await ctx.db.get(jurisdictionId),
    }));
    expect(final.job?.status).toBe("succeeded");
    expect(final.jurisdiction).toMatchObject({ providerSyncState: "pending" });
    expect(final.jurisdiction?.geminiExecutionPermit).toBeUndefined();
    expect(final.jurisdiction).not.toHaveProperty("geminiFileSearchStoreName");
  });

  it("fails store teardown closed across lifecycle, step-up, confirmation, and jurisdiction ownership", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const fixture = await t.run(async (ctx) => {
      const now = Date.now();
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Ghana",
        slug: "ghana",
        status: "draft",
        isDefault: true,
        geminiFileSearchStoreName: "fileSearchStores/ghana-test",
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: "synced",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const resourceId = await ctx.db.insert("legalResources", {
        jurisdictionId,
        type: "act",
        title: "Active Act",
        issuer: "Parliament",
        officialCitation: "Act 1",
        officialCitationKey: "act 1",
        sourceUrl: "https://example.invalid/act",
        topics: [],
        effectiveDate: "2026-01-01",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const storageId = await ctx.storage.store(new Blob(["act"]));
      const versionId = await ctx.db.insert("documentVersions", {
        resourceId,
        versionNumber: 1,
        originalStorageId: storageId,
        filename: "act.pdf",
        mimeType: "application/pdf",
        byteSize: 3,
        sha256: "a".repeat(64),
        sourceUrl: "https://example.invalid/act",
        status: "published",
        submittedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(resourceId, { activeVersionId: versionId });
      return { jurisdictionId, resourceId, versionId };
    });
    const idempotencyKey = "delete-gemini-store-ghana";
    const input = {
      jurisdictionId: fixture.jurisdictionId,
      reason: "Remove unused legal search store",
      confirmation: "DELETE GEMINI STORE ghana",
      idempotencyKey,
    };

    await expect(admin.client.mutation(deleteJurisdictionGeminiStore, input)).rejects.toThrow(
      "JURISDICTION_HAS_ACTIVE_PUBLISHED_RESOURCE",
    );
    await t.run((ctx) => ctx.db.patch(fixture.resourceId, { status: "archived" }));
    await expect(admin.client.mutation(deleteJurisdictionGeminiStore, input)).rejects.toThrow(
      "JURISDICTION_HAS_ACTIVE_PUBLISHED_RESOURCE",
    );
    await t.run((ctx) => ctx.db.patch(fixture.resourceId, { activeVersionId: undefined, status: "active" }));
    await expect(admin.client.mutation(deleteJurisdictionGeminiStore, {
      ...input,
      confirmation: "DELETE GEMINI STORE wrong",
    })).rejects.toThrow("ADMIN_CONFIRMATION_MISMATCH");
    await expect(admin.client.mutation(deleteJurisdictionGeminiStore, input)).rejects.toThrow(
      "ADMIN_STEP_UP_REQUIRED",
    );

    await t.run((ctx) => ctx.db.insert("adminStepUpProofs", {
      actorId: admin.userId,
      sessionId: admin.sessionId,
      action: "jurisdiction_store_delete",
      targetId: fixture.jurisdictionId,
      idempotencyKey,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    }));
    const queued = await admin.client.mutation(deleteJurisdictionGeminiStore, input);
    expect(queued).not.toHaveProperty("storeName");
    expect(queued).not.toHaveProperty("providerOperationName");
    const job = await t.run((ctx) => ctx.db.get("integrationJobs", queued.jobId));
    expect(job).toMatchObject({ type: "gemini_delete_store", targetId: fixture.jurisdictionId });
    expect(JSON.parse(job?.payload ?? "{}")).toMatchObject({ storeName: "fileSearchStores/ghana-test" });
    await expect(t.run((ctx) => ctx.db.get(fixture.jurisdictionId))).resolves.toMatchObject({ providerSyncState: "drifted" });

    const leaseToken = await claimLease(t, queued.jobId);
    await t.run((ctx) => ctx.db.patch(fixture.resourceId, {
      activeVersionId: fixture.versionId,
      status: "archived",
    }));
    await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken })).rejects.toThrow(
      "GEMINI_STORE_DELETE_PRECONDITION_FAILED",
    );
    await t.run((ctx) => ctx.db.patch(fixture.resourceId, { activeVersionId: undefined, status: "active" }));
    await t.run((ctx) => ctx.db.patch(fixture.jurisdictionId, { status: "enabled" }));
    await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken })).rejects.toThrow(
      "GEMINI_STORE_DELETE_PRECONDITION_FAILED",
    );
    await t.run((ctx) => ctx.db.patch(fixture.jurisdictionId, { status: "draft", providerSyncState: "pending" }));
    await expect(t.query(getGeminiJobTarget, { jobId: queued.jobId, leaseToken })).rejects.toThrow(
      "GEMINI_STORE_DELETE_PRECONDITION_FAILED",
    );
    await t.run((ctx) => ctx.db.patch(fixture.jurisdictionId, { providerSyncState: "drifted" }));
    await t.mutation(applyGeminiProviderResult, {
      jobId: queued.jobId,
      leaseToken,
      result: { kind: "store_deleted", storeName: "fileSearchStores/ghana-test" },
    });
    const jurisdiction = await t.run((ctx) => ctx.db.get(fixture.jurisdictionId));
    expect(jurisdiction).toMatchObject({ providerSyncState: "pending" });
    expect(jurisdiction).not.toHaveProperty("geminiFileSearchStoreName");
    expect(jurisdiction).not.toHaveProperty("geminiEmbeddingModel");
  });
});
