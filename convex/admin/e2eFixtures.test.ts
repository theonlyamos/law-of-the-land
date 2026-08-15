/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import authSchema from "../betterAuth/schema";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { authorizeFixtureRequest } from "./e2eFixtures";
import { E2E_PRIVILEGED_FUNCTIONS } from "./e2eAccessMatrix";

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

const bootstrap = makeFunctionReference<"action">("admin/e2eFixtures:bootstrap");
const cleanup = makeFunctionReference<"mutation">("admin/e2eFixtures:cleanup");
const control = makeFunctionReference<"action">("admin/e2eFixtures:control");
const grantQuotaOverride = makeFunctionReference<"mutation">("admin/billing:grantQuotaOverride");
const revokeQuotaOverride = makeFunctionReference<"mutation">("admin/billing:revokeQuotaOverride");
const createIncident = makeFunctionReference<"mutation">("admin/operations:createIncident");
const addIncidentNote = makeFunctionReference<"mutation">("admin/operations:addIncidentNote");
const createJurisdiction = makeFunctionReference<"mutation">("admin/resources:createJurisdiction");
const publishVersion = makeFunctionReference<"mutation">("admin/publication:publishVersion");
const runGroundxJob = makeFunctionReference<"action">("admin/groundxActions:runGroundxJob");
const original = { ...process.env };

