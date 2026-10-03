/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { insertDocumentVersion } from "./reviewCounts";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts"))
  .map(([path, load]) => [path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
const claimRef = makeFunctionReference<"mutation">("admin/geminiRecovery:claimActiveDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiRecovery:completeActiveDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiRecovery:abortActiveDocumentRecovery");
const recoveryRef = makeFunctionReference<"action">("admin/geminiRecoveryActions:reconcileActiveDocument");
const storeName = "fileSearchStores/recovery-fixture";
const documentName = `${storeName}/documents/exact-active`;
const reason = "Verify the unique active provider document for the timed-out first publication";

async function fixture(role = "super_admin") {
  vi.stubEnv("ADMIN_PANEL_ENABLED", "true");
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  const ids = await t.run(async ctx => {
    const now = Date.now();
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: now });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Recovery reviewer", email: "recovery@example.invalid", emailVerified: true,
      role, banned: false, twoFactorEnabled: true, createdAt: now, updatedAt: now,
    } } });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "Recovery jurisdiction", slug: "recovery", status: "enabled", isDefault: false,
      geminiFileSearchStoreName: storeName, providerSyncState: "drifted",
      createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: "Recovery act", issuer: "Fixture", officialCitation: "Recovery 1",
      officialCitationKey: "recovery-1", sourceUrl: "https://example.invalid/law", topics: [], status: "active",
      createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now,
    });
    const originalStorageId = await ctx.storage.store(new Blob(["law"], { type: "application/pdf" }));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("law"));
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const versionId = await insertDocumentVersion(ctx, {
      resourceId, versionNumber: 1, originalStorageId, filename: "law.pdf", mimeType: "application/pdf",
      byteSize: 3, sha256, sourceUrl: "https://example.invalid/law", status: "publishing",
      submittedBy: user._id, failureSummary: "Timed out awaiting Gemini", createdAt: now, updatedAt: now,
    });
    const jobId = await ctx.db.insert("integrationJobs", {
      type: "gemini_index_document", targetType: "documentVersion", targetId: versionId,
      payload: JSON.stringify({ operation: "publish", storeName, sha256 }), actorId: user._id,
      actorRoles: ["super_admin"], idempotencyKey: "original-publish", requestFingerprint: "original",
      correlationId: "job_original", status: "manual_review", attemptCount: 1,
      providerOperationName: `${storeName}/upload/operations/retained`, recoveryKind: "poll_operation",
      providerPollCount: 526, providerPollingStartedAt: now - 7 * 60 * 60_000,
      lastErrorKind: "timeout", createdAt: now - 7 * 60 * 60_000, updatedAt: now,
    });
    const lockId = await ctx.db.insert("documentLifecycleLocks", {
      jurisdictionId, resourceId, versionId, operation: "publish", actorId: user._id,
      idempotencyKey: "original-publish", jobId, expiresAt: now + 60 * 60_000, createdAt: now, updatedAt: now,
    });
    return { userId: user._id, jurisdictionId, resourceId, versionId, jobId, lockId, sha256 };
  });
  return { t, ...ids, request: { jobId: ids.jobId, reason, idempotencyKey: "recover-once" } };
}

async function state(t: Backend) {
  return await t.run(async ctx => ({
    jobs: await ctx.db.query("integrationJobs").take(10),
    versions: await ctx.db.query("documentVersions").take(10),
    resources: await ctx.db.query("legalResources").take(10),
    jurisdictions: await ctx.db.query("jurisdictions").take(10),
    locks: await ctx.db.query("documentLifecycleLocks").take(10),
    operations: await ctx.db.query("adminOperations").take(10),
    audits: await ctx.db.query("auditEvents").take(10),
    counts: await ctx.db.query("reviewStageCounts").take(10),
    scheduled: await ctx.db.system.query("_scheduled_functions").take(10),
  }));
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function claimProof(f: Fixture) {
  const claim = await f.t.mutation(claimRef, f.request);
  expect(claim.kind).toBe("claimed");
  return { operationId: claim.operationId, leaseToken: claim.leaseToken, binding: claim.binding, jurisdictionId: claim.jurisdictionId };
}

async function updateUser(f: Fixture, update: { role?: string; banned?: boolean; emailVerified?: boolean; twoFactorEnabled?: boolean }) {
  await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input: { model: "user", where: [{ field: "_id", value: f.userId }], update },
  }));
}

