/// <reference types="vite/client" />

import polarTest from "@convex-dev/polar/test";
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;

const grant = makeFunctionReference<"mutation">("admin/billing:grantQuotaOverride");
const revoke = makeFunctionReference<"mutation">("admin/billing:revokeQuotaOverride");
const effective = makeFunctionReference<"query">("admin/billing:getEffectiveAllowanceForUser");
const listUsage = makeFunctionReference<"query">("admin/billing:listUsage");
const record = makeFunctionReference<"mutation">("usage:recordQuestion");

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  polarTest.register(t);
  return t;
}

async function enable(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  process.env.BILLING_ENABLED = "true";
  await t.run(async (ctx) => { await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() }); });
}

async function admin(t: Backend, role = "billing_manager", options: { assured?: boolean; impersonatedBy?: string } = {}) {
  const now = Date.now();
  const user = await t.run((ctx) => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Billing admin", email: `${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true } } }));
  const session = await t.run((ctx) => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: crypto.randomUUID(), userId: user._id, expiresAt: now + 60_000, createdAt: now, updatedAt: now, ...(options.assured === false ? {} : { adminTwoFactorVerifiedAt: now }), ...(options.impersonatedBy ? { impersonatedBy: options.impersonatedBy } : {}) } } }));
  return t.withIdentity({ subject: user._id, sessionId: session._id });
}

const old = { enabled: process.env.ADMIN_PANEL_ENABLED, environment: process.env.ADMIN_ENVIRONMENT, billing: process.env.BILLING_ENABLED };
beforeEach(() => { process.env.BILLING_ENABLED = "true"; });
afterEach(() => {
  for (const [key, value] of Object.entries(old)) {
    const env = key === "enabled" ? "ADMIN_PANEL_ENABLED" : key === "environment" ? "ADMIN_ENVIRONMENT" : "BILLING_ENABLED";
    if (value === undefined) delete process.env[env]; else process.env[env] = value;
  }
});

describe("audited quota administration", () => {
  it("uses half-open override intervals and returns to Polar's base limit at expiry", async () => {
    const t = backend(); await enable(t); const asBilling = await admin(t); const now = Date.now();
    const granted = await asBilling.mutation(grant, { userId: "customer-1", limit: 250, startsAt: now, expiresAt: now + 60_000, reason: "Temporary case review allowance", idempotencyKey: "grant-1", confirmation: "" });
    expect(await asBilling.query(effective, { userId: "customer-1", now: granted.startsAt })).toMatchObject({ baseLimit: 10, effectiveLimit: 250, allowed: true });
    expect(await asBilling.query(effective, { userId: "customer-1", now: now + 60_000 })).toMatchObject({ baseLimit: 10, effectiveLimit: 10, override: null });
  });

  it("denies support, blocks overlaps, and requires typed confirmation for exceptional grants", async () => {
    const t = backend(); await enable(t); const asSupport = await admin(t, "support_agent"); const asBilling = await admin(t); const now = Date.now();
    const args = { userId: "customer-2", limit: 100, startsAt: now, expiresAt: now + 60_000, reason: "Customer remediation allowance", idempotencyKey: "grant-2", confirmation: "" };
    await expect(asSupport.mutation(grant, args)).rejects.toThrow("permission");
    await asBilling.mutation(grant, args);
    await expect(asBilling.mutation(grant, { ...args, idempotencyKey: "grant-3", startsAt: now + 1, expiresAt: now + 120_000 })).rejects.toThrow("OVERLAPPING_QUOTA_OVERRIDE");
    await expect(asBilling.mutation(grant, { ...args, userId: "customer-3", limit: 1001, idempotencyKey: "grant-4" })).rejects.toThrow("CONFIRM_QUOTA_OVERRIDE customer-3");
  });

  it("rejects unassured and impersonated billing writers server-side", async () => {
    const t = backend(); await enable(t); const now = Date.now();
    const args = { userId: "customer-authority", limit: 100, startsAt: now, expiresAt: now + 60_000, reason: "Temporary account remediation", idempotencyKey: "grant-auth", confirmation: "" };
    await expect((await admin(t, "billing_manager", { assured: false })).mutation(grant, args)).rejects.toThrow("Two-factor");
    await expect((await admin(t, "billing_manager", { impersonatedBy: "original-admin" })).mutation(grant, args)).rejects.toThrow("Impersonated");
  });

  it("replays identical grants, rejects key conflicts, and audits without unsafe payloads", async () => {
    const t = backend(); await enable(t); const asBilling = await admin(t); const now = Date.now();
    const args = { userId: "customer-4", limit: 50, startsAt: now, expiresAt: now + 60_000, reason: "Temporary billing correction", idempotencyKey: "grant-replay", confirmation: "" };
    const first = await asBilling.mutation(grant, args); expect(await asBilling.mutation(grant, args)).toEqual(first);
    await expect(asBilling.mutation(grant, { ...args, limit: 51 })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    const revokeArgs = { overrideId: first.overrideId, reason: "Correction period completed", idempotencyKey: "revoke-1" };
    const revoked = await asBilling.mutation(revoke, revokeArgs);
    expect(await asBilling.mutation(revoke, revokeArgs)).toEqual(revoked);
    await expect(asBilling.mutation(revoke, { ...revokeArgs, reason: "A different reason" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    const audits = await t.run((ctx) => ctx.db.query("auditEvents").withIndex("by_createdAt").take(10));
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["billing.quota_override_granted", "billing.quota_override_revoked"]));
    expect(JSON.stringify(audits)).not.toContain("@example.com");
  });

  it("atomically refuses the next question at the effective limit", async () => {
    const t = backend(); process.env.BILLING_ENABLED = "true";
    const normal = await t.run((ctx) => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Normal user", email: "normal-user@example.com", emailVerified: true, createdAt: Date.now(), updatedAt: Date.now(), role: "user", banned: false, twoFactorEnabled: false } } }));
    const session = await t.run((ctx) => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: crypto.randomUUID(), userId: normal._id, expiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now() } } }));
    const client = t.withIdentity({ subject: normal._id, sessionId: session._id });
    for (let index = 0; index < 9; index += 1) await client.mutation(record, {});
    const contenders = await Promise.allSettled([client.mutation(record, {}), client.mutation(record, {})]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await t.run((ctx) => ctx.db.query("dailyUsage").withIndex("by_user_day", (q) => q.eq("userId", normal._id)).take(2));
    expect(rows).toHaveLength(1); expect(rows[0].count).toBe(10);
  });

  it("paginates indexed usage without returning raw account records", async () => {
    const t = backend(); await enable(t); const asBilling = await admin(t); const day = new Date().toISOString().slice(0, 10);
    await t.run(async (ctx) => { for (const userId of ["usage-a", "usage-b", "usage-c"]) await ctx.db.insert("dailyUsage", { userId, day, count: 2 }); });
    const first = await asBilling.query(listUsage, { paginationOpts: { numItems: 2, cursor: null }, day });
    expect(first.page).toHaveLength(2); expect(first.isDone).toBe(false); expect(first.page[0]).toEqual(expect.objectContaining({ used: 2, baseLimit: 10, effectiveLimit: 10 }));
    expect(first.page[0]).not.toHaveProperty("email");
    const second = await asBilling.query(listUsage, { paginationOpts: { numItems: 2, cursor: first.continueCursor }, day });
    expect(second.page).toHaveLength(1); expect(second.isDone).toBe(true);
  });
});