afterEach(() => {
  for (const key of ["ADMIN_E2E_FIXTURE_MODE", "ADMIN_E2E_TARGET_ENV", "ADMIN_E2E_ISOLATED_TARGET_MARKER", "ADMIN_E2E_PROVIDER_STUB_MODE", "ADMIN_E2E_FIXTURE_SECRET", "ADMIN_E2E_ACCOUNT_PASSWORD", "ADMIN_PANEL_ENABLED", "ADMIN_ENVIRONMENT"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

function enableFixtureMode() {
  process.env.ADMIN_E2E_FIXTURE_MODE = "true";
  process.env.ADMIN_E2E_TARGET_ENV = "test";
  process.env.ADMIN_E2E_ISOLATED_TARGET_MARKER = "isolated-admin-e2e";
  process.env.ADMIN_E2E_PROVIDER_STUB_MODE = "true";
  process.env.ADMIN_E2E_ACCOUNT_PASSWORD = "local-e2e-password-123";
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
}

describe("isolated admin E2E fixture control plane", () => {
  it("provides dormant fixture-run ownership with exact tag and environment indexes", async () => {
    const t = backend();
    const now = Date.now();
    const featureFlagId = await t.run((ctx) => ctx.db.insert("featureFlags", {
      key: "unified_jurisdictions",
      environment: "test",
      enabled: true,
      updatedAt: now,
      updatedBy: "fixture:e2e_runownership1",
    }));
    const runId = await t.run((ctx) => ctx.db.insert("e2eFixtureRuns", {
      tag: "e2e_runownership1",
      environment: "test",
      state: "bootstrapping",
      priorFlag: { kind: "absent" },
      fixtureFlagWrite: {
        rowId: featureFlagId,
        enabled: true,
        updatedAt: now,
        updatedBy: "fixture:e2e_runownership1",
      },
      approvedCommitSha: "74a989459da6b197013222f0bb5c118eed994d64",
      deployedCommitSha: "74a989459da6b197013222f0bb5c118eed994d64",
      createdAt: now,
      updatedAt: now,
    }));

    await expect(t.run(async (ctx) => ({
      byTag: await ctx.db.query("e2eFixtureRuns").withIndex("by_tag", (q) => q.eq("tag", "e2e_runownership1")).unique(),
      byEnvironment: await ctx.db.query("e2eFixtureRuns").withIndex("by_environment", (q) => q.eq("environment", "test")).unique(),
    }))).resolves.toMatchObject({
      byTag: { _id: runId, state: "bootstrapping" },
      byEnvironment: { _id: runId, environment: "test" },
    });
  });

  it.each([
    [{}, "E2E_FIXTURES_DISABLED"],
    [{ ADMIN_E2E_FIXTURE_MODE: "false", ADMIN_E2E_TARGET_ENV: "test", ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e" }, "E2E_PROVIDER_ISOLATION_MISCONFIGURED"],
    [{ ADMIN_E2E_FIXTURE_MODE: "true", ADMIN_E2E_TARGET_ENV: "production", ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e" }, "E2E_PROVIDER_ISOLATION_MISCONFIGURED"],
    [{ ADMIN_E2E_FIXTURE_MODE: "true", ADMIN_E2E_TARGET_ENV: "test", ADMIN_E2E_ISOLATED_TARGET_MARKER: "anything-else" }, "E2E_PROVIDER_ISOLATION_MISCONFIGURED"],
  ])("refuses bootstrap outside an explicitly marked isolated target: %o", async (environment, error) => {
    Object.assign(process.env, environment);
    const t = backend();
    await expect(t.action(bootstrap, { tag: "e2e_guardfixture1" })).rejects.toThrow(error);
  });

  it("provisions exact roles, assurance variants, and tagged domain records without provider calls", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    const result = await t.action(bootstrap, { tag: "e2e_contractfixture1" });
    expect(result.providerTransport).toBe("stub");

    expect(Object.keys(result.sessions).sort()).toEqual([
      "auditor", "billing_manager", "content_manager", "content_reviewer", "super_admin", "support_agent",
    ]);
    expect(result.variants).toMatchObject({
      normal: { userId: expect.any(String), sessionToken: expect.any(String) },
      noTwoFactor: { userId: expect.any(String), sessionToken: expect.any(String) },
      unassured: { userId: expect.any(String), sessionToken: expect.any(String) },
    });
    expect(result.records).toMatchObject({
      chatId: expect.any(String), resourceId: expect.any(String), stagingBucketId: expect.stringMatching(/^\d+$/),
      productionBucketId: expect.stringMatching(/^\d+$/), callbackToken: expect.stringMatching(/^gx_[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain("ADMIN_E2E");
    const jobs = await t.run((ctx) => ctx.db.query("integrationJobs").withIndex("by_targetType_and_targetId", (q) => q.eq("targetType", "e2e_fixture").eq("targetId", "e2e_contractfixture1")).take(10));
    expect(jobs).toHaveLength(1);
  });

  it("prepares a distinct tagged success fixture for every public privileged mutation", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    await t.action(bootstrap, { tag: "e2e_matrixfixture1" });

    for (const [index, entry] of E2E_PRIVILEGED_FUNCTIONS.entries()) {
      for (const [roleIndex, role] of entry.allowed.entries()) {
        const prepared = await t.action(control, {
          tag: "e2e_matrixfixture1",
          operation: "prepare_matrix_operation",
          path: entry.path,
          role,
          key: `matrix_${index.toString().padStart(2, "0")}_${roleIndex}_${role}`,
        });
        expect(prepared, `${entry.path} as ${role}`).toMatchObject({
          path: entry.path,
          role,
          args: expect.any(Object),
          success: (entry as { success: string }).success,
        });
      }
    }
    expect((await t.mutation(cleanup, { tag: "e2e_matrixfixture1" })).deleted).toBeGreaterThan(0);
    expect((await t.mutation(cleanup, { tag: "e2e_matrixfixture1" })).deleted).toBe(0);
    await expect(t.run(async (ctx) => ({
      jurisdictions: (await ctx.db.query("jurisdictions").take(500)).filter((row) => row.createdBy === "fixture:e2e_matrixfixture1"),
      chats: (await ctx.db.query("chatSessions").take(500)).filter((row) => row.userId === "fixture:e2e_matrixfixture1"),
      jobs: (await ctx.db.query("integrationJobs").take(500)).filter((row) => row.targetId.includes("e2e_matrixfixture1")),
    }))).resolves.toEqual({ jurisdictions: [], chats: [], jobs: [] });
  });

  it("prepares and executes unique two-letter jurisdiction codes for every allowed matrix cell", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    await t.action(bootstrap, { tag: "e2e_codefixture1" });
    const entry = E2E_PRIVILEGED_FUNCTIONS.find((row) => row.path === "admin/resources:createJurisdiction");
    if (!entry) throw new Error("createJurisdiction matrix entry missing");
    const codes: string[] = [];

    for (const [roleIndex, role] of entry.allowed.entries()) {
      const prepared = await t.action(control, {
        tag: "e2e_codefixture1",
        operation: "prepare_matrix_operation",
        path: entry.path,
        role,
        key: `matrix_14_${roleIndex}_${role}`,
      });
      expect(prepared.args.code, role).toMatch(/^[A-Z]{2}$/);
      codes.push(prepared.args.code);
      const actor = await t.run(async (ctx) => {
        const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model: "user",
          where: [{ field: "email", operator: "eq", value: `${role}.e2e_codefixture1@e2e.invalid` }],
          select: ["id"],
          paginationOpts: { numItems: 2, cursor: null },
        }) as { page: Array<{ _id: string }> };
        const userId = users.page[0]?._id;
        if (!userId) throw new Error(`fixture ${role} missing`);
        const sessions = await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model: "session",
          where: [{ field: "userId", operator: "eq", value: userId }],
          select: ["id"],
          paginationOpts: { numItems: 2, cursor: null },
        }) as { page: Array<{ _id: string }> };
        return { userId, sessionId: sessions.page[0]?._id };
      });
      if (!actor.sessionId) throw new Error(`fixture ${role} session missing`);
      await expect(t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId }).mutation(createJurisdiction, prepared.args)).resolves.toEqual(expect.any(String));
    }
    expect(new Set(codes).size).toBe(codes.length);
    await t.mutation(cleanup, { tag: "e2e_codefixture1" });
  });

  it("consumes exact outcomes armed before public publication scheduling without patching terminal jobs", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    const fixture = await t.action(bootstrap, { tag: "e2e_outcomefixture1" });
    await expect(t.action(control, {
      tag: "e2e_outcomefixture1",
      operation: "arm_provider_outcome",
      versionId: fixture.records.reviewVersionId,
      publicationOperation: "publish",
      providerOutcome: "failed",
    })).resolves.toMatchObject({ armed: true, tag: "e2e_outcomefixture1", outcome: "failed", operation: "publish" });
    await expect(t.action(control, {
      tag: "e2e_outcomefixture1",
      operation: "arm_provider_outcome",
      versionId: fixture.records.reviewVersionId,
      publicationOperation: "publish",
      providerOutcome: "succeeded",
    })).rejects.toThrow("E2E_PROVIDER_OUTCOME_ALREADY_ARMED");

    const actor = await t.run(async (ctx) => {
      const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user", where: [{ field: "email", operator: "eq", value: "content_reviewer.e2e_outcomefixture1@e2e.invalid" }],
        select: ["id"], paginationOpts: { numItems: 2, cursor: null },
      }) as { page: Array<{ _id: string }> };
      const userId = users.page[0]?._id;
      if (!userId) throw new Error("reviewer fixture missing");
      const sessions = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session", where: [{ field: "userId", operator: "eq", value: userId }],
        select: ["id"], paginationOpts: { numItems: 2, cursor: null },
      }) as { page: Array<{ _id: string }> };
      const sessionId = sessions.page[0]?._id;
      if (!sessionId) throw new Error("reviewer session missing");
      await ctx.db.patch(fixture.records.reviewVersionId, { status: "approved", reviewedBy: userId, reviewedAt: Date.now(), updatedAt: Date.now() });
      return { userId, sessionId };
    });
    const reviewer = t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId });
    const queuePublish = async (idempotencyKey: string) => {
      await t.run((ctx) => ctx.db.insert("adminStepUpProofs", {
        actorId: actor.userId, sessionId: actor.sessionId, action: "document_publish",
        targetId: fixture.records.reviewVersionId, idempotencyKey, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
      }));
      return await reviewer.mutation(publishVersion, {
        versionId: fixture.records.reviewVersionId,
        confirmation: `PUBLISH ${fixture.records.reviewVersionId}`,
        reason: "Exercise exact provider outcome",
        idempotencyKey,
      });
    };

    const failed = await queuePublish("e2e-publish-fail");
    await t.action(runGroundxJob, { jobId: failed.jobId });
    await expect(t.run(async (ctx) => ({
      job: await ctx.db.get(failed.jobId),
      version: await ctx.db.get(fixture.records.reviewVersionId),
      resource: await ctx.db.get(fixture.records.resourceId),
    }))).resolves.toMatchObject({
      job: { status: "failed", lastErrorKind: "provider" },
      version: { status: "approved", failureSummary: "Production copy failed" },
      resource: { activeVersionId: fixture.records.publishedVersionId },
    });

    await t.action(control, {
      tag: "e2e_outcomefixture1", operation: "arm_provider_outcome",
      versionId: fixture.records.reviewVersionId, publicationOperation: "publish", providerOutcome: "succeeded",
    });
    const succeeded = await queuePublish("e2e-publish-retry");
    await t.action(runGroundxJob, { jobId: succeeded.jobId });
    await expect(t.run(async (ctx) => ({
      job: await ctx.db.get(succeeded.jobId),
      version: await ctx.db.get(fixture.records.reviewVersionId),
      prior: await ctx.db.get(fixture.records.publishedVersionId),
      resource: await ctx.db.get(fixture.records.resourceId),
    }))).resolves.toMatchObject({
      job: { status: "succeeded" },
      version: { status: "published" },
      prior: { status: "superseded" },
      resource: { activeVersionId: fixture.records.reviewVersionId },
    });
  });

  it("teardown removes only the exact fixture tag and is idempotent", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    const fixture = await t.action(bootstrap, { tag: "e2e_cleanupfixture1" });
    const owned = await t.run(async (ctx) => {
      const incidentId = await ctx.db.insert("systemIncidents", { title: "e2e_cleanupfixture1 UI incident", severity: "low", status: "open", createdBy: fixture.sessions.super_admin.userId, createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("incidentTimeline", { incidentId, kind: "created", actorId: fixture.sessions.super_admin.userId, summary: "fixture", createdAt: Date.now() });
      const operationId = await ctx.db.insert("adminOperations", { actorId: fixture.sessions.super_admin.userId, action: "incident_create", targetId: incidentId, idempotencyKey: "e2e-cleanup-op", requestFingerprint: "{}", correlationId: "e2e-cleanup-op", status: "succeeded", createdAt: Date.now(), updatedAt: Date.now() });
      const jurisdictionId = await ctx.db.insert("jurisdictions", { code: "QX", name: "Actor owned", slug: "actor-owned-cleanup", status: "draft", isDefault: false, providerSyncState: "pending", createdBy: fixture.sessions.content_manager.userId, updatedBy: fixture.sessions.content_manager.userId, createdAt: Date.now(), updatedAt: Date.now() });
      const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "act", title: "Actor owned", issuer: "E2E", officialCitation: "actor-owned", officialCitationKey: "actor-owned", sourceUrl: "https://example.invalid/actor-owned", topics: [], effectiveDate: "2026-01-01", status: "active", createdBy: fixture.sessions.content_manager.userId, updatedBy: fixture.sessions.content_manager.userId, createdAt: Date.now(), updatedAt: Date.now() });
      const quotaId = await ctx.db.insert("quotaOverrides", { userId: fixture.variants.normal.userId, limit: 25, startsAt: Date.now(), expiresAt: Date.now() + 60_000, grantedBy: fixture.sessions.billing_manager.userId, reason: "Browser fixture", active: true, grantOperationId: operationId, createdAt: Date.now(), updatedAt: Date.now() });
      return { jurisdictionId, resourceId, quotaId };
    });
    const foreignUser = await t.run((ctx) => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Must survive", email: "foreign.e2e_cleanupfixture1@e2e.invalid", emailVerified: true, role: "user", banned: false, twoFactorEnabled: false, createdAt: Date.now(), updatedAt: Date.now() } } }));
    await t.run((ctx) => ctx.db.insert("chatSessions", { userId: "other", externalId: "e2e_cleanupfixture1-suffix", title: "Must survive", lastMessage: "safe", messageCount: 0, updatedAt: Date.now() }));

    const first = await t.mutation(cleanup, { tag: "e2e_cleanupfixture1" });
    const second = await t.mutation(cleanup, { tag: "e2e_cleanupfixture1" });
    expect(first.deleted).toBeGreaterThan(0);
    expect(second.deleted).toBe(0);
    await expect(t.run((ctx) => ctx.db.query("systemIncidents").take(10))).resolves.toHaveLength(0);
    await expect(t.run((ctx) => ctx.db.query("adminOperations").take(10))).resolves.toHaveLength(0);
    await expect(t.run(async (ctx) => ({ jurisdiction: await ctx.db.get(owned.jurisdictionId), resource: await ctx.db.get(owned.resourceId), quota: await ctx.db.get(owned.quotaId) }))).resolves.toEqual({ jurisdiction: null, resource: null, quota: null });
    await expect(t.run((ctx) => ctx.runQuery(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "_id", operator: "eq", value: foreignUser._id }] }))).resolves.toMatchObject({ _id: foreignUser._id });
    const survivor = await t.run((ctx) => ctx.db.query("chatSessions").withIndex("by_user_externalId", (q) => q.eq("userId", "other").eq("externalId", "e2e_cleanupfixture1-suffix")).unique());
    expect(survivor?.title).toBe("Must survive");
  });

  it("deletes exact matrix-owned cleanup records while preserving tag lookalikes", async () => {
    enableFixtureMode();
    const t = backend();
    const tag = "e2e_cleanupfixture2";
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    const fixture = await t.action(bootstrap, { tag });
    const sessionIds = await t.run(async (ctx) => {
      const findSession = async (userId: string) => {
        const sessions = await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model: "session",
          where: [{ field: "userId", operator: "eq", value: userId }],
          select: ["id"],
          paginationOpts: { numItems: 2, cursor: null },
        }) as { page: Array<{ _id: string }> };
        if (!sessions.page[0]) throw new Error(`fixture session missing for ${userId}`);
        return sessions.page[0]._id;
      };
      return {
        billingManager: await findSession(fixture.sessions.billing_manager.userId),
        superAdmin: await findSession(fixture.sessions.super_admin.userId),
      };
    });
    const billingManager = t.withIdentity({ subject: fixture.sessions.billing_manager.userId, sessionId: sessionIds.billingManager });
    const superAdmin = t.withIdentity({ subject: fixture.sessions.super_admin.userId, sessionId: sessionIds.superAdmin });

    const preparedGrant = await t.action(control, {
      tag,
      operation: "prepare_matrix_operation",
      path: "admin/billing:grantQuotaOverride",
      role: "billing_manager",
      key: "cleanup_grant_billing",
    });
    const granted = await billingManager.mutation(grantQuotaOverride, preparedGrant.args);
    const preparedRevoke = await t.action(control, {
      tag,
      operation: "prepare_matrix_operation",
      path: "admin/billing:revokeQuotaOverride",
      role: "billing_manager",
      key: "cleanup_revoke_billing",
    });
    const revoked = await billingManager.mutation(revokeQuotaOverride, preparedRevoke.args);
    const preparedCreateIncident = await t.action(control, {
      tag,
      operation: "prepare_matrix_operation",
      path: "admin/operations:createIncident",
      role: "super_admin",
      key: "cleanup_create_incident",
    });
    const createdIncident = await superAdmin.mutation(createIncident, preparedCreateIncident.args);
    const preparedNote = await t.action(control, {
      tag,
      operation: "prepare_matrix_operation",
      path: "admin/operations:addIncidentNote",
      role: "super_admin",
      key: "cleanup_note_incident",
    });
    const notedIncident = await superAdmin.mutation(addIncidentNote, preparedNote.args);

    const records = await t.run(async (ctx) => {
      const grantedOverride = await ctx.db.get(granted.overrideId as Id<"quotaOverrides">);
      const revokedOverride = await ctx.db.get(revoked.overrideId as Id<"quotaOverrides">);
      if (!grantedOverride || !revokedOverride || !revokedOverride.revokeOperationId) throw new Error("matrix quota records missing");
      const createdOperation = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", fixture.sessions.super_admin.userId).eq("idempotencyKey", "cleanup_create_incident")).unique();
      const notedOperation = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", fixture.sessions.super_admin.userId).eq("idempotencyKey", "cleanup_note_incident")).unique();
      if (!createdOperation || !notedOperation) throw new Error("matrix incident operations missing");
      const ownedTimelines = [
        ...await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", createdIncident.incidentId)).take(20),
        ...await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", notedIncident.incidentId)).take(20),
      ];
      const ownedJobControlResultId = await ctx.db.insert("jobControlResults", {
        operationId: grantedOverride.grantOperationId,
        jobId: fixture.records.callbackJobId,
        status: "queued",
        correlationId: "owned-cleanup-control-result",
        createdAt: Date.now(),
      });
      const legacyOwnedOperationId = await ctx.db.insert("adminOperations", {
        actorId: `fixture:${tag}`,
        action: "e2e.fixture",
        targetId: tag,
        idempotencyKey: "legacy-owned-quota-operation",
        requestFingerprint: "{}",
        correlationId: "legacy-owned-quota-operation",
        status: "succeeded",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const legacyOwnedQuotaId = await ctx.db.insert("quotaOverrides", {
        userId: `fixture:${tag}:legacy-owned-user`,
        limit: 25,
        startsAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        grantedBy: `fixture:${tag}`,
        reason: "Legacy exact operation ownership",
        active: true,
        grantOperationId: legacyOwnedOperationId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const lookalikeOperationId = await ctx.db.insert("adminOperations", {
        actorId: "foreign-admin",
        action: "foreign_action",
        targetId: `${tag}-unrelated-target`,
        idempotencyKey: "foreign-lookalike-operation",
        requestFingerprint: "{}",
        correlationId: "foreign-lookalike-operation",
        status: "succeeded",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const lookalikeIncidentId = await ctx.db.insert("systemIncidents", {
        title: `${tag}-unrelated incident`,
        severity: "low",
        status: "open",
        createdBy: "foreign-admin",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const lookalikeTimelineId = await ctx.db.insert("incidentTimeline", {
        incidentId: lookalikeIncidentId,
        kind: "created",
        actorId: "foreign-admin",
        summary: "unrelated",
        createdAt: Date.now(),
      });
      const lookalikeQuotaId = await ctx.db.insert("quotaOverrides", {
        userId: `fixture:${tag}:unrelated-user`,
        limit: 99,
        startsAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        grantedBy: "foreign-admin",
        reason: "Unrelated lookalike",
        active: true,
        grantOperationId: lookalikeOperationId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return {
        ownedOverrideIds: [granted.overrideId, revoked.overrideId, legacyOwnedQuotaId],
        ownedOperationIds: [grantedOverride.grantOperationId, revokedOverride.grantOperationId, revokedOverride.revokeOperationId, createdOperation._id, notedOperation._id, legacyOwnedOperationId],
        ownedIncidentIds: [createdIncident.incidentId, notedIncident.incidentId],
        ownedTimelineIds: ownedTimelines.map((row) => row._id),
        ownedJobControlResultId,
        quotaTargetOwnership: await Promise.all([grantedOverride.userId, revokedOverride.userId].map((userId) => ctx.db.query("e2eFixtureOwnership").withIndex("by_targetId", (q) => q.eq("targetId", userId)).unique())),
        lookalikeOperationId,
        lookalikeIncidentId,
        lookalikeTimelineId,
        lookalikeQuotaId,
      };
    });
    expect(records.quotaTargetOwnership).toMatchObject([
      { tag, kind: "better_auth_user" },
      { tag, kind: "better_auth_user" },
    ]);

    const first = await t.mutation(cleanup, { tag });
    const second = await t.mutation(cleanup, { tag });
    expect(first.deleted).toBeGreaterThan(0);
    expect(second.deleted).toBe(0);
    expect.soft(await t.run(async (ctx) => ({
      ownedOverrides: await Promise.all(records.ownedOverrideIds.map((id) => ctx.db.get(id))),
      ownedOperations: await Promise.all(records.ownedOperationIds.map((id) => ctx.db.get(id))),
      ownedIncidents: await Promise.all(records.ownedIncidentIds.map((id) => ctx.db.get(id))),
      ownedTimelines: await Promise.all(records.ownedTimelineIds.map((id) => ctx.db.get(id))),
      ownedJobControlResult: await ctx.db.get(records.ownedJobControlResultId),
      ownership: await ctx.db.query("e2eFixtureOwnership").withIndex("by_tag_and_kind", (q) => q.eq("tag", tag)).take(500),
    }))).toEqual({
      ownedOverrides: [null, null, null],
      ownedOperations: [null, null, null, null, null, null],
      ownedIncidents: [null, null],
      ownedTimelines: records.ownedTimelineIds.map(() => null),
      ownedJobControlResult: null,
      ownership: [],
    });
    expect.soft(await t.run(async (ctx) => ({
      operation: await ctx.db.get(records.lookalikeOperationId),
      incident: await ctx.db.get(records.lookalikeIncidentId),
      timeline: await ctx.db.get(records.lookalikeTimelineId),
      quota: await ctx.db.get(records.lookalikeQuotaId),
    }))).toMatchObject({
      operation: { actorId: "foreign-admin", targetId: `${tag}-unrelated-target` },
      incident: { createdBy: "foreign-admin", title: `${tag}-unrelated incident` },
      timeline: { actorId: "foreign-admin", summary: "unrelated" },
      quota: { userId: `fixture:${tag}:unrelated-user`, grantedBy: "foreign-admin" },
    });
  });

  it("redacts only the tagged callback job without touching global retention state", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    await t.action(bootstrap, { tag: "e2e_retentionfixture1" });
    const result = await t.action(control, { tag: "e2e_retentionfixture1", operation: "run_retention" });
    expect(result.callbackJob).toMatchObject({ payload: "{}", retentionRedactedAt: expect.any(Number) });
    await expect(t.run((ctx) => ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique())).resolves.toBeNull();
  });

  it.each(["fixture", "e2e_bad space", "e2e_/slash", "e2e_short"])("rejects unsafe or ambiguous tag %s", async (tag) => {
    enableFixtureMode();
    const t = backend();
    await expect(t.mutation(cleanup, { tag })).rejects.toThrow("E2E_FIXTURE_TAG_INVALID");
  });

  it("accepts only the exact bearer secret without exposing it in a response value", async () => {
    enableFixtureMode();
    process.env.ADMIN_E2E_FIXTURE_SECRET = "s".repeat(48);
    await expect(authorizeFixtureRequest(new Request("https://fixture.invalid", { headers: { authorization: `Bearer ${"s".repeat(48)}` } }))).resolves.toBe(true);
    await expect(authorizeFixtureRequest(new Request("https://fixture.invalid", { headers: { authorization: `Bearer ${"x".repeat(48)}` } }))).resolves.toBe(false);
    await expect(authorizeFixtureRequest(new Request("https://fixture.invalid"))).resolves.toBe(false);
  });
});
