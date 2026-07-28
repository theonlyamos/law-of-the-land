/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import authSchema from "../betterAuth/schema";
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
const original = { ...process.env };

afterEach(() => {
  for (const key of ["ADMIN_E2E_FIXTURE_MODE", "ADMIN_E2E_TARGET_ENV", "ADMIN_E2E_ISOLATED_TARGET_MARKER", "ADMIN_E2E_PROVIDER_STUB_MODE", "ADMIN_E2E_FIXTURE_SECRET", "ADMIN_E2E_ACCOUNT_PASSWORD"]) {
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
}

describe("isolated admin E2E fixture control plane", () => {
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

  it("teardown removes only the exact fixture tag and is idempotent", async () => {
    enableFixtureMode();
    const t = backend();
    await t.run((ctx) => ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }));
    const fixture = await t.action(bootstrap, { tag: "e2e_cleanupfixture1" });
    await t.run(async (ctx) => {
      const incidentId = await ctx.db.insert("systemIncidents", { title: "e2e_cleanupfixture1 UI incident", severity: "low", status: "open", createdBy: fixture.sessions.super_admin.userId, createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("incidentTimeline", { incidentId, kind: "created", actorId: fixture.sessions.super_admin.userId, summary: "fixture", createdAt: Date.now() });
      await ctx.db.insert("adminOperations", { actorId: fixture.sessions.super_admin.userId, action: "incident_create", targetId: incidentId, idempotencyKey: "e2e-cleanup-op", requestFingerprint: "{}", correlationId: "e2e-cleanup-op", status: "succeeded", createdAt: Date.now(), updatedAt: Date.now() });
    });
    await t.run((ctx) => ctx.db.insert("chatSessions", { userId: "other", externalId: "e2e_cleanupfixture1-suffix", title: "Must survive", lastMessage: "safe", messageCount: 0, updatedAt: Date.now() }));

    const first = await t.mutation(cleanup, { tag: "e2e_cleanupfixture1" });
    const second = await t.mutation(cleanup, { tag: "e2e_cleanupfixture1" });
    expect(first.deleted).toBeGreaterThan(0);
    expect(second.deleted).toBe(0);
    await expect(t.run((ctx) => ctx.db.query("systemIncidents").take(10))).resolves.toHaveLength(0);
    await expect(t.run((ctx) => ctx.db.query("adminOperations").take(10))).resolves.toHaveLength(0);
    const survivor = await t.run((ctx) => ctx.db.query("chatSessions").withIndex("by_user_externalId", (q) => q.eq("userId", "other").eq("externalId", "e2e_cleanupfixture1-suffix")).unique());
    expect(survivor?.title).toBe("Must survive");
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
