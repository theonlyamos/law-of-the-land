/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
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

const submitForReview = makeFunctionReference<"mutation">("admin/reviews:submitForReview");
const approveVersion = makeFunctionReference<"mutation">("admin/reviews:approveVersion");
const rejectVersion = makeFunctionReference<"mutation">("admin/reviews:rejectVersion");
const publishVersion = makeFunctionReference<"mutation">("admin/publication:publishVersion");
const unpublishVersion = makeFunctionReference<"mutation">("admin/publication:unpublishVersion");
const rollbackVersion = makeFunctionReference<"mutation">("admin/publication:rollbackVersion");
const claimJob = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const applyProviderResult = makeFunctionReference<"mutation">("admin/jobs:applyProviderResult");
const recordProviderFailure = makeFunctionReference<"mutation">("admin/jobs:recordProviderFailure");
const completeGroundxCallback = makeFunctionReference<"mutation">("admin/jobs:completeGroundxCallback");
const recordAdminStepUpProof = makeFunctionReference<"mutation">("admin/users:recordAdminStepUpProof");
const listReviewQueue = makeFunctionReference<"query">("admin/reviews:listReviewQueue");
const expireLifecycleLock = makeFunctionReference<"mutation">("admin/publication:expireLifecycleLock");

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

async function seedCatalog(
  t: Backend,
  submitterId: string,
  statuses: Array<"draft" | "ready_for_review" | "approved" | "published" | "superseded">,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      code: "GH",
      name: "Ghana",
      slug: `ghana-${crypto.randomUUID()}`,
      status: "enabled",
      isDefault: true,
      stagingBucketId: "101",
      productionBucketId: "202",
      providerSyncState: "synced",
      createdBy: submitterId,
      updatedBy: submitterId,
      createdAt: now,
      updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "act",
      title: "Data Protection Act",
      issuer: "Parliament",
      officialCitation: "Act 843",
      officialCitationKey: "act 843",
      sourceUrl: "https://laws.example.gov/act-843",
      topics: ["privacy"],
      effectiveDate: "2012-10-16",
      status: "active",
      createdBy: submitterId,
      updatedBy: submitterId,
      createdAt: now,
      updatedAt: now,
    });
    const ids: Id<"documentVersions">[] = [];
    for (let index = 0; index < statuses.length; index += 1) {
      const storageId = await ctx.storage.store(new Blob([`version-${index + 1}`], { type: "application/pdf" }));
      const status = statuses[index];
      const id = await ctx.db.insert("documentVersions", {
        resourceId,
        versionNumber: index + 1,
        originalStorageId: storageId,
        filename: `act-843-v${index + 1}.pdf`,
        mimeType: "application/pdf",
        byteSize: 9,
        sha256: `${index + 1}`.repeat(64),
        sourceUrl: "https://laws.example.gov/act-843",
        effectiveDate: "2012-10-16",
        status,
        groundxStagingDocumentId: `staging-doc-${index + 1}`,
        ...(status === "published" || status === "superseded"
          ? { groundxProductionDocumentId: `production-doc-${index + 1}`, publishedAt: now }
          : {}),
        submittedBy: submitterId,
        submittedAt: status === "draft" ? undefined : now,
        reviewedBy: ["approved", "published", "superseded"].includes(status) ? "prior-reviewer" : undefined,
        reviewedAt: ["approved", "published", "superseded"].includes(status) ? now : undefined,
        createdAt: now + index,
        updatedAt: now + index,
      });
      ids.push(id);
    }
    const activeIndex = statuses.findIndex((status) => status === "published");
    if (activeIndex >= 0) await ctx.db.patch(resourceId, { activeVersionId: ids[activeIndex] });
    return { jurisdictionId, resourceId, ids };
  });
}

async function addStepUp(
  t: Backend,
  actor: { userId: string; sessionId: string },
  action: string,
  targetId: string,
  idempotencyKey: string,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("adminStepUpProofs", {
      actorId: actor.userId,
      sessionId: actor.sessionId,
      action,
      targetId,
      idempotencyKey,
      issuedAt: now,
      expiresAt: now + 300_000,
    });
  });
}

const checklist = {
  sourceAuthentic: true,
  metadataAccurate: true,
  extractionReviewed: true,
  citationsVerified: true,
  evaluationPassed: true,
};

