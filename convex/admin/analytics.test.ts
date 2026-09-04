/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { api, components } from "../_generated/api";
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

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

const previousEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousEnvironment = process.env.ADMIN_ENVIRONMENT;
afterEach(() => {
  if (previousEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousEnabled;
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

async function createAuditor(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: now });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Analytics auditor", email: `analytics-${crypto.randomUUID()}@example.com`, emailVerified: true,
      createdAt: now, updatedAt: now, role: "auditor", banned: false, twoFactorEnabled: true,
    } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: crypto.randomUUID(), userId: user._id, expiresAt: now + 60_000, createdAt: now, updatedAt: now,
      adminTwoFactorVerifiedAt: now,
    } } });
    return { userId: user._id, sessionId: session._id };
  });
  return t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId });
}

function metric(day: string, updatedAt: number) {
  return {
    day, totalQuestions: 1, successCount: 1, failureCount: 0, abortedCount: 0,
    providerFailureCount: 0, latencyLe250: 1, latencyLe500: 1,
    latencyLe1000: 1, latencyLe2500: 1, latencyLe5000: 1, latencyGt5000: 0,
    p50UpperBoundMs: 250, p95UpperBoundMs: 250, updatedAt,
  };
}

describe("admin daily analytics", () => {
  it("checks analytics permission before validating filter data", async () => {
    const t = createBackend();
    process.env.ADMIN_PANEL_ENABLED = "true";
    process.env.ADMIN_ENVIRONMENT = "test";
    await expect(t.query(api.admin.analytics.listDailyMetrics, {
      paginationOpts: { numItems: 0, cursor: null }, jurisdictionId: null,
      fromDay: "not-a-day", toDay: "also-not-a-day",
    })).rejects.toThrow("ADMIN_AUTH_REQUIRED");
  });

  it("filters metrics by the stable ID/day composite index", async () => {
    const t = createBackend();
    const auditor = await createAuditor(t);
    const { firstId, secondId } = await t.run(async (ctx) => {
      const base = { status: "enabled" as const, isDefault: false, providerSyncState: "synced" as const,
        kind: "geographic" as const, visibility: "public" as const, legacyCountryCode: "GH",
        createdBy: "fixture", updatedBy: "fixture", createdAt: 1, updatedAt: 1 };
      const firstId = await ctx.db.insert("jurisdictions", { ...base, name: "Ghana", slug: "ghana" });
      const secondId = await ctx.db.insert("jurisdictions", { ...base, name: "Other Ghana", slug: "other-ghana" });
      await ctx.db.insert("dailyMetrics", { ...metric("2026-07-01", 1), jurisdictionId: firstId, jurisdictionName: "Ghana", jurisdictionKind: "geographic" });
      await ctx.db.insert("dailyMetrics", { ...metric("2026-07-01", 2), jurisdictionId: secondId, jurisdictionName: "Other Ghana", jurisdictionKind: "geographic" });
      return { firstId, secondId };
    });

    const result = await auditor.query(api.admin.analytics.listDailyMetrics, {
      paginationOpts: { numItems: 10, cursor: null }, jurisdictionId: firstId,
      fromDay: "2026-07-01", toDay: "2026-07-31",
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({ jurisdictionId: firstId, jurisdictionName: "Ghana" });
    expect(result.page[0].jurisdictionId).not.toBe(secondId);
    expect(result.page[0]).not.toHaveProperty("contextDigest");
    expect(result.page[0]).not.toHaveProperty("providerCallCount");
    expect(result.page[0]).not.toHaveProperty("retrievalPlanSize");
  });

});
