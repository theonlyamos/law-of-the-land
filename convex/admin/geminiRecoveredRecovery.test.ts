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
const claimRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:claimRecoveredDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:completeRecoveredDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:abortRecoveredDocumentRecovery");
const activeClaimRef = makeFunctionReference<"mutation">("admin/geminiRecovery:claimActiveDocumentRecovery");
const storeName = "fileSearchStores/recovered-fixture";
const operationName = `${storeName}/upload/operations/retained`;
const documentName = `${storeName}/documents/once-failed`;
const reason = "Gemini made the once-failed first publication active; finish the retained job";

async function hashReference(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function fixture() {
  vi.stubEnv("ADMIN_PANEL_ENABLED", "true");
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  const documentReference = await hashReference(documentName);
  const operationReference = await hashReference(operationName);
  const ids = await t.run(async ctx => {
    const now = Date.now();
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: now });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Recovery reviewer", email: "recovered@example.invalid", emailVerified: true,
      role: "super_admin", banned: false, twoFactorEnabled: true, createdAt: now, updatedAt: now,
    } } });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "Recovered jurisdiction", slug: "recovered", status: "enabled", isDefault: false,
      geminiFileSearchStoreName: storeName, providerSyncState: "drifted",
      createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: "Recovered act", issuer: "Fixture", officialCitation: "Recovered 1",
      officialCitationKey: "recovered-1", sourceUrl: "https://example.invalid/law", topics: [], status: "active",
      createdBy: user._id, updatedBy: user._id, createdAt: now, updatedAt: now,
    });
    const originalStorageId = await ctx.storage.store(new Blob(["law"], { type: "application/pdf" }));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("law"));
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const versionId = await insertDocumentVersion(ctx, {
      resourceId, versionNumber: 1, originalStorageId, filename: "law.pdf", mimeType: "application/pdf",
      byteSize: 3, sha256, sourceUrl: "https://example.invalid/law", status: "publishing",
      submittedBy: user._id, failureSummary: "Gemini reports STATE_FAILED", createdAt: now, updatedAt: now,
    });
    const jobId = await ctx.db.insert("integrationJobs", {
      type: "gemini_index_document", targetType: "documentVersion", targetId: versionId,
      payload: JSON.stringify({ operation: "publish", storeName, sha256 }), actorId: user._id,
      actorRoles: ["super_admin"], idempotencyKey: "original-publish", requestFingerprint: "original",
      correlationId: "job_original", status: "manual_review", attemptCount: 1,
      providerOperationName: operationName, recoveryKind: "poll_operation",
      providerPollCount: 12, providerPollingStartedAt: now - 60 * 60_000, lastErrorKind: "provider",
      failedDocumentEvidence: { documentReference, operationReference, firstObservedAt: now - 40 * 60_000,
        confirmedAt: now - 30 * 60_000, priorProviderPollCount: 11, observedOperationDone: false,
        observedDocumentState: "STATE_FAILED" },
      createdAt: now - 60 * 60_000, updatedAt: now,
    });
    await ctx.db.insert("documentLifecycleLocks", {
      jurisdictionId, resourceId, versionId, operation: "publish", actorId: user._id,
      idempotencyKey: "original-publish", jobId, expiresAt: now + 60 * 60_000, createdAt: now, updatedAt: now,
    });
    return { userId: user._id, jurisdictionId, resourceId, versionId, jobId };
  });
  return { t, ...ids, documentReference, request: { jobId: ids.jobId, reason, idempotencyKey: "recovered-once" } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function state(t: Backend) {
  return await t.run(async ctx => ({
    jobs: await ctx.db.query("integrationJobs").take(10),
    versions: await ctx.db.query("documentVersions").take(10),
    resources: await ctx.db.query("legalResources").take(10),
    jurisdictions: await ctx.db.query("jurisdictions").take(10),
    locks: await ctx.db.query("documentLifecycleLocks").take(10),
    operations: await ctx.db.query("adminOperations").take(10),
    audits: await ctx.db.query("auditEvents").take(10),
    scheduled: await ctx.db.system.query("_scheduled_functions").take(10),
  }));
}

async function claimAttempt(f: Fixture) {
  const claim = await f.t.mutation(claimRef, f.request);
  expect(claim.kind).toBe("claimed");
  return claim;
}

function attemptOf(claim: Awaited<ReturnType<typeof claimAttempt>>) {
  return { operationId: claim.operationId, leaseToken: claim.leaseToken, binding: claim.binding, jurisdictionId: claim.jurisdictionId };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("recovered Gemini document recovery mutations", () => {
  it("exposes all recovery mutations only as internal functions", async () => {
    const recovery = await import("./geminiRecoveredRecovery");
    expect(recovery.claimRecoveredDocumentRecovery).toHaveProperty("isInternal", true);
    expect(recovery.completeRecoveredDocumentRecovery).toHaveProperty("isInternal", true);
    expect(recovery.abortRecoveredDocumentRecovery).toHaveProperty("isInternal", true);
  });

  it("publishes the version, clears the failure tombstone and restores sync", async () => {
    const f = await fixture();
    const claim = await claimAttempt(f);
    expect(claim.failedDocumentReference).toBe(f.documentReference);
    expect(claim.target).toMatchObject({ storeName, operationName,
      metadata: { environment: "test", jurisdiction_id: f.jurisdictionId, resource_id: f.resourceId, version_id: f.versionId } });
    expect(await f.t.mutation(completeRef, { ...attemptOf(claim), documentName, verifiedAt: Date.now() }))
      .toMatchObject({ status: "succeeded", jobId: f.jobId });
    const after = await state(f.t);
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0].status).toBe("succeeded");
    expect(after.jobs[0].failedDocumentEvidence).toBeUndefined();
    expect(after.jobs[0].leaseToken).toBeUndefined();
    expect(after.versions[0]).toMatchObject({ status: "published", geminiDocumentName: documentName });
    expect(after.versions[0].failureSummary).toBeUndefined();
    expect(after.resources[0]).toMatchObject({ activeVersionId: f.versionId, catalogPublished: true });
    expect(after.resources[0].geminiPublicationBlock).toBeUndefined();
    expect(after.jurisdictions[0]).toMatchObject({ providerSyncState: "synced" });
    expect(after.jurisdictions[0].geminiExecutionPermit).toBeUndefined();
    expect(after.jurisdictions[0].geminiSearchRestriction).toBeUndefined();
    expect(after.locks).toHaveLength(0);
    expect(after.scheduled).toHaveLength(0);
    expect(after.operations[0]).toMatchObject({ status: "succeeded", action: "gemini_recovered_document_recovery" });
    expect(after.audits.find(row => row.action === "document.publish.recovered_document_reconciled")).toMatchObject({
      actorType: "system", actorId: "gemini_recovery", reason, targetId: f.jobId, outcome: "success",
    });
  });

  it("rejects a document other than the one confirmed failed, leaving the job untouched", async () => {
    const f = await fixture();
    const claim = await claimAttempt(f);
    const claimed = await state(f.t);
    await expect(f.t.mutation(completeRef, { ...attemptOf(claim), documentName: `${storeName}/documents/other`, verifiedAt: Date.now() }))
      .rejects.toThrow();
    expect(await state(f.t)).toEqual(claimed);
    expect(await f.t.mutation(abortRef, attemptOf(claim))).toMatchObject({ status: "failed" });
    const after = await state(f.t);
    expect(after.jobs[0]).toMatchObject({ status: "manual_review", failedDocumentEvidence: { documentReference: f.documentReference } });
    expect(after.jobs[0].leaseToken).toBeUndefined();
    expect(after.versions[0].status).toBe("publishing");
    expect(after.jurisdictions[0].geminiExecutionPermit).toBeUndefined();
    expect(after.locks).toHaveLength(1);
  });

  it("rejects stale proof", async () => {
    const f = await fixture();
    const claim = await claimAttempt(f);
    const claimed = await state(f.t);
    await expect(f.t.mutation(completeRef, { ...attemptOf(claim), documentName, verifiedAt: Date.now() - 60_000 })).rejects.toThrow();
    expect(await state(f.t)).toEqual(claimed);
  });

  it("replays a completed request and rejects changed intent", async () => {
    const f = await fixture();
    const claim = await claimAttempt(f);
    const completion = { ...attemptOf(claim), documentName, verifiedAt: Date.now() };
    const result = await f.t.mutation(completeRef, completion);
    const before = await state(f.t);
    expect(await f.t.mutation(claimRef, f.request)).toEqual({ kind: "completed", result });
    expect(await f.t.mutation(completeRef, completion)).toEqual(result);
    await expect(f.t.mutation(claimRef, { ...f.request, reason: "A different recovery request" })).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["no evidence", "coverage already verified", "evidence for another operation", "malformed reference", "queued job", "already published"] as const)(
    "rejects %s before acquiring a lease", async scenario => {
      const f = await fixture();
      await f.t.run(async ctx => {
        const job = (await ctx.db.get(f.jobId))!;
        const evidence = job.failedDocumentEvidence!;
        if (scenario === "no evidence") await ctx.db.patch(f.jobId, { failedDocumentEvidence: undefined });
        if (scenario === "coverage already verified") await ctx.db.patch(f.jobId, { failedDocumentEvidence: { ...evidence, coverageVerifiedAt: Date.now(), publishedCount: 3 } });
        if (scenario === "evidence for another operation") await ctx.db.patch(f.jobId, { failedDocumentEvidence: { ...evidence, operationReference: await hashReference(`${storeName}/upload/operations/other`) } });
        if (scenario === "malformed reference") await ctx.db.patch(f.jobId, { failedDocumentEvidence: { ...evidence, documentReference: "unhashed" } });
        if (scenario === "queued job") await ctx.db.patch(f.jobId, { status: "queued" });
        if (scenario === "already published") {
          await ctx.db.patch(f.resourceId, { activeVersionId: f.versionId, catalogPublished: true });
        }
      });
      const before = await state(f.t);
      await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
      expect(await state(f.t)).toEqual(before);
    },
  );

  it("leaves the active-document recovery unable to claim a job with failed evidence", async () => {
    const f = await fixture();
    const before = await state(f.t);
    await expect(f.t.mutation(activeClaimRef, { ...f.request, idempotencyKey: "active-attempt" })).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it("preserves another job's execution permit", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const { _id, _creationTime, ...job } = (await ctx.db.get(f.jobId))!;
      void _id; void _creationTime;
      const leaseExpiresAt = Date.now() + 60_000;
      const competingId = await ctx.db.insert("integrationJobs", { ...job, failedDocumentEvidence: undefined, status: "running",
        leaseToken: "competing-worker", leaseExpiresAt, idempotencyKey: "competing-job", correlationId: "job_competing" });
      await ctx.db.patch(f.jurisdictionId, { geminiExecutionPermit: { jobId: competingId, leaseExpiresAt } });
    });
    const before = await state(f.t);
    await expect(f.t.mutation(claimRef, f.request)).rejects.toThrow();
    expect(await state(f.t)).toEqual(before);
  });

  it("rejects completion when the publisher lost authority after the claim", async () => {
    const f = await fixture();
    const claim = await claimAttempt(f);
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: { model: "user", where: [{ field: "_id", value: f.userId }], update: { banned: true } },
    }));
    const claimed = await state(f.t);
    await expect(f.t.mutation(completeRef, { ...attemptOf(claim), documentName, verifiedAt: Date.now() })).rejects.toThrow();
    expect(await state(f.t)).toEqual(claimed);
  });
});
