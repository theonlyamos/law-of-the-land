/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { buildConversationExport } from "./exportActions";

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
const updateIncident = makeFunctionReference<"mutation">("admin/operations:updateIncident");
const addIncidentNote = makeFunctionReference<"mutation">("admin/operations:addIncidentNote");
const listIncidentTimeline = makeFunctionReference<"query">("admin/operations:listIncidentTimeline");
const finalizeExport = makeFunctionReference<"mutation">("admin/exports:finalizeConversationExport");
const getExportPage = makeFunctionReference<"query">("admin/exports:getConversationExportPage");
const issueExportReference = makeFunctionReference<"mutation">("admin/exports:issueConversationExportReference");
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

async function queueExportFixture(t: Backend, suffix: string) {
  const admin = await asAdmin(t, "support_agent");
  const chatId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("chatSessions", { userId: `user_${suffix}`, externalId: `export-${suffix}`, title: "Export", lastMessage: "safe", messageCount: 1, updatedAt: Date.now() });
    await ctx.db.insert("messages", { sessionId: id, role: "user", content: "private export body", createdAt: Date.now() });
    return id;
  });
  const grantId = await t.run((ctx) => ctx.db.insert("adminAccessGrants", { adminId: admin.userId, chatSessionId: chatId, purpose: "Approved export race test", issuedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, correlationId: `grant_${suffix}` }));
  const idempotencyKey = `export-race-${suffix}`;
  await t.run((ctx) => ctx.db.insert("adminStepUpProofs", { actorId: admin.userId, sessionId: admin.sessionId, action: "conversation_export", targetId: `${chatId}:${grantId}`, idempotencyKey, issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000 }));
  const queued = await admin.client.mutation(queueConversationExport, { chatId, grantId, reason: "Attach transcript to approved support case", idempotencyKey, confirmation: `EXPORT ${chatId}` });
  const exportRow = await t.run((ctx) => ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", queued.correlationId)).unique());
  if (!exportRow) throw new Error("queued export fixture was not created");
  return { admin, chatId, grantId, queued, exportRow };
}

type ExportAuthorityChange = "grant revoked" | "grant expired" | "requester demoted" | "session invalid" | "session impersonated" | "2FA lost";

async function invalidateExportAuthority(t: Backend, fixture: Awaited<ReturnType<typeof queueExportFixture>>, change: ExportAuthorityChange) {
  await t.run(async (ctx) => {
    if (change === "grant revoked") {
      await ctx.db.patch(fixture.grantId, { revokedAt: Date.now() });
    } else if (change === "grant expired") {
      await ctx.db.patch(fixture.grantId, { expiresAt: Date.now() - 1 });
    } else if (change === "requester demoted") {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "user", where: [{ field: "_id", operator: "eq", value: fixture.admin.userId }], update: { role: "user" } } });
    } else if (change === "session invalid") {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", operator: "eq", value: fixture.admin.sessionId }], update: { expiresAt: Date.now() - 1 } } });
    } else if (change === "session impersonated") {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", operator: "eq", value: fixture.admin.sessionId }], update: { impersonatedBy: "original-admin" } } });
    } else {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", operator: "eq", value: fixture.admin.sessionId }], update: { adminTwoFactorVerifiedAt: null } } });
    }
  });
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

  it("replays the recorded retry and cancellation results after the jobs advance", async () => {
    const t = createBackend(); await enablePanel(t); const admin = await asAdmin(t);
    const failed = await seedJob(t, "failed", { lastErrorKind: "network" });
    const retryInput = { jobId: failed, reason: "Retry transient provider failure", idempotencyKey: "retry-advanced-1" };
    const retryResult = await admin.client.mutation(retryJob, retryInput);
    await t.run((ctx) => ctx.db.patch(failed, { status: "succeeded", updatedAt: Date.now() }));
    expect(await admin.client.mutation(retryJob, retryInput)).toEqual(retryResult);

    const queued = await seedJob(t, "queued");
    const cancelInput = { jobId: queued, reason: "Cancel duplicate queued work", idempotencyKey: "cancel-advanced-1" };
    const cancelResult = await admin.client.mutation(cancelJob, cancelInput);
    await t.run((ctx) => ctx.db.patch(queued, { status: "failed", updatedAt: Date.now() }));
    expect(await admin.client.mutation(cancelJob, cancelInput)).toEqual(cancelResult);
  });
});

