import { afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import authSchema from "./betterAuth/schema";
import { api, components } from "./_generated/api";
import type { FunctionReturnType } from "convex/server";
import { listMessages } from "./chats";
import type { QueryCtx } from "./_generated/server";
import { seedGeographicWidget, addAssuredOrganizationUser } from "./widgetTestHelpers.fixture";

const reviewedPolicy = vi.hoisted(() => ({ jurisdictionId: "", resourceId: "", versionId: "", expectedSha256: "", expectedByteSize: 0 }));
vi.mock("../shared/reviewed-employment-policy", async importOriginal => {
  const actual = await importOriginal<typeof import("../shared/reviewed-employment-policy")>();
  return { ...actual, reviewedEmploymentBackendPolicy: () => reviewedPolicy };
});

afterEach(() => vi.unstubAllEnvs());

async function fixture(published = 1, drafts = 0, messageCount = 1, citationCount = 1, attachments = false) {
  vi.stubEnv("ADMIN_ENVIRONMENT", "production");
  const t = convexTest({ schema, modules: import.meta.glob("./**/*.ts"), transactionLimits: { databaseQueries: 4096 } });
  t.registerComponent("betterAuth", authSchema, Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load])));
  const f = await seedGeographicWidget(t), user = await addAssuredOrganizationUser(t);
  await t.run(async ctx => {
    const { _id: _r, _creationTime: _rc, ...resource } = (await ctx.db.get(f.resourceId))!;
    const { _id: _v, _creationTime: _vc, ...version } = (await ctx.db.get(f.versionId))!;
    const pdf = new Blob(["%PDF-1.4 capacity fixture"], { type: "application/pdf" });
    const originalStorageId = await ctx.storage.store(pdf);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
    const sources = [];
    for (let index = 0; index < published; index++) {
      const resourceId = index === 0 ? f.resourceId : await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined });
      const data = { ...version, resourceId, originalStorageId, sha256, byteSize: pdf.size, filename: "source.pdf", mimeType: "application/pdf", geminiDocumentName: `${f.storeName}/documents/capacity${index}` };
      const versionId = index === 0 ? f.versionId : await ctx.db.insert("documentVersions", data);
      if (index === 0) await ctx.db.patch(versionId, data);
      await ctx.db.patch(resourceId, { activeVersionId: versionId, catalogPublished: true });
      sources.push({ jurisdictionId: f.jurisdictionId, resourceId, versionId, providerStoreName: f.storeName, providerDocumentName: data.geminiDocumentName, expectedSha256: sha256, expectedByteSize: pdf.size, pageNumber: 1 });
      if (index < drafts) {
        const draftId = await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined, catalogPublished: false });
        await ctx.db.insert("documentVersions", { ...version, resourceId: draftId, status: "draft", geminiDocumentName: undefined });
      }
    }
    const sessionId = await ctx.db.insert("chatSessions", { userId: user.userId, externalId: "capacity", title: "History", lastMessage: "", messageCount: 50, updatedAt: Date.now(), jurisdictionId: f.jurisdictionId, jurisdictionName: "Greenfield", jurisdictionKind: "geographic", jurisdictionContract: "unified" });
    for (let index = 0; index < messageCount; index++) {
      const citationProvenance = sources.slice(index * citationCount, index * citationCount + citationCount);
      const attachmentIds = attachments ? await Promise.all(Array.from({ length: 5 }, (_, offset) => ctx.db.insert("chatAttachments", { sessionId, userId: user.userId, filename: `attachment-${index}-${offset}.txt`, mimeType: "text/plain", byteSize: 1, kind: "text", status: "ready", createdAt: Date.now() }))) : undefined;
      await ctx.db.insert("messages", { sessionId, clientId: `assistant-${index}`, attachmentIds, role: "assistant", content: `Preserved answer ${index}`, createdAt: index, answerKind: "legal", citationProvenance, citations: citationProvenance.map(() => ({ label: "Membership policy", jurisdictionId: f.jurisdictionId, jurisdictionName: "Greenfield", jurisdictionKind: "geographic" as const, relation: "selected" as const })) });
    }
  });
  return { t, f, user };
}

async function measuredHistory(user: Awaited<ReturnType<typeof fixture>>["user"]) {
  return await user.client.run(async ctx => {
    const query = vi.spyOn(ctx.db, "query"), get = vi.spyOn(ctx.db, "get"), system = vi.spyOn(ctx.db.system, "get"), nested = vi.spyOn(ctx, "runQuery");
    try {
      const handler = (listMessages as unknown as { _handler: (ctx: QueryCtx, args: { externalId: string; paginationOpts: { numItems: number; cursor: null } }) => Promise<FunctionReturnType<typeof api.chats.listMessages>> })._handler;
      const page = await handler(ctx as QueryCtx, { externalId: "capacity", paginationOpts: { numItems: 50, cursor: null } });
      return { page, reads: query.mock.calls.length + get.mock.calls.length + system.mock.calls.length, nestedQueries: nested.mock.calls.length };
    } finally { query.mockRestore(); get.mockRestore(); system.mockRestore(); nested.mockRestore(); }
  });
}