async function addOrganization(f: Fixture) {
  return await f.t.run(async ctx => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Recovery organization", slug: "recovery-org", class: "company", status: "active",
      createdBy: f.userId, updatedBy: f.userId, createdAt: now, updatedAt: now,
    });
    const membershipId = await ctx.db.insert("organizationMemberships", {
      organizationId, userId: f.userId, role: "reviewer", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(f.jurisdictionId, { kind: "organizational", organizationId, visibility: "members" });
    await ctx.db.patch(f.jobId, { organizationId, organizationRole: "reviewer", actorRoles: [] });
    return { organizationId, membershipId };
  });
}

async function addPlatformOrganization(f: Fixture, retainMembership = false) {
  const organization = await addOrganization(f);
  await f.t.run(async ctx => {
    await ctx.db.patch(f.jobId, { organizationId: undefined, organizationRole: undefined, actorRoles: ["super_admin"] });
    if (!retainMembership) await ctx.db.delete(organization.membershipId);
  });
  return organization;
}

const invalidTargets = [
  "wrong job type", "wrong target", "queued job", "missing operation", "foreign operation", "wrong recovery",
  "replacement", "rollback", "malformed payload", "checksum mismatch", "existing active version",
  "existing provider document", "version approved", "resource archived", "jurisdiction archived", "store failed",
  "expired lifecycle lock", "missing lifecycle lock", "duplicate lifecycle lock", "wrong lifecycle operation",
  "wrong lifecycle actor", "wrong lifecycle idempotency", "duplicate store owner", "store teardown",
] as const;