describe("incidents and immutable timeline", () => {
  it("preserves newer status and severity when a stale operator changes only ownership", async () => {
    const t = createBackend(); await enablePanel(t);
    const staleOperator = await asAdmin(t); const newerOperator = await asAdmin(t);
    const created = await staleOperator.client.mutation(createIncident, { title: "Concurrent incident", severity: "low", reason: "Open a concurrent incident regression", idempotencyKey: "incident-concurrent-create" });
    await newerOperator.client.mutation(updateIncident, { incidentId: created.incidentId, status: "investigating", severity: "high", reason: "Escalate from fresh operational evidence", idempotencyKey: "incident-concurrent-escalate" });
    await staleOperator.client.mutation(updateIncident, { incidentId: created.incidentId, ownerId: "incident_commander", reason: "Assign ownership from a stale register page", idempotencyKey: "incident-concurrent-owner" });

    const incident = await t.run((ctx) => ctx.db.get(created.incidentId as Id<"systemIncidents">));
    expect(incident).toMatchObject({ status: "investigating", severity: "high", ownerId: "incident_commander" });
  });

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
  it("stream-limits export reference bodies independently of Content-Length", async () => {
    const t = createBackend();
    const reference = `exp_${"z".repeat(64)}`;
    const valid = JSON.stringify({ reference });
    const oversized = `${valid}${" ".repeat(257 - valid.length)}`;
    expect((await t.fetch("/admin/export-download", { method: "POST" })).status).toBe(400);
    expect((await t.fetch("/admin/export-download", { method: "POST", body: oversized })).status).toBe(400);
    expect((await t.fetch("/admin/export-download", { method: "POST", headers: { "content-length": "1" }, body: oversized })).status).toBe(400);
    expect((await t.fetch("/admin/export-download", { method: "POST", body: `${valid}${" ".repeat(256 - valid.length)}` })).status).toBe(404);
    expect((await t.fetch("/admin/export-download", { method: "POST", body: "{not-json" })).status).toBe(400);
    expect((await t.fetch("/admin/export-download", { method: "POST", body: valid })).status).toBe(404);
  });

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
    const [first, second] = await Promise.all([
      admin.client.fetch("/admin/export-download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: issued.reference }) }),
      admin.client.fetch("/admin/export-download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: issued.reference }) }),
    ]);
    expect([first, second].filter((item) => item.status === 200)).toHaveLength(1);
    const winner = [first, second].find((item) => item.status === 200)!;
    expect(winner.headers.get("content-disposition")).toBe('attachment; filename="conversation-export.ndjson"');
    expect(winner.headers.get("cache-control")).toContain("no-store");
    expect(await winner.text()).toBe("transcript");
    expect((await admin.client.fetch("/admin/export-download", { method: "POST", body: JSON.stringify({ reference: issued.reference }) })).status).toBe(404);
    const persisted = JSON.stringify(await t.run(async (ctx) => ({ exports: await ctx.db.query("adminExports").take(5), refs: await ctx.db.query("exportDownloadReferences").take(5), audits: await ctx.db.query("auditEvents").take(20) })));
    expect(persisted).not.toContain(issued.reference);
    expect(persisted).not.toMatch(/https?:\/\//);
  });

  it.each([
    "grant revoked",
    "grant expired",
    "requester demoted",
    "session invalid",
    "session impersonated",
    "2FA lost",
  ] as const)("fails a queued export safely when %s before the next page", async (change) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const t = createBackend(); await enablePanel(t);
    const fixture = await queueExportFixture(t, `page-${change.replaceAll(" ", "-")}`);
    await invalidateExportAuthority(t, fixture, change);

    await expect(t.query(getExportPage, { exportId: fixture.exportRow._id, paginationOpts: { numItems: 100, cursor: null } })).rejects.toThrow("ADMIN_EXPORT_AUTHORITY_EXPIRED");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const exportRow = await t.run((ctx) => ctx.db.get(fixture.exportRow._id));
    expect(exportRow).toMatchObject({ status: "failed" });
    expect(exportRow).not.toHaveProperty("storageId");
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(1))).toHaveLength(0);
  });

  it.each([
    "grant revoked",
    "grant expired",
    "requester demoted",
    "session invalid",
    "session impersonated",
    "2FA lost",
  ] as const)("refuses finalization when %s after build authorization", async (change) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const t = createBackend(); await enablePanel(t);
    const fixture = await queueExportFixture(t, `finalize-${change.replaceAll(" ", "-")}`);
    const candidate = await t.run((ctx) => ctx.storage.store(new Blob(["candidate"] as BlobPart[], { type: "application/x-ndjson" })));
    await invalidateExportAuthority(t, fixture, change);

    await expect(t.mutation(finalizeExport, { correlationId: fixture.queued.correlationId, storageId: candidate })).rejects.toThrow("ADMIN_EXPORT_AUTHORITY_EXPIRED");
    const exportRow = await t.run((ctx) => ctx.db.get(fixture.exportRow._id));
    expect(exportRow).toMatchObject({ status: "queued" });
    expect(exportRow).not.toHaveProperty("storageId");
    await t.run((ctx) => ctx.storage.delete(candidate));
  });

  it("deletes the newly stored artifact when finalization finds a conflicting artifact", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const t = createBackend(); await enablePanel(t);
    const fixture = await queueExportFixture(t, "finalization-conflict");
    const winner = await t.run((ctx) => ctx.storage.store(new Blob(["winner"] as BlobPart[], { type: "application/x-ndjson" })));
    let candidateId: Id<"_storage"> | null = null;
    const handler = (buildConversationExport as unknown as { _handler: (ctx: unknown, args: { exportId: Id<"adminExports"> }) => Promise<null> })._handler;
    await handler({
      runQuery: (reference: Parameters<Backend["query"]>[0], args: Parameters<Backend["query"]>[1]) => t.query(reference, args),
      runMutation: (reference: Parameters<Backend["mutation"]>[0], args: Parameters<Backend["mutation"]>[1]) => t.mutation(reference, args),
      storage: {
        store: async (blob: Blob) => {
          candidateId = await t.run((ctx) => ctx.storage.store(blob));
          await t.mutation(finalizeExport, { correlationId: fixture.queued.correlationId, storageId: winner });
          return candidateId;
        },
        delete: (storageId: Id<"_storage">) => t.run((ctx) => ctx.storage.delete(storageId)),
      },
    }, { exportId: fixture.exportRow._id });

    expect(candidateId).not.toBeNull();
    const exportRow = await t.run((ctx) => ctx.db.get(fixture.exportRow._id));
    expect(exportRow).toMatchObject({ status: "ready", storageId: winner });
    const blobs = await t.run((ctx) => ctx.db.system.query("_storage").take(3));
    expect(blobs.map((blob) => blob._id)).toEqual([winner]);
  });
});

