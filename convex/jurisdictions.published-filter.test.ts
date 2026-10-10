import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { createWidgetBackend, seedGeographicWidget, addAssuredOrganizationUser } from "./widgetTestHelpers.fixture";
import { readyStoreName } from "./jurisdictions";

const resolve = makeFunctionReference<"query">("jurisdictions:resolveChatResearchStores");
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  vi.stubEnv("ADMIN_ENVIRONMENT", "production");
  const t = createWidgetBackend(), f = await seedGeographicWidget(t), user = await addAssuredOrganizationUser(t);
  const failed = await t.run(async ctx => {
    const resource = (await ctx.db.get(f.resourceId))!, version = (await ctx.db.get(f.versionId))!;
    const { _id: rid, _creationTime: rc, ...resourceFields } = resource;
    const resourceId = await ctx.db.insert("legalResources", { ...resourceFields, title: "Failed document", activeVersionId: undefined, catalogPublished: false });
    const { _id: vid, _creationTime: vc, ...versionFields } = version;
    const versionId = await ctx.db.insert("documentVersions", { ...versionFields, resourceId, status: "failed", geminiDocumentName: undefined });
    await ctx.db.patch(f.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [versionId] } });
    return { resourceId, versionId };
  });
  return { t, f, user, failed };
}

it("denies a restricted store to legacy clients and manually constructed embed stores", async () => {
  const { t, f, user } = await fixture();
  expect(await t.run(ctx => readyStoreName(ctx, f.jurisdictionId))).toBeNull();
  await expect(user.client.query(resolve, { jurisdictionId: f.jurisdictionId })).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});

it("derives a fresh exact allowlist and leaves failed documents excluded after a provider-only activation", async () => {
  const { t, f, user, failed } = await fixture();
  const result = await user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" });
  expect(result.stores[0]).toMatchObject({ publicationFilter: { protocol: "published-v1", environment: "production", documents: [
    { resourceId: f.resourceId, versionId: f.versionId, sha256: "0".repeat(64) },
  ] } });
  // Provider activation alone never publishes an app version or grants retrieval.
  await t.run(ctx => ctx.db.patch(failed.versionId, { geminiDocumentName: `${f.storeName}/documents/failed-now-active` }));
  expect((await user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" })).stores).toEqual(result.stores);
  await t.run(ctx => ctx.db.patch(f.versionId, { sha256: "1".repeat(64) }));
  expect((await user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" })).stores[0].publicationFilter.documents[0].sha256).toBe("1".repeat(64));
});

it.each(["empty", "invalid sha", "foreign store", "failed marked published", "unknown environment"])("fails closed for invalid restricted coverage: %s", async scenario => {
  const { t, f, user, failed } = await fixture();
  await t.run(async ctx => {
    if (scenario === "empty") await ctx.db.patch(f.resourceId, { catalogPublished: false });
    if (scenario === "invalid sha") await ctx.db.patch(f.versionId, { sha256: "invalid" });
    if (scenario === "foreign store") await ctx.db.patch(f.versionId, { geminiDocumentName: "fileSearchStores/foreign/documents/law" });
    if (scenario === "failed marked published") {
      await ctx.db.patch(failed.versionId, { status: "published", geminiDocumentName: `${f.storeName}/documents/failed` });
      await ctx.db.patch(failed.resourceId, { catalogPublished: true, activeVersionId: failed.versionId });
    }
  });
  if (scenario === "unknown environment") vi.stubEnv("ADMIN_ENVIRONMENT", "unsafe environment");
  await expect(user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" })).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});

it("rejects a truncated catalogue rather than searching only the first 64 documents", async () => {
  const { t, f, user } = await fixture();
  await t.run(async ctx => {
    const resource = (await ctx.db.get(f.resourceId))!, version = (await ctx.db.get(f.versionId))!;
    const { _id: resourceId, _creationTime: resourceTime, ...resourceFields } = resource;
    const { _id: versionId, _creationTime: versionTime, ...versionFields } = version;
    for (let index = 1; index <= 64; index++) {
      const nextResourceId = await ctx.db.insert("legalResources", { ...resourceFields, title: `Published ${index}`, activeVersionId: undefined });
      const nextVersionId = await ctx.db.insert("documentVersions", { ...versionFields, resourceId: nextResourceId, geminiDocumentName: `${f.storeName}/documents/law${index}` });
      await ctx.db.patch(nextResourceId, { activeVersionId: nextVersionId });
    }
  });
  await expect(user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" })).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});

it("retains the search gate while a published resource has a lifecycle lock", async () => {
  const { t, f, user } = await fixture();
  await t.run(ctx => ctx.db.insert("documentLifecycleLocks", { resourceId: f.resourceId, versionId: f.versionId,
    jurisdictionId: f.jurisdictionId, actorId: "fixture", operation: "unpublish", idempotencyKey: "fixture-lock", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 1000 }));
  await expect(user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" })).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});

it("requires the explicit protocol on private manifest requests", async () => {
  const { f, user } = await fixture();
  const post = (body: unknown) => user.client.fetch("/private/chat-research-manifest", { method: "POST", body: JSON.stringify(body) });
  expect((await post({ jurisdictionId: f.jurisdictionId })).status).toBe(503);
  const response = await post({ jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" });
  expect(response.status).toBe(200);
  expect((await response.json()).stores[0].publicationFilter.documents).toHaveLength(1);
  expect((await post({ jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "unknown" })).status).toBe(400);
});
