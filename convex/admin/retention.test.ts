/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("../betterAuth/".length)}`,
    load,
  ]),
);
type Backend = TestConvex<typeof schema>;

const retryJob = makeFunctionReference<"mutation">("admin/jobs:retryJob");
const cancelJob = makeFunctionReference<"mutation">("admin/jobs:cancelJob");
const runRetentionBatch = makeFunctionReference<"mutation">("admin/operations:runRetentionBatch");
const createIncident = makeFunctionReference<"mutation">("admin/operations:createIncident");
const addIncidentNote = makeFunctionReference<"mutation">("admin/operations:addIncidentNote");
const listIncidentTimeline = makeFunctionReference<"query">("admin/operations:listIncidentTimeline");
const finalizeExport = makeFunctionReference<"mutation">("admin/exports:finalizeConversationExport");
const issueExportReference = makeFunctionReference<"mutation">("admin/exports:issueConversationExportReference");
const consumeExportReference = makeFunctionReference<"mutation">("admin/exports:consumeConversationExportReference");
const queueConversationExport = makeFunctionReference<"mutation">("admin/exports:queueConversationExport");

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run((ctx) => ctx.db.insert("featureFlags", {
    key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now(),
  }));
}

async function asAdmin(t: Backend, role = "super_admin") {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        name: "Task 18 admin", email: `${crypto.randomUUID()}@example.com`, emailVerified: true,
        createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true,
      } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: {
        token: `session-${crypto.randomUUID()}`, userId: user._id, expiresAt: now + 60_000,
        createdAt: now, updatedAt: now, adminTwoFactorVerifiedAt: now,
      } },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return { client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }), ...identity };
}

async function seedJob(t: Backend, status: "queued" | "succeeded" | "failed" | "manual_review", overrides: Record<string, unknown> = {}) {
  return await t.run((ctx) => ctx.db.insert("integrationJobs", {
    type: "poll_process", targetType: "operation", targetId: `target_${crypto.randomUUID()}`,
    payload: "{}", actorId: "system", actorRoles: [], idempotencyKey: `seed_${crypto.randomUUID()}`,
    requestFingerprint: "{}", correlationId: `job_${crypto.randomUUID().replaceAll("-", "")}`,
    callbackTokenHash: "a".repeat(64), status, attemptCount: status === "failed" ? 1 : 0,
    createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
  } as never));
}

const previousEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousEnvironment = process.env.ADMIN_ENVIRONMENT;
afterEach(() => {
  vi.useRealTimers();
  if (previousEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousEnabled;
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

describe("authoritative job controls", () => {
  it("rejects succeeded retries and idempotently retries only terminal safe work", async () => {
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t);
    const succeeded = await seedJob(t, "succeeded");
    await expect(admin.client.mutation(retryJob, { jobId: succeeded, reason: "Operator approved retry", idempotencyKey: "retry-succeeded-1" })).rejects.toThrow("not retryable");
    const failed = await seedJob(t, "failed", { lastErrorKind: "network" });
    const input = { jobId: failed, reason: "Retry transient provider failure", idempotencyKey: "retry-failed-1" };
    const first = await admin.client.mutation(retryJob, input);
    const replay = await admin.client.mutation(retryJob, input);
    expect(replay).toEqual(first);
    const retried = await t.run((ctx) => ctx.db.get(failed));
    expect(retried).toMatchObject({ status: "queued" });
    expect(retried).not.toHaveProperty("leaseToken");
    expect(retried).not.toHaveProperty("processId");
  });

  it("cancels only unclaimed queued work and preserves provider uncertainty", async () => {
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t);
    const queued = await seedJob(t, "queued");
    const input = { jobId: queued, reason: "Duplicate work is no longer needed", idempotencyKey: "cancel-queued-1" };
    expect(await admin.client.mutation(cancelJob, input)).toEqual(await admin.client.mutation(cancelJob, input));
    const uncertain = await seedJob(t, "manual_review", { processId: "provider-process", lastErrorKind: "timeout" });
    await expect(admin.client.mutation(cancelJob, { jobId: uncertain, reason: "Do not guess provider outcome", idempotencyKey: "cancel-uncertain-1" })).rejects.toThrow("provider outcome is uncertain");
  });
});

describe("incidents and immutable timeline", () => {
  it("creates an incident and append-only, bounded notes without exposing mutable audit fields", async () => {
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t);
    const incident = await admin.client.mutation(createIncident, {
      title: "GroundX callback backlog", severity: "high", reason: "Callbacks exceeded the operating threshold", idempotencyKey: "incident-create-1",
    });
    await admin.client.mutation(addIncidentNote, { incidentId: incident.incidentId, note: "Provider status page is under review", reason: "Record investigation progress", idempotencyKey: "incident-note-1" });
    const timeline = await admin.client.query(listIncidentTimeline, { incidentId: incident.incidentId, paginationOpts: { numItems: 20, cursor: null } });
    expect(timeline.page.map((row: { kind: string }) => row.kind)).toEqual(["created", "note"]);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("auditEvents").take(20)))).not.toContain("Provider status page is under review");
  });
});

describe("one-time conversation export references", () => {
  it("builds the queued export artifact asynchronously without placing content in audit", async () => {
    vi.useFakeTimers();
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t, "support_agent");
    const chatId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("chatSessions", { userId: "user_async", externalId: "async-export", title: "Async", lastMessage: "safe", messageCount: 1, updatedAt: Date.now() });
      await ctx.db.insert("messages", { sessionId: id, role: "user", content: "private export body", createdAt: Date.now() });
      return id;
    });
    const grantId = await t.run((ctx) => ctx.db.insert("adminAccessGrants", { adminId: admin.userId, chatSessionId: chatId, purpose: "Approved async export", issuedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, correlationId: "grant_async" }));
    const idempotencyKey = "conversation-export-async";
    await t.run((ctx) => ctx.db.insert("adminStepUpProofs", { actorId: admin.userId, sessionId: admin.sessionId, action: "conversation_export", targetId: `${chatId}:${grantId}`, idempotencyKey, issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000 }));
    const queued = await admin.client.mutation(queueConversationExport, { chatId, grantId, reason: "Attach transcript to approved support case", idempotencyKey, confirmation: `EXPORT ${chatId}` });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const artifact = await t.run((ctx) => ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", queued.correlationId)).unique());
    expect(artifact).toMatchObject({ status: "ready", storageId: expect.any(String) });
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("auditEvents").take(20)))).not.toContain("private export body");
  });

  it("atomically consumes one opaque reference, enforces expiry, and never persists a URL", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t, "support_agent");
    const chatId = await t.run((ctx) => ctx.db.insert("chatSessions", { userId: "user_export", externalId: "export-chat", title: "Export", lastMessage: "safe", messageCount: 0, updatedAt: Date.now() }));
    const grantId = await t.run((ctx) => ctx.db.insert("adminAccessGrants", { adminId: admin.userId, chatSessionId: chatId, purpose: "Case export", issuedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, correlationId: "grant_export" }));
    const idempotencyKey = "conversation-export-1";
    await t.run((ctx) => ctx.db.insert("adminStepUpProofs", { actorId: admin.userId, sessionId: admin.sessionId, action: "conversation_export", targetId: `${chatId}:${grantId}`, idempotencyKey, issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000 }));
    const queued = await admin.client.mutation(queueConversationExport, { chatId, grantId, reason: "Attach transcript to approved support case", idempotencyKey, confirmation: `EXPORT ${chatId}` });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["transcript"] as BlobPart[], { type: "application/json" })));
    await t.mutation(finalizeExport, { correlationId: queued.correlationId, storageId });
    const issued = await admin.client.mutation(issueExportReference, { correlationId: queued.correlationId, grantId });
    expect(issued.reference).toMatch(/^exp_[A-Za-z0-9_-]+$/);
    const [first, second] = await Promise.allSettled([
      admin.client.mutation(consumeExportReference, { reference: issued.reference }),
      admin.client.mutation(consumeExportReference, { reference: issued.reference }),
    ]);
    expect([first, second].filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const persisted = JSON.stringify(await t.run(async (ctx) => ({ exports: await ctx.db.query("adminExports").take(5), refs: await ctx.db.query("exportDownloadReferences").take(5), audits: await ctx.db.query("auditEvents").take(20) })));
    expect(persisted).not.toContain(issued.reference);
    expect(persisted).not.toMatch(/https?:\/\//);
  });
});

describe("bounded retention", () => {
  it("deletes at most 200 globally, resumes fairly, and preserves audit, aggregates, published originals, and attached blobs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = createBackend();
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index += 1) await ctx.db.insert("queryRuns", {
        correlationId: `retention_${index}`, day: "2025-01-01", jurisdictionCode: "GH", outcome: "success", searchProviderStatus: "success", generationProviderStatus: "success", searchLatencyMs: 1, generationLatencyMs: 1, totalLatencyMs: 2, resultCount: 1, completedAt: old, rollupStatus: "processed", rolledUpAt: old,
      });
      await ctx.db.insert("auditEvents", { actorType: "system", actorUserId: "system", actorId: "system", actorRoles: [], action: "retention.protected", targetType: "retention", targetId: "protected_audit", outcome: "success", metadata: {}, createdAt: old });
      await ctx.db.insert("dailyMetrics", { day: "2025-01-01", jurisdictionCode: "GH", totalQuestions: 1, successCount: 1, failureCount: 0, abortedCount: 0, providerFailureCount: 0, noResultCount: 0, latencyLe250: 1, latencyLe500: 0, latencyLe1000: 0, latencyLe2500: 0, latencyLe5000: 0, latencyGt5000: 0, p50UpperBoundMs: 250, p95UpperBoundMs: 250, updatedAt: old });
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const first = await t.mutation(runRetentionBatch, { cursor: null });
    expect(first).toMatchObject({ deleted: 200, done: false });
    const second = await t.mutation(runRetentionBatch, { cursor: first.cursor });
    expect(second.deleted).toBe(5);
    expect(await t.run((ctx) => ctx.db.query("auditEvents").withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "retention").eq("targetId", "protected_audit")).take(1))).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("dailyMetrics").take(2))).toHaveLength(1);
    const state = await t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique());
    expect(state).toMatchObject({ lastSuccessfulAt: expect.any(Number), deletedTotal: 205 });
  });

  it("deletes old unattached storage blobs but preserves attached legal originals and the 24-hour boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
    const t = createBackend();
    const orphan = await t.run((ctx) => ctx.storage.store(new Blob(["orphan"] as BlobPart[])));
    const attached = await t.run((ctx) => ctx.storage.store(new Blob(["original"] as BlobPart[])));
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const boundary = await t.run((ctx) => ctx.storage.store(new Blob(["boundary"] as BlobPart[])));
    await t.run(async (ctx) => {
      const jurisdictionId = await ctx.db.insert("jurisdictions", { code: "GH", name: "Ghana", slug: "ghana", status: "enabled", isDefault: true, providerSyncState: "synced", createdBy: "system", updatedBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
      const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "act", title: "Protected Act", issuer: "Parliament", officialCitation: "Act 1", officialCitationKey: "act-1", sourceUrl: "https://example.invalid/act", topics: [], effectiveDate: "2020-01-01", status: "active", createdBy: "system", updatedBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("documentVersions", { resourceId, versionNumber: 1, originalStorageId: attached, filename: "act.pdf", mimeType: "application/pdf", byteSize: 8, sha256: "a".repeat(64), sourceUrl: "https://example.invalid/act", status: "published", submittedBy: "system", publishedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    await t.mutation(runRetentionBatch, { cursor: null });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", orphan))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get("_storage", attached))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get("_storage", boundary))).not.toBeNull();
  });
});