describe("bounded retention", () => {
  it("keeps a multi-operation export phase when only one budget unit remains", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = createBackend();
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    const fixture = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", { userId: "no_fit_user", externalId: "no-fit", title: "No fit", lastMessage: "safe", messageCount: 0, updatedAt: old });
      const grantId = await ctx.db.insert("adminAccessGrants", { adminId: "no_fit_admin", chatSessionId: chatId, purpose: "Expired no-fit anchor", issuedAt: old, expiresAt: old, correlationId: "no_fit_anchor" });
      for (let index = 0; index < 39; index += 1) await ctx.db.insert("adminAccessGrants", { adminId: "no_fit_admin", chatSessionId: chatId, purpose: "Expired no-fit grant", issuedAt: old, expiresAt: old, correlationId: `no_fit_grant_${index}` });
      const referenceExportId = await ctx.db.insert("adminExports", { correlationId: "no_fit_reference_anchor", requesterId: "no_fit_admin", requesterSessionId: "no_fit_session", chatSessionId: chatId, accessGrantId: grantId, status: "queued", expiresAt: Date.now() + 400 * 24 * 60 * 60_000, createdAt: old, updatedAt: old });
      for (let index = 0; index < 40; index += 1) await ctx.db.insert("exportDownloadReferences", { exportId: referenceExportId, requesterId: "no_fit_admin", referenceHash: `no_fit_ref_${index}`.padEnd(64, "f"), expiresAt: old, createdAt: old });
      for (const [status, count] of [["queued", 40], ["ready", 40], ["failed", 39]] as const) {
        for (let index = 0; index < count; index += 1) await ctx.db.insert("adminExports", { correlationId: `no_fit_${status}_${index}`, requesterId: "no_fit_admin", requesterSessionId: "no_fit_session", chatSessionId: chatId, accessGrantId: grantId, status, expiresAt: old, createdAt: old, updatedAt: old });
      }
      const storageId = await ctx.storage.store(new Blob(["stored-expired-export"]));
      const exportId = await ctx.db.insert("adminExports", { correlationId: "no_fit_stored_expired", requesterId: "no_fit_admin", requesterSessionId: "no_fit_session", chatSessionId: chatId, accessGrantId: grantId, status: "expired", storageId, expiresAt: old, createdAt: old, updatedAt: old });
      return { exportId, storageId };
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));

    const first = await t.mutation(runRetentionBatch, { cursor: null });
    expect(first).toMatchObject({ deleted: 199, done: false });
    const blocked = await t.run(async (ctx) => ({ state: await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique(), exportRow: await ctx.db.get(fixture.exportId), blob: await ctx.db.system.get("_storage", fixture.storageId) }));
    expect(blocked.state).toMatchObject({ phase: "exports_expired", cycleHadChanges: true });
    expect(blocked.state?.lastSuccessfulAt).toBeUndefined();
    expect(blocked.exportRow).not.toBeNull();
    expect(blocked.blob).not.toBeNull();

    const second = await t.mutation(runRetentionBatch, { cursor: first.cursor });
    expect(second.deleted).toBe(2);
    expect(second.done).toBe(false);
    const consumed = await t.run(async (ctx) => ({ state: await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique(), exportRow: await ctx.db.get(fixture.exportId), blob: await ctx.db.system.get("_storage", fixture.storageId) }));
    expect(consumed.state?.lastSuccessfulAt).toBeUndefined();
    expect(consumed.exportRow).toBeNull();
    expect(consumed.blob).toBeNull();

    const concurrent = await Promise.all([t.mutation(runRetentionBatch, { cursor: second.cursor }), t.mutation(runRetentionBatch, { cursor: "duplicate_after_no_fit" })]);
    expect(concurrent.every((result) => result.deleted <= 200)).toBe(true);
    let result = concurrent[1];
    while (!result.done) result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
    const finalState = await t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique());
    expect(finalState).toMatchObject({ phase: "complete", lastSuccessfulAt: Date.now() });
  });

  it("resumes the persisted phase across stale and concurrent continuation attempts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = createBackend();
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    await t.run(async (ctx) => {
      for (let index = 0; index < 90; index += 1) await ctx.db.insert("integrationJobs", { type: "poll_process", targetType: "operation", targetId: `concurrent_${index}`, payload: JSON.stringify({ secret: index }), actorId: "system", actorRoles: [], idempotencyKey: `concurrent_${index}`, requestFingerprint: "{}", correlationId: `concurrent_${index}`, callbackTokenHash: "e".repeat(64), status: "failed", attemptCount: 1, lastErrorKind: "network", retentionPending: true, createdAt: old, updatedAt: old });
      await ctx.db.insert("retentionState", { key: "default", phase: "jobs_failed", cycleHadChanges: true, storagePassHadChanges: false, deletedTotal: 0, lastStartedAt: old, updatedAt: old });
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));

    const [first, duplicate] = await Promise.all([
      t.mutation(runRetentionBatch, { cursor: "stale_after_crash" }),
      t.mutation(runRetentionBatch, { cursor: null }),
    ]);
    expect(first.deleted).toBeLessThanOrEqual(200);
    expect(duplicate.deleted).toBeLessThanOrEqual(200);
    let result = duplicate;
    while (!result.done) result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
    const snapshot = await t.run(async (ctx) => ({ states: await ctx.db.query("retentionState").take(2), jobs: await ctx.db.query("integrationJobs").take(100) }));
    expect(snapshot.states).toHaveLength(1);
    expect(snapshot.jobs.every((job) => job.retentionPending === false && job.payload === "{}")).toBe(true);
  });

  it("round-robins every retention category while earlier backlogs are replenished and completes only after a clean cycle", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = createBackend();
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    const fixture = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", { userId: "retention_user", externalId: "retention-fairness", title: "Retention", lastMessage: "safe", messageCount: 0, updatedAt: old });
      const grantId = await ctx.db.insert("adminAccessGrants", { adminId: "retention_admin", chatSessionId: chatId, purpose: "Expired retention fixture", issuedAt: old, expiresAt: old, correlationId: "retention_grant_anchor" });
      for (let index = 0; index < 120; index += 1) {
        await ctx.db.insert("adminAccessGrants", { adminId: "retention_admin", chatSessionId: chatId, purpose: "Replenished early backlog", issuedAt: old, expiresAt: old, correlationId: `retention_grant_${index}` });
      }
      for (const status of ["queued", "ready", "failed", "expired"] as const) {
        for (let index = 0; index < 45; index += 1) {
          const exportId = await ctx.db.insert("adminExports", { correlationId: `retention_export_${status}_${index}`, requesterId: "retention_admin", requesterSessionId: "retention_session", chatSessionId: chatId, accessGrantId: grantId, status, expiresAt: old, createdAt: old, updatedAt: old });
          if (status === "queued") await ctx.db.insert("exportDownloadReferences", { exportId, requesterId: "retention_admin", referenceHash: `${status}_${index}`.padEnd(64, "a"), expiresAt: old, createdAt: old });
        }
      }
      for (const status of ["issued", "search_complete", "chat_claimed", "finalized"] as const) {
        for (let index = 0; index < 45; index += 1) await ctx.db.insert("telemetryCorrelations", { tokenHash: `${status}_${index}`.padEnd(64, "b"), ownerBinding: "owner", sessionBinding: "session", jurisdictionCode: "GH", status, issuedAt: old, expiresAt: old });
      }
      for (let index = 0; index < 45; index += 1) await ctx.db.insert("queryRuns", { correlationId: `retention_fair_run_${index}`, day: "2025-01-01", jurisdictionCode: "GH", outcome: "success", searchProviderStatus: "success", generationProviderStatus: "success", searchLatencyMs: 1, generationLatencyMs: 1, totalLatencyMs: 2, resultCount: 1, completedAt: old, rollupStatus: "processed", rolledUpAt: old });
      for (const status of ["succeeded", "failed", "cancelled"] as const) {
        for (let index = 0; index < 45; index += 1) await ctx.db.insert("integrationJobs", { type: "poll_process", targetType: "operation", targetId: `fair_${status}_${index}`, payload: JSON.stringify({ secret: index }), actorId: "system", actorRoles: [], idempotencyKey: `fair_${status}_${index}`, requestFingerprint: "{}", correlationId: `fair_${status}_${index}`, callbackTokenHash: "c".repeat(64), status, attemptCount: 1, lastErrorKind: "network", retentionPending: true, createdAt: old, updatedAt: old });
      }
      const orphanIds = [] as Id<"_storage">[];
      for (let index = 0; index < 45; index += 1) orphanIds.push(await ctx.storage.store(new Blob([`orphan-${index}`])));
      return { chatId, orphanIds };
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));

    let result = await t.mutation(runRetentionBatch, { cursor: null });
    expect(result.deleted).toBeLessThanOrEqual(200);
    for (let invocation = 0; invocation < 2; invocation += 1) {
      await t.run(async (ctx) => {
        for (let index = 0; index < 120; index += 1) await ctx.db.insert("adminAccessGrants", { adminId: "retention_admin", chatSessionId: fixture.chatId, purpose: "Continuously replenished backlog", issuedAt: Date.now() - 100 * 24 * 60 * 60_000, expiresAt: Date.now() - 1, correlationId: `replenished_${invocation}_${index}` });
      });
      result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
      expect(result.deleted).toBeLessThanOrEqual(200);
    }

    const advanced = await t.run(async (ctx) => ({
      correlations: await ctx.db.query("telemetryCorrelations").take(500),
      jobs: await ctx.db.query("integrationJobs").take(500),
      storage: await ctx.db.system.query("_storage").take(500),
      state: await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique(),
    }));
    expect(advanced.correlations.length).toBeLessThan(180);
    expect(advanced.jobs.filter((job) => job.retentionPending === true).length).toBeLessThan(135);
    expect(advanced.storage.length).toBeLessThan(45);
    expect(advanced.state?.lastSuccessfulAt).toBeUndefined();

    let invocations = 3;
    while (!result.done && invocations < 80) {
      result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
      expect(result.deleted).toBeLessThanOrEqual(200);
      invocations += 1;
    }
    expect(result.done).toBe(true);
    const drained = await t.run(async (ctx) => ({
      grants: await ctx.db.query("adminAccessGrants").take(1), refs: await ctx.db.query("exportDownloadReferences").take(1), exports: await ctx.db.query("adminExports").take(1), correlations: await ctx.db.query("telemetryCorrelations").take(1), runs: await ctx.db.query("queryRuns").take(1), pendingJobs: await ctx.db.query("integrationJobs").withIndex("by_status_and_retentionPending_and_createdAt", (q) => q.eq("status", "failed").eq("retentionPending", true)).take(1), storage: await ctx.db.system.query("_storage").take(1), state: await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique(),
    }));
    expect(drained).toMatchObject({ grants: [], refs: [], exports: [], correlations: [], runs: [], pendingJobs: [], storage: [], state: { phase: "complete", lastSuccessfulAt: Date.now() } });
  }, 20_000);

  it("redacts more than 200 eligible jobs per terminal status across invocations and completes only after exhaustion", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = createBackend();
    const old = Date.now() - 100 * 24 * 60 * 60_000;
    await t.run(async (ctx) => {
      for (const status of ["succeeded", "failed", "cancelled"] as const) {
        for (let index = 0; index < 201; index += 1) {
          await ctx.db.insert("integrationJobs", {
            type: "poll_process", targetType: "operation", targetId: `${status}_${index}`,
            payload: JSON.stringify({ secret: `${status}-${index}` }), actorId: "system", actorRoles: [],
            idempotencyKey: `${status}_${index}_${crypto.randomUUID()}`, requestFingerprint: "{}",
            correlationId: `retention_${status}_${index}`, callbackTokenHash: "a".repeat(64),
            status, attemptCount: 1, lastErrorKind: "network", retentionPending: true,
            createdAt: old + index, updatedAt: old + index,
          });
        }
        for (let index = 0; index < 3; index += 1) {
          await ctx.db.insert("integrationJobs", {
            type: "poll_process", targetType: "operation", targetId: `redacted_${status}_${index}`,
            payload: "{}", actorId: "system", actorRoles: [], idempotencyKey: `redacted_${status}_${index}_${crypto.randomUUID()}`,
            requestFingerprint: "{}", correlationId: `redacted_${status}_${index}`, callbackTokenHash: "a".repeat(64),
            status, attemptCount: 1, retentionPending: false, retentionRedactedAt: old,
            createdAt: old + index, updatedAt: old + index,
          });
        }
      }
    });
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));

    let result = await t.mutation(runRetentionBatch, { cursor: null });
    expect(result).toMatchObject({ deleted: 200, done: false });
    expect((await t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique()))?.lastSuccessfulAt).toBeUndefined();
    let invocations = 1;
    while (!result.done && invocations < 10) {
      result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
      invocations += 1;
      if (!result.done) {
        expect((await t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique()))?.lastSuccessfulAt).toBeUndefined();
      }
    }

    expect(result.done).toBe(true);
    expect(invocations).toBeGreaterThan(3);
    const jobs = await t.run((ctx) => ctx.db.query("integrationJobs").take(700));
    expect(jobs).toHaveLength(612);
    expect(jobs.filter((job) => job.retentionPending === true)).toHaveLength(0);
    expect(jobs.filter((job) => job.retentionPending === false)).toHaveLength(612);
    expect(jobs.filter((job) => job.retentionRedactedAt === old)).toHaveLength(9);
    expect(jobs.every((job) => job.payload === "{}" && job.lastErrorKind === undefined)).toBe(true);
    const state = await t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique());
    expect(state).toMatchObject({ lastSuccessfulAt: Date.now(), deletedTotal: 603 });
  });

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
    let result = await t.mutation(runRetentionBatch, { cursor: null });
    let deleted = result.deleted;
    expect(result.deleted).toBeLessThanOrEqual(200);
    while (!result.done) {
      result = await t.mutation(runRetentionBatch, { cursor: result.cursor });
      expect(result.deleted).toBeLessThanOrEqual(200);
      deleted += result.deleted;
    }
    expect(deleted).toBe(205);
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