async function invalidateTarget(f: Fixture, scenario: typeof invalidTargets[number]) {
  await f.t.run(async ctx => {
    const job = (await ctx.db.get(f.jobId))!;
    const payload = JSON.parse(job.payload);
    if (scenario === "wrong job type") await ctx.db.patch(f.jobId, { type: "gemini_delete_document" });
    if (scenario === "wrong target") await ctx.db.patch(f.jobId, { targetId: f.resourceId });
    if (scenario === "queued job") await ctx.db.patch(f.jobId, { status: "queued" });
    if (scenario === "missing operation") await ctx.db.patch(f.jobId, { providerOperationName: undefined });
    if (scenario === "foreign operation") await ctx.db.patch(f.jobId, { providerOperationName: "fileSearchStores/foreign/upload/operations/one" });
    if (scenario === "wrong recovery") await ctx.db.patch(f.jobId, { recoveryKind: "delete_document" });
    if (scenario === "replacement" || scenario === "rollback") await ctx.db.patch(f.jobId, {
      payload: JSON.stringify({ ...payload, operation: scenario === "replacement" ? "replace_index" : "rollback_index", previousVersionId: f.versionId }),
    });
    if (scenario === "malformed payload") await ctx.db.patch(f.jobId, { payload: "[]" });
    if (scenario === "checksum mismatch") await ctx.db.patch(f.versionId, { sha256: "b".repeat(64) });
    if (scenario === "existing active version") await ctx.db.patch(f.resourceId, { activeVersionId: f.versionId });
    if (scenario === "existing provider document") await ctx.db.patch(f.versionId, { geminiDocumentName: documentName });
    if (scenario === "version approved") await ctx.db.patch(f.versionId, { status: "approved" });
    if (scenario === "resource archived") await ctx.db.patch(f.resourceId, { status: "archived" });
    if (scenario === "jurisdiction archived") await ctx.db.patch(f.jurisdictionId, { status: "archived" });
    if (scenario === "store failed") await ctx.db.patch(f.jurisdictionId, { providerSyncState: "failed" });
    if (scenario === "expired lifecycle lock") await ctx.db.patch(f.lockId, { expiresAt: Date.now() - 1 });
    if (scenario === "missing lifecycle lock") await ctx.db.delete(f.lockId);
    if (scenario === "duplicate lifecycle lock") {
      const { _id, _creationTime, ...lock } = (await ctx.db.get(f.lockId))!;
      void _id; void _creationTime;
      await ctx.db.insert("documentLifecycleLocks", lock);
    }
    if (scenario === "wrong lifecycle operation") await ctx.db.patch(f.lockId, { operation: "rollback" });
    if (scenario === "wrong lifecycle actor") await ctx.db.patch(f.lockId, { actorId: "different-actor" });
    if (scenario === "wrong lifecycle idempotency") await ctx.db.patch(f.lockId, { idempotencyKey: "different-publish" });
    if (scenario === "duplicate store owner") {
      const { _id, _creationTime, ...jurisdiction } = (await ctx.db.get(f.jurisdictionId))!;
      void _id; void _creationTime;
      await ctx.db.insert("jurisdictions", { ...jurisdiction, slug: "second-owner" });
    }
    if (scenario === "store teardown") await ctx.db.insert("integrationJobs", {
      type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: f.jurisdictionId,
      payload: JSON.stringify({ storeName }), actorId: f.userId, actorRoles: ["super_admin"],
      idempotencyKey: "teardown", requestFingerprint: "teardown", correlationId: "job_teardown",
      status: "queued", attemptCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("active Gemini document recovery mutations", () => {
  it("exposes all recovery mutations only as internal functions", async () => {
    const recovery = await import("./geminiRecovery");
    expect(recovery.claimActiveDocumentRecovery).toHaveProperty("isInternal", true);
    expect(recovery.completeActiveDocumentRecovery).toHaveProperty("isInternal", true);
    expect(recovery.abortActiveDocumentRecovery).toHaveProperty("isInternal", true);
  });

  it("atomically completes the guarded first publication without adding jobs or schedules", async () => {
    const f = await fixture();
    const claim = await f.t.mutation(claimRef, f.request);
    expect(claim.kind).toBe("claimed");
    const { kind, target, ...proof } = claim;
    void kind;
    expect(target.metadata).toMatchObject({ environment: "test", jurisdiction_id: f.jurisdictionId,
      resource_id: f.resourceId, version_id: f.versionId, version_number: "1", sha256: f.sha256 });
    expect(await f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() }))
      .toMatchObject({ status: "succeeded", jobId: f.jobId });
    const after = await state(f.t);
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]).toMatchObject({ status: "succeeded", providerPollCount: 526 });
    expect(after.jobs[0].leaseToken).toBeUndefined();
    expect(after.versions[0]).toMatchObject({ status: "published", geminiDocumentName: documentName });
    expect(after.versions[0].failureSummary).toBeUndefined();
    expect(after.resources[0]).toMatchObject({ activeVersionId: f.versionId, catalogPublished: true });
    expect(after.jurisdictions[0]).toMatchObject({ providerSyncState: "synced" });
    expect(after.jurisdictions[0].geminiExecutionPermit).toBeUndefined();
    expect(after.locks).toHaveLength(0);
    expect(after.scheduled).toHaveLength(0);
    expect(after.counts[0].counts).toMatchObject({ publishing: 0, published: 1 });
    expect(after.operations).toHaveLength(1);
    expect(after.operations[0].status).toBe("succeeded");
    expect(after.audits.map(row => row.action)).toContain("document.publish.success");
    expect(after.audits.map(row => row.action)).toContain("integration.job_succeeded");
    expect(after.audits).toHaveLength(3);
    expect(after.audits.find(row => row.action === "document.publish.reconciled")).toMatchObject({
      actorType: "system", actorId: "gemini_recovery", reason, targetId: f.jobId, outcome: "success",
    });
  });

  it("replays a completed request without additional writes and rejects changed intent", async () => {
    const f = await fixture();
    const proof = await claimProof(f);
    const completion = { ...proof, documentName, verifiedAt: Date.now() };
    const result = await f.t.mutation(completeRef, completion);
    const beforeReplay = await state(f.t);
    expect(await f.t.mutation(claimRef, f.request)).toEqual({ kind: "completed", result });
    expect(await f.t.mutation(completeRef, completion)).toEqual(result);
    await expect(f.t.mutation(claimRef, { ...f.request, reason: "A different recovery request" })).rejects.toThrow();
    expect(await state(f.t)).toEqual(beforeReplay);
  });

  it("allows only one in-flight recovery and creates no duplicate receipt or worker", async () => {
    const f = await fixture();
    await claimProof(f);
    const claimed = await state(f.t);
    await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
    await expect(f.t.mutation(claimRef, { ...f.request, idempotencyKey: "competing-request" })).rejects.toThrow();
    expect(await state(f.t)).toEqual(claimed);
    expect(claimed.operations).toHaveLength(1);
    expect(claimed.jobs[0].status).toBe("running");
    expect(claimed.scheduled).toHaveLength(0);
  });

  it("preserves another job's active jurisdiction execution permit", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const { _id, _creationTime, ...job } = (await ctx.db.get(f.jobId))!;
      void _id; void _creationTime;
      const leaseExpiresAt = Date.now() + 60_000;
      const competingId = await ctx.db.insert("integrationJobs", { ...job, status: "running", leaseToken: "competing-worker",
        leaseExpiresAt, idempotencyKey: "competing-job", correlationId: "job_competing" });
      await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: competingId, leaseExpiresAt } });
    });
    const before = await state(f.t);
    await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it.each(invalidTargets)("rejects %s before acquiring a recovery lease", async scenario => {
    const f = await fixture();
    await invalidateTarget(f, scenario);
    const before = await state(f.t);
    await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["deleted original", "changed size", "changed checksum"])("checks original storage metadata at claim: %s", async scenario => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const version = (await ctx.db.get(f.versionId))!;
      if (scenario === "deleted original") await ctx.storage.delete(version.originalStorageId);
      if (scenario === "changed size") await ctx.db.patch(f.versionId, { byteSize: 4 });
      if (scenario === "changed checksum") {
        await ctx.db.patch(f.versionId, { sha256: "b".repeat(64) });
        await ctx.db.patch(f.jobId, { payload: JSON.stringify({ operation: "publish", storeName, sha256: "b".repeat(64) }) });
      }
    });
    const before = await state(f.t);
    await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it("rechecks the original storage still exists before commit", async () => {
    const f = await fixture();
    const proof = await claimProof(f);
    await f.t.run(async ctx => {
      const version = (await ctx.db.get(f.versionId))!;
      await ctx.storage.delete(version.originalStorageId);
    });
    const before = await state(f.t);
    await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["deployment gate", "feature gate", "missing environment", "unverified email", "two factor disabled", "banned actor", "withdrawn role", "missing actor"])(
    "rejects claim when the original actor no longer has authority: %s", async scenario => {
      const f = await fixture();
      if (scenario === "deployment gate") vi.stubEnv("ADMIN_PANEL_ENABLED", "false");
      if (scenario === "missing environment") vi.stubEnv("ADMIN_ENVIRONMENT", "");
      if (scenario === "feature gate") await f.t.run(async ctx => {
        const flag = (await ctx.db.query("featureFlags").take(1))[0];
        await ctx.db.patch(flag._id, { enabled: false });
      });
      if (scenario === "unverified email") await updateUser(f, { emailVerified: false });
      if (scenario === "two factor disabled") await updateUser(f, { twoFactorEnabled: false });
      if (scenario === "banned actor") await updateUser(f, { banned: true });
      if (scenario === "withdrawn role") await updateUser(f, { role: "content_manager" });
      if (scenario === "missing actor") await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "user", where: [{ field: "_id", value: f.userId }] },
      }));
      const before = await state(f.t);
      await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it("uses the current content reviewer role rather than the job's retained role snapshot", async () => {
    const f = await fixture("content_reviewer");
    await f.t.run(ctx => ctx.db.patch(f.jobId, { actorRoles: ["content_manager"] }));
    const proof = await claimProof(f);
    await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() }))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it("allows a current organization reviewer with no global admin role", async () => {
    const f = await fixture("user");
    await addOrganization(f);
    const proof = await claimProof(f);
    await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() }))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it.each(["before claim", "before completion"])("does not substitute organization membership for missing platform publish permission %s", async phase => {
    const f = await fixture(phase === "before claim" ? "user" : "super_admin");
    const organization = await addPlatformOrganization(f, true);
    const proof = phase === "before completion" ? await claimProof(f) : null;
    if (proof) await updateUser(f, { role: "user" });
    expect(await f.t.run(ctx => ctx.db.get(organization.membershipId))).toMatchObject({ role: "reviewer", status: "active" });
    const before = await state(f.t);
    const attempt = proof
      ? f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })
      : f.t.mutation(claimRef, f.request);
    await expect(attempt).rejects.toThrow("GEMINI_RECOVERY_PUBLISHER_UNAUTHORIZED");
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["before claim", "before completion"])("keeps an organization-bound super administrator job scoped to its organization %s", async phase => {
    const f = await fixture();
    await addOrganization(f);
    const proof = phase === "before completion" ? await claimProof(f) : null;
    await f.t.run(async ctx => {
      const now = Date.now();
      const foreignOrganizationId = await ctx.db.insert("organizations", {
        name: "Other organization", slug: "other-org", class: "company", status: "active",
        createdBy: f.userId, updatedBy: f.userId, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("organizationMemberships", {
        organizationId: foreignOrganizationId, userId: f.userId, role: "reviewer", status: "active", createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(f.jurisdictionId, { organizationId: foreignOrganizationId });
    });
    const before = await state(f.t);
    const attempt = proof
      ? f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })
      : f.t.mutation(claimRef, f.request);
    await expect(attempt).rejects.toThrow("ORGANIZATION_ACCESS_DENIED");
    expect(await state(f.t)).toEqual(before);
  });

  it.each([
    ["membership removed", "user"], ["review role removed", "user"], ["organization archived", "user"],
    ["organization binding changed", "user"], ["membership removed", "super_admin"],
  ])("rechecks organization authority before completion: %s for %s", async (scenario, role) => {
      const f = await fixture(role);
      const org = await addOrganization(f);
      const proof = await claimProof(f);
      await f.t.run(async ctx => {
        if (scenario === "membership removed") await ctx.db.delete(org.membershipId);
        if (scenario === "review role removed") await ctx.db.patch(org.membershipId, { role: "member" });
        if (scenario === "organization archived") await ctx.db.patch(org.organizationId, { status: "archived" });
        if (scenario === "organization binding changed") await ctx.db.patch(f.jurisdictionId, { organizationId: undefined });
      });
      const before = await state(f.t);
      await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    });

  it.each(["unverified email", "two factor disabled", "banned actor", "withdrawn role", "deployment gate"])(
    "rechecks current authority immediately before completion: %s", async scenario => {
      const f = await fixture();
      const proof = await claimProof(f);
      if (scenario === "unverified email") await updateUser(f, { emailVerified: false });
      if (scenario === "two factor disabled") await updateUser(f, { twoFactorEnabled: false });
      if (scenario === "banned actor") await updateUser(f, { banned: true });
      if (scenario === "withdrawn role") await updateUser(f, { role: "user" });
      if (scenario === "deployment gate") vi.stubEnv("ADMIN_PANEL_ENABLED", "false");
      const before = await state(f.t);
      await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it.each(["provider operation", "valid payload", "version number", "checksum and payload", "actor roles", "lock binding", "original storage", "lock extension"])(
    "rejects changed evidence identity after claiming: %s", async scenario => {
      const f = await fixture();
      const proof = await claimProof(f);
      await f.t.run(async ctx => {
        if (scenario === "provider operation") await ctx.db.patch(f.jobId, { providerOperationName: `${storeName}/upload/operations/different` });
        if (scenario === "valid payload") await ctx.db.patch(f.jobId, { payload: JSON.stringify({ operation: "publish", storeName, sha256: f.sha256, reasonDigest: "a".repeat(64) }) });
        if (scenario === "version number") await ctx.db.patch(f.versionId, { versionNumber: 2 });
        if (scenario === "checksum and payload") {
          await ctx.db.patch(f.versionId, { sha256: "b".repeat(64) });
          await ctx.db.patch(f.jobId, { payload: JSON.stringify({ operation: "publish", storeName, sha256: "b".repeat(64) }) });
        }
        if (scenario === "actor roles") await ctx.db.patch(f.jobId, { actorRoles: ["content_reviewer"] });
        if (scenario === "lock binding") await ctx.db.patch(f.lockId, { idempotencyKey: "different" });
        if (scenario === "original storage") await ctx.db.patch(f.versionId, { originalStorageId: await ctx.storage.store(new Blob(["law"], { type: "application/pdf" })) });
        if (scenario === "lock extension") {
          const lock = (await ctx.db.get(f.lockId))!;
          await ctx.db.patch(f.lockId, { expiresAt: lock.expiresAt + 60_000 });
        }
      });
      const before = await state(f.t);
      await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it.each(["resource archived", "jurisdiction archived", "version approved", "existing active version", "existing provider document", "expired lifecycle lock", "duplicate store owner", "store teardown"] as const)(
    "rechecks publication guards at commit: %s", async scenario => {
      const f = await fixture();
      const proof = await claimProof(f);
      await invalidateTarget(f, scenario);
      const before = await state(f.t);
      await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() })).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it.each(["wrong lease", "wrong binding", "expired lease", "missing permit", "expired permit", "foreign document", "malformed document"])(
    "rejects invalid completion authority: %s", async scenario => {
      const f = await fixture();
      const proof = await claimProof(f);
      if (scenario === "wrong lease") proof.leaseToken = "not-the-current-lease";
      if (scenario === "wrong binding") proof.binding = "not-the-current-binding";
      if (scenario === "expired lease") await f.t.run(ctx => ctx.db.patch(f.jobId, { leaseExpiresAt: Date.now() - 1 }));
      if (scenario === "missing permit") await f.t.run(ctx => ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: undefined }));
      if (scenario === "expired permit") await f.t.run(ctx => ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: f.jobId, leaseExpiresAt: Date.now() - 1 } }));
      const candidate = scenario === "foreign document" ? "fileSearchStores/foreign/documents/one" : scenario === "malformed document" ? "arbitrary" : documentName;
      const before = await state(f.t);
      await expect(f.t.mutation(completeRef, { ...proof, documentName: candidate, verifiedAt: Date.now() })).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it.each(["before claim", "future", "older than thirty seconds"])("rejects provider evidence %s", async scenario => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const f = await fixture();
    const proof = await claimProof(f);
    const verifiedAt = scenario === "before claim" ? now - 1 : scenario === "future" ? now + 1 : now;
    if (scenario === "older than thirty seconds") clock.mockReturnValue(now + 30_001);
    const before = await state(f.t);
    await expect(f.t.mutation(completeRef, { ...proof, documentName, verifiedAt })).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["normal", "actor banned", "lease expired", "panel disabled"])(
    "aborts safely and preserves the unpublished version when %s", async scenario => {
      const f = await fixture();
      const before = await state(f.t);
      const proof = await claimProof(f);
      if (scenario === "actor banned") await updateUser(f, { banned: true });
      if (scenario === "lease expired") {
        const job = await f.t.run(ctx => ctx.db.get(f.jobId));
        vi.spyOn(Date, "now").mockReturnValue(job!.leaseExpiresAt! + 1);
      }
      if (scenario === "panel disabled") vi.stubEnv("ADMIN_PANEL_ENABLED", "false");
      expect(await f.t.mutation(abortRef, proof)).toMatchObject({ status: "failed", jobId: f.jobId });
      const after = await state(f.t);
      expect(after.versions).toEqual(before.versions);
      expect(after.resources).toEqual(before.resources);
      expect(after.counts).toEqual(before.counts);
      expect(after.locks).toEqual(before.locks);
      expect(after.jobs[0]).toMatchObject({ status: "manual_review", providerPollCount: 526, recoveryKind: "poll_operation" });
      expect(after.jobs[0].leaseToken).toBeUndefined();
      expect(after.jurisdictions[0].providerSyncState).toBe("drifted");
      expect(after.jurisdictions[0].geminiExecutionPermit).toBeUndefined();
      expect(after.operations[0].status).toBe("failed");
      expect(after.scheduled).toHaveLength(0);
      expect(after.audits.some(row => row.action === "document.publish.success")).toBe(false);
      const once = await state(f.t);
      await f.t.mutation(abortRef, proof);
      expect(await state(f.t)).toEqual(once);
    },
  );

  it("does not clear a newer worker's lease or permit while aborting an old attempt", async () => {
    const f = await fixture();
    const proof = await claimProof(f);
    await f.t.run(async ctx => {
      const leaseExpiresAt = Date.now() + 60_000;
      await ctx.db.patch(f.jobId, { leaseToken: "new-worker", leaseExpiresAt });
      await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: f.jobId, leaseExpiresAt } });
    });
    const newer = await state(f.t);
    await f.t.mutation(abortRef, proof);
    const after = await state(f.t);
    expect(after.jobs).toEqual(newer.jobs);
    expect(after.jurisdictions).toEqual(newer.jurisdictions);
    expect(after.locks).toEqual(newer.locks);
    expect(after.versions).toEqual(newer.versions);
  });

  it("keeps the jurisdiction drifted while another provider job still needs review", async () => {
    const f = await fixture();
    const otherJobId = await f.t.run(async ctx => {
      const { _id, _creationTime, ...job } = (await ctx.db.get(f.jobId))!;
      void _id; void _creationTime;
      return await ctx.db.insert("integrationJobs", { ...job, idempotencyKey: "unresolved-other", correlationId: "job_other" });
    });
    const beforeOther = await f.t.run(ctx => ctx.db.get(otherJobId));
    const proof = await claimProof(f);
    await f.t.mutation(completeRef, { ...proof, documentName, verifiedAt: Date.now() });
    const after = await state(f.t);
    expect(after.jurisdictions[0].providerSyncState).toBe("drifted");
    expect(await f.t.run(ctx => ctx.db.get(otherJobId))).toEqual(beforeOther);
    expect(after.versions[0].status).toBe("published");
  });

  it.each(["platform jurisdiction", "organizational jurisdiction"])("runs the registered action through fresh provider GETs for a platform job in the %s, then replays without provider access", async jurisdictionKind => {
    const f = await fixture();
    if (jurisdictionKind === "organizational jurisdiction") {
      await addPlatformOrganization(f);
      expect(await f.t.run(ctx => ctx.db.query("organizationMemberships").take(1))).toEqual([]);
      expect((await f.t.run(ctx => ctx.db.get(f.jobId)))!.organizationId).toBeUndefined();
    }
    vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-recovery-key");
    const metadata = { environment: "test", jurisdiction_id: f.jurisdictionId, resource_id: f.resourceId,
      version_id: f.versionId, version_number: "1", sha256: f.sha256 };
    const document = { name: documentName, state: "STATE_ACTIVE", customMetadata: Object.entries(metadata).map(([key, stringValue]) => ({ key, stringValue })) };
    const requests: Array<{ method: string; pathname: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push({ method: init?.method ?? (input instanceof Request ? input.method : "GET"), pathname });
      const body = pathname.includes("/upload/operations/")
        ? { name: `${storeName}/upload/operations/retained`, done: false }
        : pathname.endsWith("/documents/exact-active") ? document : { documents: [document] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }));
    const result = await f.t.action(recoveryRef, f.request);
    expect(result).toMatchObject({ status: "succeeded", jobId: f.jobId });
    expect(requests.map(request => request.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(requests[0].pathname).toContain("/upload/operations/retained");
    expect(requests[1].pathname).toMatch(/\/documents$/);
    expect(requests[2].pathname).toMatch(/\/documents\/exact-active$/);
    expect(requests[3].pathname).toContain("/upload/operations/retained");
    expect(JSON.stringify(result)).not.toMatch(/server-only-recovery-key|leaseToken|binding|fileSearchStores/);
    const after = await state(f.t);
    expect(after.versions[0].status).toBe("published");
    expect(after.scheduled).toHaveLength(0);
    expect(await f.t.action(recoveryRef, f.request)).toEqual(result);
    expect(requests).toHaveLength(4);
    expect(await state(f.t)).toEqual(after);
  });

  it.each(["provider error", "document no longer active", "actor loses permission", "original deleted"])(
    "the registered action releases only its attempt after %s", async scenario => {
      const f = await fixture();
      vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-recovery-key");
      const before = await state(f.t);
      const metadata = { environment: "test", jurisdiction_id: f.jurisdictionId, resource_id: f.resourceId,
        version_id: f.versionId, version_number: "1", sha256: f.sha256 };
      const document = { name: documentName, state: "STATE_ACTIVE", customMetadata: Object.entries(metadata).map(([key, stringValue]) => ({ key, stringValue })) };
      const methods: string[] = [];
      let operationReads = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        methods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
        let body: unknown;
        if (pathname.includes("/upload/operations/")) {
          operationReads += 1;
          if (operationReads === 2 && scenario === "actor loses permission") await updateUser(f, { role: "user" });
          if (operationReads === 2 && scenario === "original deleted") await f.t.run(async ctx => {
            const version = (await ctx.db.get(f.versionId))!;
            await ctx.storage.delete(version.originalStorageId);
          });
          body = { name: `${storeName}/upload/operations/retained`, done: false };
        } else if (pathname.endsWith("/documents/exact-active")) {
          if (scenario === "provider error") return new Response(JSON.stringify({ error: { code: 403, message: "private fixture details server-only-recovery-key" } }), { status: 403 });
          body = { ...document, state: scenario === "document no longer active" ? "STATE_PENDING" : "STATE_ACTIVE" };
        } else body = { documents: [document] };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }));
      const result = await f.t.action(recoveryRef, f.request);
      expect(result).toMatchObject({ status: "failed", jobId: f.jobId });
      expect(methods.every(method => method === "GET")).toBe(true);
      expect(methods.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(result)).not.toMatch(/private fixture|server-only-recovery-key|leaseToken|binding|fileSearchStores/);
      const after = await state(f.t);
      expect(after.versions).toEqual(before.versions);
      expect(after.resources).toEqual(before.resources);
      expect(after.locks).toEqual(before.locks);
      expect(after.counts).toEqual(before.counts);
      expect(after.jobs).toHaveLength(1);
      expect(after.jobs[0].status).toBe("manual_review");
      expect(after.jobs[0].leaseToken).toBeUndefined();
      expect(after.jurisdictions[0].providerSyncState).toBe("drifted");
      expect(after.jurisdictions[0].geminiExecutionPermit).toBeUndefined();
      expect(after.operations[0].status).toBe("failed");
      expect(after.scheduled).toHaveLength(0);
      expect(after.audits).toHaveLength(1);
      expect(after.audits[0].action).toBe("document.publish.reconciliation_failed");
      expect(after.audits[0].metadata).toMatchObject({ method: "active_document_reconciliation" });
      expect(after.audits[0].metadata.evidence).toBeUndefined();
    },
  );
});
