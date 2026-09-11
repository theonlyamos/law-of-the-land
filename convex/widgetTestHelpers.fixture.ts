/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

export type WidgetBackend = TestConvex<typeof schema>;
export function createWidgetBackend() {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const modules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
  t.registerComponent("betterAuth", authSchema, modules);
  return t;
}
export async function addAssuredOrganizationUser(t: WidgetBackend, authRole = "user") {
  const identity = await t.run(async ctx => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Organization user", email: `${crypto.randomUUID()}@example.org`, emailVerified: true, createdAt: now, updatedAt: now, role: authRole, banned: false, twoFactorEnabled: true } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: crypto.randomUUID(), userId: user._id, expiresAt: now + 3600_000, createdAt: now, updatedAt: now, adminTwoFactorVerifiedAt: now } } });
    return { userId: user._id, sessionId: session._id, email: user.email };
  });
  return { ...identity, client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }) };
}
export async function addOrganizationMember(t: WidgetBackend, organizationId: Id<"organizations">, role: "member" | "manager" | "reviewer", authRole = "user") {
  const user = await addAssuredOrganizationUser(t, authRole);
  const membershipId = await t.run(ctx => ctx.db.insert("organizationMemberships", { organizationId, userId: user.userId, role, status: "active", createdAt: Date.now(), updatedAt: Date.now() }));
  return { ...user, membershipId };
}
export async function seedPublicWidget(t: WidgetBackend) {
  return t.run(async ctx => {
    const now = Date.now();
    const stamp = { createdAt: now, updatedAt: now, createdBy: "fixture", updatedBy: "fixture" };
    const organizationId = await ctx.db.insert("organizations", { ...stamp, name: "Greenfield", slug: crypto.randomUUID(), class: "other", status: "active" });
    const storeName = `fileSearchStores/${crypto.randomUUID()}`;
    const jurisdictionId = await ctx.db.insert("jurisdictions", { ...stamp, name: "Greenfield", slug: crypto.randomUUID(), kind: "organizational", organizationId, status: "enabled", visibility: "public", isDefault: false, providerSyncState: "synced", geminiFileSearchStoreName: storeName });
    await ctx.db.insert("organizationalJurisdictions", { jurisdictionId, scopeMode: "global", createdAt: now, updatedAt: now });
    const resourceId = await ctx.db.insert("legalResources", { ...stamp, jurisdictionId, type: "policy", title: "Membership policy", issuer: "Greenfield", officialCitation: "Policy 1", officialCitationKey: "policy 1", sourceUrl: "https://greenfield.example/policy", topics: [], effectiveDate: "2026-01-01", status: "active" });
    const originalStorageId = await ctx.storage.store(new Blob(["fixture policy"]));
    const versionId = await ctx.db.insert("documentVersions", { resourceId, versionNumber: 1, originalStorageId, filename: "policy.txt", mimeType: "text/plain", byteSize: 14, sha256: "0".repeat(64), sourceUrl: "https://greenfield.example/policy", effectiveDate: "2026-01-01", status: "published", geminiDocumentName: `${storeName}/documents/policy1`, submittedBy: "fixture", createdAt: now, updatedAt: now });
    await ctx.db.patch(resourceId, { activeVersionId: versionId });
    await ctx.db.insert("resourceVersionCounters", { resourceId, nextVersionNumber: 2, updatedAt: now });
    const publicId = crypto.randomUUID();
    const widgetId = await ctx.db.insert("jurisdictionWidgets", { jurisdictionId, organizationId, publicId, accessVersion: 0, enabled: true, allowedOrigins: ["https://greenfield.example"], title: "Ask Greenfield", welcomeMessage: "Ask about our published documents.", suggestedQuestions: ["How do I join?"], accent: "#123abc", side: "right", createdAt: now, updatedAt: now, updatedBy: "fixture" });
    await ctx.db.insert("organizationWidgetAllowances", { organizationId, dailyLimit: 100, monthlyLimit: 1000, platformDailyLimit: 100, platformMonthlyLimit: 1000, maxConcurrent: 3, updatedAt: now, updatedBy: "fixture" });
    return { organizationId, jurisdictionId, resourceId, versionId, publicId, widgetId, storeName };
  });
}

export async function seedGeographicWidget(t: WidgetBackend) {
  const f = await seedPublicWidget(t);
  await t.run(async ctx => {
    const profile = await ctx.db.query("organizationalJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", f.jurisdictionId)).unique();
    await ctx.db.delete(profile!._id);
    await ctx.db.patch(f.jurisdictionId, { kind: "geographic", organizationId: undefined });
    await ctx.db.insert("geographicJurisdictions", { jurisdictionId: f.jurisdictionId, googlePlaceId: crypto.randomUUID(), level: "city", latitude: 0, longitude: 0, formattedAddress: "Greenfield", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.patch(f.widgetId, { organizationId: undefined });
    const allowance = await ctx.db.query("organizationWidgetAllowances").withIndex("by_organizationId", q => q.eq("organizationId", f.organizationId)).unique();
    await ctx.db.patch(allowance!._id, { organizationId: undefined, jurisdictionId: f.jurisdictionId });
  });
  return f;
}