const originalEnabled = process.env.ADMIN_PANEL_ENABLED;
const originalEnvironment = process.env.ADMIN_ENVIRONMENT;
afterEach(() => {
  if (originalEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = originalEnabled;
  if (originalEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = originalEnvironment;
});

describe("governed document publication", () => {
  it("enforces ordered submission and reviewer separation with immutable evidence", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager,content_reviewer");
    const reviewer = await asAdmin(t, "content_reviewer");
    const catalog = await seedCatalog(t, manager.userId, ["draft"]);
    const versionId = catalog.ids[0];

    await manager.client.mutation(submitForReview, {
      versionId,
      reason: "Ready for independent legal review",
      idempotencyKey: "submit-version-1",
    });
    await expect(
      manager.client.mutation(approveVersion, {
        versionId,
        checklistAnswers: checklist,
        evaluationRunId: "evaluation-2026-01",
        reason: "Independent review complete",
        idempotencyKey: "approve-version-1",
      }),
    ).rejects.toThrow("different reviewer");

    const approved = await reviewer.client.mutation(approveVersion, {
      versionId,
      checklistAnswers: checklist,
      evaluationRunId: "evaluation-2026-01",
      reason: "Independent review complete",
      idempotencyKey: "approve-version-1",
    });
    const replay = await reviewer.client.mutation(approveVersion, {
      versionId,
      checklistAnswers: checklist,
      evaluationRunId: "evaluation-2026-01",
      reason: "Independent review complete",
      idempotencyKey: "approve-version-1",
    });
    expect(replay).toEqual(approved);
    await expect(
      reviewer.client.mutation(approveVersion, {
        versionId,
        checklistAnswers: checklist,
        evaluationRunId: "evaluation-other",
        reason: "Independent review complete",
        idempotencyKey: "approve-version-1",
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    const snapshot = await t.run(async (ctx) => ({
      version: await ctx.db.get(versionId),
      decisions: await ctx.db.query("reviewDecisions").take(3),
      audits: await ctx.db.query("auditEvents").take(20),
    }));
    expect(snapshot.version?.status).toBe("approved");
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.decisions[0]).toMatchObject({
      reviewerId: reviewer.userId,
      decision: "approve",
      checklistAnswers: checklist,
      evaluationRunId: "evaluation-2026-01",
      reason: "Independent review complete",
    });
    expect(snapshot.decisions[0].correlationId).toMatch(/^op_/);
    expect(JSON.stringify(snapshot.audits)).not.toContain("https://");
    const docket = await reviewer.client.query(listReviewQueue, {
      status: "approved",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(docket.page[0]).toMatchObject({
      id: versionId,
      resourceTitle: "Data Protection Act",
      officialCitation: "Act 843",
      sourceHost: "laws.example.gov",
      status: "approved",
      sha256: "1".repeat(64),
      xrayEvidence: { status: "unavailable" },
    });
    expect(JSON.stringify(docket.page[0])).not.toContain("https://");
    expect(JSON.stringify(docket.page[0])).not.toContain("xrayUrl");
    expect(JSON.stringify(docket.page[0])).not.toContain("extractedBody");
  });

  it("lists the newest actionable review version on the first bounded page", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const statuses = Array.from({ length: 13 }, () => "published" as const);
    const { ids } = await seedCatalog(t, "manager-1", statuses);

    const firstPage = await reviewer.client.query(listReviewQueue, {
      status: "published",
      paginationOpts: { numItems: 12, cursor: null },
    });

    expect(firstPage.page).toHaveLength(12);
    expect(firstPage.page[0].id).toBe(ids[12]);
    expect(firstPage.page.map((row: { id: Id<"documentVersions"> }) => row.id)).not.toContain(ids[0]);

    const secondPage = await reviewer.client.query(listReviewQueue, {
      status: "published",
      paginationOpts: { numItems: 12, cursor: firstPage.continueCursor },
    });
    expect(secondPage.page.map((row: { id: Id<"documentVersions"> }) => row.id)).toEqual([ids[0]]);
    expect(secondPage.isDone).toBe(true);
  });

  it("bounds checklist/evaluation fields and permits a reasoned rejection only from review", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const reviewer = await asAdmin(t, "content_reviewer");
    const { ids } = await seedCatalog(t, manager.userId, ["ready_for_review"]);
    await expect(reviewer.client.mutation(approveVersion, {
      versionId: ids[0],
      checklistAnswers: { ...checklist, citationsVerified: false },
      evaluationRunId: "evaluation-2026-02",
      reason: "Review attempted with incomplete checks",
      idempotencyKey: "approve-incomplete-1",
    })).rejects.toThrow("CHECKLIST_INCOMPLETE");
    await expect(reviewer.client.mutation(rejectVersion, {
      versionId: ids[0],
      checklistAnswers: checklist,
      evaluationRunId: "x".repeat(129),
      reason: "Extraction does not match the official original",
      idempotencyKey: "reject-invalid-evaluation",
    })).rejects.toThrow("EVALUATION_INVALID");
    await reviewer.client.mutation(rejectVersion, {
      versionId: ids[0],
      checklistAnswers: { ...checklist, extractionReviewed: false },
      evaluationRunId: "evaluation-2026-03",
      reason: "Extraction does not match the official original",
      idempotencyKey: "reject-version-1",
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(ids[0]))?.status)).toBe("rejected");
    await expect(reviewer.client.mutation(rejectVersion, {
      versionId: ids[0], checklistAnswers: checklist, evaluationRunId: "evaluation-2026-03",
      reason: "Extraction does not match the official original", idempotencyKey: "reject-version-2",
    })).rejects.toThrow("TRANSITION_INVALID");
  });

  it("publishes through exactly one copy job and activates only on provider completion", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "approved"]);
    const previousId = ids[0];
    const candidateId = ids[1];
    const key = "publish-version-2";
    await addStepUp(t, reviewer, "document_publish", candidateId, key);
    const publicationRequest = {
      versionId: candidateId,
      confirmation: `PUBLISH ${candidateId}`,
      reason: "Promote the independently approved version",
      idempotencyKey: key,
    };
    const queued = await reviewer.client.mutation(publishVersion, publicationRequest);
    expect(queued).toMatchObject({ type: "groundx_copy", duplicate: false });
    const before = await t.run(async (ctx) => ({
      resource: await ctx.db.get(resourceId),
      candidate: await ctx.db.get(candidateId),
      jobs: await ctx.db.query("integrationJobs").take(5),
    }));
    expect(before.resource?.activeVersionId).toBe(previousId);
    expect(before.candidate?.status).toBe("publishing");
    expect(before.jobs).toHaveLength(1);
    expect(before.jobs[0].type).toBe("copy_documents");
    expect(JSON.parse(before.jobs[0].payload)).toMatchObject({
      documentIds: ["staging-doc-2"], fromBucket: 101, operation: "publish",
      previousVersionId: previousId, reasonDigest: expect.stringMatching(/^[a-f0-9]{64}$/), toBucket: 202,
    });
    expect(before.jobs[0].payload).not.toContain("Promote the independently approved version");

    await expect(reviewer.client.mutation(publishVersion, {
      versionId: candidateId,
      confirmation: `PUBLISH ${candidateId}`,
      reason: "A different request must conflict",
      idempotencyKey: key,
    })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const replay = await reviewer.client.mutation(publishVersion, {
      versionId: candidateId,
      confirmation: `PUBLISH ${candidateId}`,
      reason: "Promote the independently approved version",
      idempotencyKey: key,
    });
    expect(replay).toMatchObject({ jobId: queued.jobId, duplicate: true });

    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected job claim");
    await t.mutation(applyProviderResult, {
      jobId: queued.jobId,
      leaseToken: claim.leaseToken,
      processId: "copy-process-2",
      status: "complete",
      documentEvidence: { documentId: "production-copy-2", bucketId: 202, status: "complete" },
    });
    const after = await t.run(async (ctx) => ({
      resource: await ctx.db.get(resourceId),
      previous: await ctx.db.get(previousId),
      candidate: await ctx.db.get(candidateId),
    }));
    expect(after.resource?.activeVersionId).toBe(candidateId);
    expect(after.previous?.status).toBe("superseded");
    expect(after.candidate?.status).toBe("published");
    await expect(t.mutation(completeGroundxCallback, {
      tokenHash: before.jobs[0].callbackTokenHash,
      processId: "copy-process-2",
      status: "complete",
      documentEvidence: { documentId: "production-copy-2", bucketId: 202, status: "complete" },
    })).resolves.toEqual({ accepted: true, duplicate: true });
    expect(await t.run(async (ctx) => (await ctx.db.get(resourceId))?.activeVersionId)).toBe(candidateId);
    await expect(reviewer.client.mutation(publishVersion, publicationRequest)).resolves.toMatchObject({
      jobId: queued.jobId,
      duplicate: true,
    });
  });

  it("preserves the prior active version on copy failure", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "approved"]);
    await addStepUp(t, reviewer, "document_publish", ids[1], "publish-failure-1");
    const queued = await reviewer.client.mutation(publishVersion, {
      versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`,
      reason: "Promote approved version", idempotencyKey: "publish-failure-1",
    });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected job claim");
    await t.mutation(recordProviderFailure, {
      jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "validation",
    });
    const state = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), candidate: await ctx.db.get(ids[1]) }));
    expect(state.resource?.activeVersionId).toBe(ids[0]);
    expect(state.candidate?.status).toBe("approved");
  });

  it("keeps pointers consistent across callback-driven unpublish and rollback", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["superseded", "published"]);
    await addStepUp(t, reviewer, "document_rollback", ids[0], "rollback-version-1");
    const rollback = await reviewer.client.mutation(rollbackVersion, {
      versionId: ids[0], confirmation: `ROLLBACK ${ids[0]}`,
      reason: "Restore the last verified legal text", idempotencyKey: "rollback-version-1",
    });
    const rollbackClaim = await t.mutation(claimJob, { jobId: rollback.jobId });
    if (!rollbackClaim) throw new Error("expected rollback claim");
    await t.mutation(applyProviderResult, {
      jobId: rollback.jobId, leaseToken: rollbackClaim.leaseToken,
      processId: "rollback-process", status: "complete",
      documentEvidence: { documentId: "production-rollback", bucketId: 202, status: "complete" },
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(resourceId))?.activeVersionId)).toBe(ids[0]);

    await addStepUp(t, reviewer, "document_unpublish", ids[0], "unpublish-version-1");
    const unpublish = await reviewer.client.mutation(unpublishVersion, {
      versionId: ids[0], confirmation: `UNPUBLISH ${ids[0]}`,
      reason: "Withdraw the production index pending correction", idempotencyKey: "unpublish-version-1",
    });
    const unpublishClaim = await t.mutation(claimJob, { jobId: unpublish.jobId });
    if (!unpublishClaim) throw new Error("expected unpublish claim");
    await t.mutation(applyProviderResult, {
      jobId: unpublish.jobId, leaseToken: unpublishClaim.leaseToken,
      processId: "delete-process", status: "complete",
    });
    const finalState = await t.run(async (ctx) => ({
      resource: await ctx.db.get(resourceId),
      version: await ctx.db.get(ids[0]),
      locks: await ctx.db.query("documentLifecycleLocks").take(2),
    }));
    expect(finalState.resource?.activeVersionId).toBeUndefined();
    expect(finalState.version?.status).toBe("unpublished");
    expect(finalState.locks).toHaveLength(0);
  });

  it("rechecks feature, permission, and impersonation authority without accepting actor spoofing", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const auditor = await asAdmin(t, "auditor");
    const { ids } = await seedCatalog(t, "manager-1", ["approved"]);
    const request = {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`,
      reason: "Promote approved legal text", idempotencyKey: "authority-publish-1",
    };
    await addStepUp(t, auditor, "document_publish", ids[0], request.idempotencyKey);
    await expect(auditor.client.mutation(publishVersion, request)).rejects.toThrow("ADMIN_FORBIDDEN");

    await addStepUp(t, reviewer, "document_publish", ids[0], request.idempotencyKey);
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "session",
          where: [{ field: "_id", operator: "eq", value: reviewer.sessionId }],
          update: { impersonatedBy: "original-admin" },
        },
      });
    });
    await expect(reviewer.client.mutation(publishVersion, request)).rejects.toThrow("Impersonated sessions");
    const freshReviewer = await asAdmin(t, "content_reviewer");
    await addStepUp(t, freshReviewer, "document_publish", ids[0], request.idempotencyKey);
    await t.run(async (ctx) => {
      const flag = await ctx.db.query("featureFlags").withIndex("by_key_and_environment", (q) => q.eq("key", "admin_panel").eq("environment", "test")).unique();
      if (flag) await ctx.db.patch(flag._id, { enabled: false, updatedAt: Date.now() });
    });
    await expect(freshReviewer.client.mutation(publishVersion, request)).rejects.toThrow("ADMIN_DISABLED");
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(3))).toHaveLength(0);
  });

  it("records publication step-up proofs only for an authoritative eligible session", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const auditor = await asAdmin(t, "auditor");
    const { ids } = await seedCatalog(t, "manager-1", ["approved"]);
    await expect(t.mutation(recordAdminStepUpProof, {
      actorId: auditor.userId, sessionId: auditor.sessionId, action: "document_publish",
      targetId: ids[0], idempotencyKey: "proof-publish-1",
    })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
    await expect(t.mutation(recordAdminStepUpProof, {
      actorId: reviewer.userId, sessionId: reviewer.sessionId, action: "document_publish",
      targetId: ids[0], idempotencyKey: "proof-publish-1",
    })).resolves.toBeNull();
    const proofs = await t.run(async (ctx) => ctx.db.query("adminStepUpProofs").take(3));
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ actorId: reviewer.userId, action: "document_publish", targetId: ids[0] });
  });

  it("collapses concurrent identical publication requests to one provider job", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { ids } = await seedCatalog(t, "manager-1", ["approved"]);
    const key = "concurrent-publish-1";
    await addStepUp(t, reviewer, "document_publish", ids[0], key);
    const request = {
      versionId: ids[0], confirmation: `PUBLISH ${ids[0]}`,
      reason: "Promote one approved legal version", idempotencyKey: key,
    };
    const results = await Promise.all([
      reviewer.client.mutation(publishVersion, request),
      reviewer.client.mutation(publishVersion, request),
    ]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(results[0].jobId).toBe(results[1].jobId);
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(3))).toHaveLength(1);
  });

  it("serializes competing lifecycle commands across versions, actors, and keys", async () => {
    const t = createBackend();
    await enablePanel(t);
    const firstReviewer = await asAdmin(t, "content_reviewer");
    const secondReviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "superseded", "approved"]);
    await addStepUp(t, firstReviewer, "document_publish", ids[2], "resource-publish-1");
    await addStepUp(t, secondReviewer, "document_rollback", ids[1], "resource-rollback-1");
    const publishRequest = {
      versionId: ids[2], confirmation: `PUBLISH ${ids[2]}`,
      reason: "Promote the newly approved version", idempotencyKey: "resource-publish-1",
    };
    const rollbackRequest = {
      versionId: ids[1], confirmation: `ROLLBACK ${ids[1]}`,
      reason: "Restore the prior verified version", idempotencyKey: "resource-rollback-1",
    };
    const settled = await Promise.allSettled([
      firstReviewer.client.mutation(publishVersion, publishRequest),
      secondReviewer.client.mutation(rollbackVersion, rollbackRequest),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(String((settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("DOCUMENT_LIFECYCLE_BUSY");
    const state = await t.run(async (ctx) => ({
      resource: await ctx.db.get(resourceId),
      jobs: await ctx.db.query("integrationJobs").take(5),
    }));
    expect(state.jobs).toHaveLength(1);
    expect(state.resource?.activeVersionId).toBe(ids[0]);

    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const winner = (settled[winnerIndex] as PromiseFulfilledResult<{ jobId: Id<"integrationJobs"> }>).value;
    const winnerJob = await t.run(async (ctx) => {
      const job = await ctx.db.get(winner.jobId);
      if (!job) throw new Error("expected winning job");
      await ctx.db.patch(job._id, { status: "waiting_callback", processId: "resource-winner", nextAttemptAt: Date.now() + 60_000 });
      return job;
    });
    await t.mutation(completeGroundxCallback, {
      tokenHash: winnerJob.callbackTokenHash,
      processId: "resource-winner",
      status: "complete",
      documentEvidence: { documentId: "production-winner", bucketId: 202, status: "complete" },
    });
    const loserRetry = winnerIndex === 0
      ? await secondReviewer.client.mutation(rollbackVersion, rollbackRequest)
      : await firstReviewer.client.mutation(publishVersion, publishRequest);
    expect(loserRetry).toMatchObject({ duplicate: false, type: "groundx_copy" });
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(5))).toHaveLength(2);
  });

  it("finds the active resource lifecycle operation beyond historical job volume", async () => {
    const t = createBackend();
    await enablePanel(t);
    const publisher = await asAdmin(t, "content_reviewer");
    const rollbackReviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "superseded", "approved"]);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 30; index += 1) {
        await ctx.db.insert("integrationJobs", {
          type: "copy_documents",
          targetType: "documentVersion",
          targetId: ids[2],
          payload: JSON.stringify({ operation: "publish", documentIds: [`history-${index}`], fromBucket: 101, toBucket: 202 }),
          actorId: `historical-${index}`,
          actorRoles: ["content_reviewer"],
          idempotencyKey: `historical-key-${index}`,
          requestFingerprint: `${index}`.repeat(64).slice(0, 64),
          correlationId: `job_history_${index}`,
          callbackTokenHash: `${index % 10}`.repeat(64),
          processId: `historical-process-${index}`,
          status: "succeeded",
          attemptCount: 1,
          createdAt: now - 60_000 + index,
          updatedAt: now - 60_000 + index,
        });
      }
    });
    await addStepUp(t, publisher, "document_publish", ids[2], "history-publish-1");
    await publisher.client.mutation(publishVersion, {
      versionId: ids[2], confirmation: `PUBLISH ${ids[2]}`,
      reason: "Start the current production promotion", idempotencyKey: "history-publish-1",
    });
    await addStepUp(t, rollbackReviewer, "document_rollback", ids[1], "history-rollback-1");
    await expect(rollbackReviewer.client.mutation(rollbackVersion, {
      versionId: ids[1], confirmation: `ROLLBACK ${ids[1]}`,
      reason: "Competing rollback must wait", idempotencyKey: "history-rollback-1",
    })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");
    const jobs = await t.run(async (ctx) => ctx.db.query("integrationJobs").take(40));
    expect(jobs).toHaveLength(31);
    expect(jobs.filter((job) => ["queued", "running", "waiting_callback"].includes(job.status))).toHaveLength(1);
    expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBe(ids[0]);
  });

  it("releases a failed rollback for a safe retry while preserving the active pointer", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["superseded", "published"]);
    await addStepUp(t, reviewer, "document_rollback", ids[0], "rollback-failure-lock-1");
    const queued = await reviewer.client.mutation(rollbackVersion, {
      versionId: ids[0], confirmation: `ROLLBACK ${ids[0]}`,
      reason: "Restore the earlier verified legal text", idempotencyKey: "rollback-failure-lock-1",
    });
    const claim = await t.mutation(claimJob, { jobId: queued.jobId });
    if (!claim) throw new Error("expected rollback claim");
    await t.mutation(recordProviderFailure, {
      jobId: queued.jobId, leaseToken: claim.leaseToken, kind: "validation",
    });
    const failed = await t.run(async (ctx) => ({
      resource: await ctx.db.get(resourceId),
      candidate: await ctx.db.get(ids[0]),
    }));
    expect(failed.resource?.activeVersionId).toBe(ids[1]);
    expect(failed.candidate?.status).toBe("superseded");

    await addStepUp(t, reviewer, "document_rollback", ids[0], "rollback-failure-lock-2");
    await expect(reviewer.client.mutation(rollbackVersion, {
      versionId: ids[0], confirmation: `ROLLBACK ${ids[0]}`,
      reason: "Retry the earlier verified legal text", idempotencyKey: "rollback-failure-lock-2",
    })).resolves.toMatchObject({ duplicate: false, type: "groundx_copy" });
    expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(5))).toHaveLength(2);
  });

  it("cancels an expired lifecycle lock safely before allowing a new command", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "approved"]);
    await addStepUp(t, reviewer, "document_publish", ids[1], "stale-publish-1");
    const queued = await reviewer.client.mutation(publishVersion, {
      versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`,
      reason: "Start a production promotion", idempotencyKey: "stale-publish-1",
    });
    const lockId = await t.run(async (ctx) => {
      const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).unique();
      if (!lock) throw new Error("expected lifecycle lock");
      await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
      return lock._id;
    });
    await t.mutation(expireLifecycleLock, { lockId });
    const expired = await t.run(async (ctx) => ({
      locks: await ctx.db.query("documentLifecycleLocks").take(2),
      job: await ctx.db.get(queued.jobId as Id<"integrationJobs">),
      candidate: await ctx.db.get(ids[1]),
      resource: await ctx.db.get(resourceId),
    }));
    expect(expired.locks).toHaveLength(0);
    expect(expired.job?.status).toBe("cancelled");
    expect(expired.candidate?.status).toBe("approved");
    expect(expired.resource?.activeVersionId).toBe(ids[0]);

    await addStepUp(t, reviewer, "document_publish", ids[1], "stale-publish-2");
    await expect(reviewer.client.mutation(publishVersion, {
      versionId: ids[1], confirmation: `PUBLISH ${ids[1]}`,
      reason: "Retry after stale cancellation", idempotencyKey: "stale-publish-2",
    })).resolves.toMatchObject({ duplicate: false });
  });

  it.each(["running", "waiting_callback"] as const)(
    "keeps an expired %s provider operation locked until its authoritative terminal result",
    async (providerState) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const rollbackReviewer = await asAdmin(t, "content_reviewer");
      const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "superseded", "approved"]);
      await addStepUp(t, publisher, "document_publish", ids[2], `uncertain-${providerState}-1`);
      const queued = await publisher.client.mutation(publishVersion, {
        versionId: ids[2], confirmation: `PUBLISH ${ids[2]}`,
        reason: "Start an uncertain provider operation", idempotencyKey: `uncertain-${providerState}-1`,
      });
      const provider = await t.run(async (ctx) => {
        const lock = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId)).unique();
        const job = await ctx.db.get(queued.jobId as Id<"integrationJobs">);
        if (!lock || !job) throw new Error("expected active lifecycle operation");
        const leaseToken = "lease_authoritative_result";
        await ctx.db.patch(lock._id, { expiresAt: Date.now() - 1 });
        await ctx.db.patch(job._id, providerState === "running" ? {
          status: "running",
          leaseToken,
          leaseExpiresAt: Date.now() + 60_000,
          nextAttemptAt: Date.now() + 60_000,
        } : {
          status: "waiting_callback",
          processId: "provider-uncertain-process",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: Date.now() + 60_000,
        });
        return { lockId: lock._id, leaseToken, callbackTokenHash: job.callbackTokenHash };
      });
      await t.mutation(expireLifecycleLock, { lockId: provider.lockId });
      const uncertain = await t.run(async (ctx) => ({
        locks: await ctx.db.query("documentLifecycleLocks").take(2),
        job: await ctx.db.get(queued.jobId as Id<"integrationJobs">),
        candidate: await ctx.db.get(ids[2]),
        resource: await ctx.db.get(resourceId),
      }));
      expect(uncertain.locks).toHaveLength(1);
      expect(uncertain.job?.status).toBe(providerState);
      expect(uncertain.candidate?.status).toBe("publishing");
      expect(uncertain.resource?.activeVersionId).toBe(ids[0]);

      await addStepUp(t, rollbackReviewer, "document_rollback", ids[1], `uncertain-${providerState}-rollback`);
      await expect(rollbackReviewer.client.mutation(rollbackVersion, {
        versionId: ids[1], confirmation: `ROLLBACK ${ids[1]}`,
        reason: "Do not overlap uncertain provider work", idempotencyKey: `uncertain-${providerState}-rollback`,
      })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");
      expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(5))).toHaveLength(1);

      if (providerState === "running") {
        await t.mutation(applyProviderResult, {
          jobId: queued.jobId,
          leaseToken: provider.leaseToken,
          processId: "provider-delayed-success",
          status: "complete",
          documentEvidence: { documentId: "production-delayed", bucketId: 202, status: "complete" },
        });
        expect((await t.run(async (ctx) => ctx.db.get(resourceId)))?.activeVersionId).toBe(ids[2]);
      } else {
        await t.mutation(completeGroundxCallback, {
          tokenHash: provider.callbackTokenHash,
          processId: "provider-uncertain-process",
          status: "error",
        });
        const failed = await t.run(async (ctx) => ({ resource: await ctx.db.get(resourceId), candidate: await ctx.db.get(ids[2]) }));
        expect(failed.resource?.activeVersionId).toBe(ids[0]);
        expect(failed.candidate?.status).toBe("approved");
      }
      expect(await t.run(async (ctx) => ctx.db.query("documentLifecycleLocks").take(2))).toHaveLength(0);
      expect(await t.run(async (ctx) => ctx.db.query("integrationJobs").take(5))).toHaveLength(1);
    },
  );

  it.each([
    { terminalStatus: "complete" as const, candidateStatus: "published" as const, activatesCandidate: true },
    { terminalStatus: "error" as const, candidateStatus: "approved" as const, activatesCandidate: false },
  ])(
    "keeps exhausted observation uncertainty locked until delayed $terminalStatus callback resolves it",
    async ({ terminalStatus, candidateStatus, activatesCandidate }) => {
      const t = createBackend();
      await enablePanel(t);
      const publisher = await asAdmin(t, "content_reviewer");
      const competitor = await asAdmin(t, "content_reviewer");
      const { resourceId, ids } = await seedCatalog(t, "manager-1", ["published", "superseded", "approved"]);
      const publishKey = `manual-review-${terminalStatus}-publish`;
      await addStepUp(t, publisher, "document_publish", ids[2], publishKey);
      const queued = await publisher.client.mutation(publishVersion, {
        versionId: ids[2], confirmation: `PUBLISH ${ids[2]}`,
        reason: "Promote after authoritative provider confirmation", idempotencyKey: publishKey,
      });
      const initialLease = await t.mutation(claimJob, { jobId: queued.jobId });
      if (!initialLease) throw new Error("expected initial publication lease");
      await t.mutation(applyProviderResult, {
        jobId: queued.jobId,
        leaseToken: initialLease.leaseToken,
        processId: `manual-review-${terminalStatus}-process`,
        status: "processing",
      });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await t.run(async (ctx) => {
          await ctx.db.patch(queued.jobId, { nextAttemptAt: Date.now() - 1 });
        });
        const claim = await t.mutation(claimJob, { jobId: queued.jobId });
        if (!claim) throw new Error(`expected observation retry ${attempt + 1}`);
        const failure = await t.mutation(recordProviderFailure, {
          jobId: queued.jobId,
          leaseToken: claim.leaseToken,
          kind: attempt % 2 === 0 ? "network" : "timeout",
        });
        expect(failure.status).toBe(attempt < 3 ? "queued" : "manual_review");
      }

      const uncertain = await t.run(async (ctx) => ({
        job: await ctx.db.get(queued.jobId as Id<"integrationJobs">),
        candidate: await ctx.db.get(ids[2]),
        resource: await ctx.db.get(resourceId),
        locks: await ctx.db.query("documentLifecycleLocks").take(2),
      }));
      expect(uncertain.job).toMatchObject({
        status: "manual_review",
        processId: `manual-review-${terminalStatus}-process`,
        callbackTokenHash: expect.any(String),
      });
      expect(uncertain.candidate?.status).toBe("publishing");
      expect(uncertain.resource?.activeVersionId).toBe(ids[0]);
      expect(uncertain.locks).toHaveLength(1);

      const competingKey = `manual-review-${terminalStatus}-rollback`;
      await addStepUp(t, competitor, "document_rollback", ids[1], competingKey);
      await expect(competitor.client.mutation(rollbackVersion, {
        versionId: ids[1], confirmation: `ROLLBACK ${ids[1]}`,
        reason: "Do not overlap an unresolved provider outcome", idempotencyKey: competingKey,
      })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");
      await expect(t.mutation(completeGroundxCallback, {
        tokenHash: uncertain.job?.callbackTokenHash,
        processId: "wrong-process",
        status: terminalStatus,
      })).rejects.toThrow("INTEGRATION_CALLBACK_NOT_FOUND");
      const callback = {
        tokenHash: uncertain.job?.callbackTokenHash,
        processId: `manual-review-${terminalStatus}-process`,
        status: terminalStatus,
        ...(terminalStatus === "complete" ? { documentEvidence: { documentId: "production-manual-review", bucketId: 202, status: "complete" as const } } : {}),
      };
      await expect(t.mutation(completeGroundxCallback, callback)).resolves.toEqual({ accepted: true, duplicate: false });
      await expect(t.mutation(completeGroundxCallback, callback)).resolves.toEqual({ accepted: true, duplicate: true });
      const resolved = await t.run(async (ctx) => ({
        job: await ctx.db.get(queued.jobId as Id<"integrationJobs">),
        candidate: await ctx.db.get(ids[2]),
        resource: await ctx.db.get(resourceId),
        locks: await ctx.db.query("documentLifecycleLocks").take(2),
        jobs: await ctx.db.query("integrationJobs").take(5),
      }));
      expect(resolved.job?.status).toBe(terminalStatus === "complete" ? "succeeded" : "failed");
      expect(resolved.candidate?.status).toBe(candidateStatus);
      expect(resolved.resource?.activeVersionId).toBe(activatesCandidate ? ids[2] : ids[0]);
      expect(resolved.locks).toHaveLength(0);
      expect(resolved.jobs).toHaveLength(1);
    },
  );

  it("shows provider-derived X-Ray evidence and never infers it from staging metadata", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reviewer = await asAdmin(t, "content_reviewer");
    const { ids } = await seedCatalog(t, "manager-1", ["ready_for_review"]);
    const absent = await reviewer.client.query(listReviewQueue, {
      status: "ready_for_review",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(absent.page[0].xrayEvidence).toEqual({ status: "unavailable" });

    const jobId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("integrationJobs", {
        type: "ingest_remote",
        targetType: "documentVersion",
        targetId: ids[0],
        payload: JSON.stringify({ documents: [{ bucketId: 101, sourceUrl: "https://laws.example.gov/act-843" }] }),
        actorId: "system",
        actorRoles: [],
        idempotencyKey: "xray-evidence-ingest",
        requestFingerprint: "e".repeat(64),
        correlationId: "job_xray_evidence",
        callbackTokenHash: "f".repeat(64),
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    const claim = await t.mutation(claimJob, { jobId });
    if (!claim) throw new Error("expected evidence job claim");
    await t.mutation(applyProviderResult, {
      jobId,
      leaseToken: claim.leaseToken,
      processId: "xray-process-1",
      status: "complete",
      documentEvidence: {
        documentId: "staging-doc-1",
        status: "complete",
        fileType: "pdf",
        fileSize: 4096,
      },
    });
    const available = await reviewer.client.query(listReviewQueue, {
      status: "ready_for_review",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(available.page[0].xrayEvidence).toEqual({
      status: "complete",
      documentId: "staging-doc-1",
      processId: "xray-process-1",
      fileType: "pdf",
      fileSize: 4096,
    });
    const persisted = JSON.stringify(await t.run(async (ctx) => ctx.db.get(ids[0])));
    expect(persisted).not.toContain("xrayUrl");
    expect(persisted).not.toContain("sourceUrl\":\"https://provider");
    expect(persisted).not.toContain("extractedBody");
  });
});