it("bounds full history reads with 900 published, 900 drafts and 800 citation previews", async () => {
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "test-only-capacity-secret-longer-than-32-bytes");
  const { user } = await fixture(900, 900, 50, 16, true);
  const result = await measuredHistory(user);
  // BetterAuth findOne predicates here all use unique _id, whose adapter path
  // performs one get (no joins). Count those child reads as well as root reads.
  expect(result.reads + result.nestedQueries).toBeLessThan(4096);
  expect(result.reads + 8 * result.nestedQueries).toBeLessThanOrEqual(4000);
  const grants = result.page.page.flatMap(message => message.originalSourceUrls ?? []);
  expect(grants.some(Boolean)).toBe(true);
  expect(grants.some(url => !url)).toBe(true);
  expect(result.page.page).toHaveLength(50);
  expect(result.page.page.every(message => message.attachments?.length === 5)).toBe(true);
  expect(result.page.page.map((message) => message.content)).toEqual(Array.from({ length: 50 }, (_, i) => `Preserved answer ${i}`));
  expect(result.page.page.every((message) => message.citations?.length === 16)).toBe(true);
}, 60_000);


it("keeps valid preview grants for small histories", async () => {
  const { user } = await fixture();
  const result = await measuredHistory(user);
  expect(result.page.page[0].originalSourceUrls?.[0]).toContain("/api/chat/sources/");
  expect(result.page.page[0].citationPreviews).toEqual([{ pageNumber: 1 }]);
});

it.each(["withdrawn", "expired lock", "out of scope", "invalid PDF hash"] as const)("denies %s previews without removing history", async state => {
  const { t, f, user } = await fixture();
  await t.run(async ctx => {
    if (state === "withdrawn") await ctx.db.patch(f.versionId, { status: "unpublished" });
    if (state === "expired lock") await ctx.db.insert("documentLifecycleLocks", { resourceId: f.resourceId, versionId: f.versionId, jurisdictionId: f.jurisdictionId, operation: "unpublish", actorId: "fixture", idempotencyKey: "expired", expiresAt: Date.now() - 1000, createdAt: Date.now() - 2000, updatedAt: Date.now() - 2000 });
    if (state === "out of scope" || state === "invalid PDF hash") {
      const message = (await ctx.db.query("messages").first())!;
      const source = message.citationProvenance![0];
      await ctx.db.patch(message._id, { citationProvenance: [{ ...source, ...(state === "out of scope" ? { providerStoreName: "fileSearchStores/foreign" } : { expectedSha256: "f".repeat(64) }) }] });
    }
  });
  const result = await measuredHistory(user);
  expect(result.page.page[0].content).toBe("Preserved answer 0");
  expect(result.page.page[0].citations).toHaveLength(1);
  expect(result.page.page[0].originalSourceUrls).toEqual([""]);
  expect(result.page.page[0].citationPreviews).toEqual([{}]);
});

it("does not share request caches across users or publication changes", async () => {
  const { t, f, user } = await fixture();
  expect((await measuredHistory(user)).page.page[0].originalSourceUrls?.[0]).toBeTruthy();
  const other = await addAssuredOrganizationUser(t);
  expect((await measuredHistory(other)).page.page).toEqual([]);
  await t.run(ctx => ctx.db.patch(f.resourceId, { catalogPublished: false }));
  expect((await measuredHistory(user)).page.page[0].originalSourceUrls).toEqual([""]);
  expect(await t.query(api.chats.listMessages, { externalId: "capacity", paginationOpts: { numItems: 50, cursor: null } })).toEqual({ page: [], isDone: true, continueCursor: "" });
});


it("does not grant previews to expired native sessions", async () => {
  const { t, user } = await fixture();
  await t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", value: user.sessionId }], update: { expiresAt: Date.now() - 1 } } }));
  const result = await measuredHistory(user);
  expect(result.page.page.flatMap(message => message.originalSourceUrls ?? []).some(Boolean)).toBe(false);
});


it("shares the same budget across mixed reviewed and governed history without repeated auth queries", async () => {
  const { t, f, user } = await fixture(900, 900, 50, 16);
  await t.run(async ctx => {
    const version = (await ctx.db.get(f.versionId))!;
    Object.assign(reviewedPolicy, { jurisdictionId: f.jurisdictionId, resourceId: f.resourceId, versionId: f.versionId, expectedSha256: version.sha256, expectedByteSize: version.byteSize });
    const messages = await ctx.db.query("messages").collect();
    for (const message of messages.filter(message => message.createdAt % 2 === 0)) {
      await ctx.db.patch(message._id, { citationProvenance: undefined, reviewedOriginalSource: { ...reviewedPolicy, jurisdictionId: f.jurisdictionId, resourceId: f.resourceId, versionId: f.versionId, pageNumbers: [18] }, citations: message.citations!.slice(0, 1) });
    }
  });
  const result = await measuredHistory(user);
  expect(result.reads + 8 * result.nestedQueries).toBeLessThanOrEqual(4000);
  expect(result.reads + result.nestedQueries).toBeLessThan(4096);
  expect(result.page.page).toHaveLength(50);
  expect(result.page.page[0].originalSourceUrls?.[0]).toContain("#page=18");
  expect(result.page.page[1].originalSourceUrls?.some(Boolean)).toBe(true);
  expect(result.page.page.flatMap(message => message.originalSourceUrls ?? []).some(url => !url)).toBe(true);
}, 60_000);
