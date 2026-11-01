import { convexTest } from "convex-test";
import schema from "./schema";
import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { MutationCtx } from "./_generated/server";
import { createSession as guestCreate } from "./guestResearch";
import { createSession as widgetCreate } from "./widgetRuntime";
import { createWidgetBackend, seedGeographicWidget } from "./widgetTestHelpers.fixture";

afterEach(() => vi.unstubAllEnvs());
async function fixture(published: number, drafts: number) {
  vi.stubEnv("GUEST_RESEARCH_ENABLED", "true");
  vi.stubEnv("WIDGET_CHAT_ENABLED", "true");
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = convexTest({ schema, modules: import.meta.glob("./**/*.ts"), transactionLimits: { databaseQueries: 4096 } }), f = await seedGeographicWidget(t);
  await t.run(async ctx => {
    const { _id: _r, _creationTime: _rc, ...resource } = (await ctx.db.get(f.resourceId))!;
    const { _id: _v, _creationTime: _vc, ...version } = (await ctx.db.get(f.versionId))!;
    for (let i = 1; i < published; i++) {
      const resourceId = await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined });
      const versionId = await ctx.db.insert("documentVersions", { ...version, resourceId, geminiDocumentName: `${f.storeName}/documents/capacity${i}` });
      await ctx.db.patch(resourceId, { activeVersionId: versionId });
    }
    for (let i = 0; i < drafts; i++) {
      const resourceId = await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined, catalogPublished: false });
      await ctx.db.insert("documentVersions", { ...version, resourceId, status: "draft", geminiDocumentName: undefined });
    }
  });
  return { t, f };
}
async function measured<T>(t: ReturnType<typeof createWidgetBackend>, handler: (ctx: MutationCtx) => Promise<T>) {
  return t.run(async ctx => {
    const query = vi.spyOn(ctx.db, "query"), get = vi.spyOn(ctx.db, "get");
    try { const result = await handler(ctx as MutationCtx); return { result, reads: query.mock.calls.length + get.mock.calls.length }; }
    finally { query.mockRestore(); get.mockRestore(); }
  });
}
it("creates a capable guest session with 900 published and 900 drafts below the transaction read limit", async () => {
  const { t, f } = await fixture(900, 900);
  const args = { tokenHash: "a".repeat(43), jurisdictionId: f.jurisdictionId, ipKey: "capacity", publicationFilterProtocol: "published-v1" as const };
  const handler = (guestCreate as unknown as { _handler: (ctx: MutationCtx, input: typeof args) => Promise<unknown> })._handler;
  const { result, reads } = await measured(t, ctx => handler(ctx, args));
  expect(result).toMatchObject({ remaining: 2, turns: [] });
  expect(reads).toBeLessThan(4096);
});
it("reuses an existing widget session at 1024 published documents below the transaction read limit", async () => {
  const { t, f } = await fixture(1024, 0);
  const args = { tokenHash: "b".repeat(43), publicId: f.publicId, parentOrigin: "https://greenfield.example", ipKey: "capacity" };
  await t.mutation(makeFunctionReference<"mutation">("widgetRuntime:createSession"), args);
  const handler = (widgetCreate as unknown as { _handler: (ctx: MutationCtx, input: typeof args) => Promise<unknown> })._handler;
  const { result, reads } = await measured(t, ctx => handler(ctx, args));
  expect(result).toHaveProperty("expiresAt");
  expect(reads).toBeLessThan(4096);
});

it.each(["expired", "deleted", "revoked", "origin", "widget", "access", "revision", "disabled", "withdrawn", "lock"] as const)("rechecks existing widget session %s boundaries on each invocation", async state => {
  const { t, f } = await fixture(1, 0);
  const ref = makeFunctionReference<"mutation">("widgetRuntime:createSession");
  const args = { tokenHash: "c".repeat(43), publicId: f.publicId, parentOrigin: "https://greenfield.example", ipKey: "boundary" };
  expect(await t.mutation(ref, args)).toHaveProperty("expiresAt");
  await t.run(async ctx => {
    const session = (await ctx.db.query("widgetSessions").unique())!;
    if (state === "expired") await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
    if (state === "deleted") await ctx.db.patch(session._id, { deleteAfter: Date.now() - 1 });
    if (state === "revoked") await ctx.db.patch(session._id, { revokedAt: Date.now() });
    if (state === "origin") await ctx.db.patch(session._id, { parentOrigin: "https://other.example" });
    if (state === "widget") { const { _id, _creationTime, ...widget } = (await ctx.db.get(f.widgetId))!; const other = await ctx.db.insert("jurisdictionWidgets", { ...widget, publicId: "other" }); await ctx.db.patch(session._id, { widgetId: other }); }
    if (state === "access") await ctx.db.patch(f.widgetId, { accessVersion: 1 });
    if (state === "revision") await ctx.db.patch(f.jurisdictionId, { contentRevision: 1 });
    if (state === "disabled") await ctx.db.patch(f.widgetId, { enabled: false });
    if (state === "withdrawn") await ctx.db.patch(f.versionId, { status: "unpublished" });
    if (state === "lock") await ctx.db.insert("documentLifecycleLocks", { resourceId: f.resourceId, versionId: f.versionId, jurisdictionId: f.jurisdictionId, operation: "unpublish", actorId: "fixture", idempotencyKey: "expired", expiresAt: Date.now() - 1, createdAt: Date.now(), updatedAt: Date.now() });
  });
  const expected = ["expired", "deleted"].includes(state) ? "SESSION_EXPIRED" : ["revoked", "origin", "widget"].includes(state) ? "SESSION_INVALID" : ["access", "revision"].includes(state) ? "LIBRARY_CHANGED" : "WIDGET_UNAVAILABLE";
  expect(await t.mutation(ref, args)).toMatchObject({ error: { code: expected } });
});

it.each(["hash", "withdrawn", "private", "expired"] as const)("refreshes capable guest authority across requests after %s changes", async state => {
  const { t, f } = await fixture(1, 0);
  const ref = makeFunctionReference<"mutation">("guestResearch:createSession");
  const args = { tokenHash: "d".repeat(43), jurisdictionId: f.jurisdictionId, ipKey: "boundary", publicationFilterProtocol: "published-v1" as const };
  expect(await t.mutation(ref, args)).toMatchObject({ remaining: 2 });
  await t.run(async ctx => {
    if (state === "hash") await ctx.db.patch(f.versionId, { sha256: "f".repeat(64) });
    if (state === "withdrawn") await ctx.db.patch(f.versionId, { status: "unpublished" });
    if (state === "private") await ctx.db.patch(f.jurisdictionId, { visibility: "members" });
    if (state === "expired") await ctx.db.patch((await ctx.db.query("guestResearchSessions").unique())!._id, { expiresAt: Date.now() - 1 });
  });
  expect(await t.mutation(ref, args)).toHaveProperty("error");
});
