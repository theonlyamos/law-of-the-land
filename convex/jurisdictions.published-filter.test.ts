import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { createWidgetBackend, seedGeographicWidget, addAssuredOrganizationUser } from "./widgetTestHelpers.fixture";
import { readyStoreName } from "./jurisdictions";
import { MAX_PUBLISHED_FILTER_DOCUMENTS } from "../shared/gemini-publication-filter";

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

it("rejects a catalogue beyond the complete published-filter bound instead of truncating it", async () => {
  const { t, f, user } = await fixture();
  await t.run(async ctx => {
    const resource = (await ctx.db.get(f.resourceId))!, version = (await ctx.db.get(f.versionId))!;
    const { _id: resourceId, _creationTime: resourceTime, ...resourceFields } = resource;
    const { _id: versionId, _creationTime: versionTime, ...versionFields } = version;
    for (let index = 1; index <= MAX_PUBLISHED_FILTER_DOCUMENTS; index++) {
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

it("lists every catalogue version that may be in the store but is not published as an exclusion", async () => {
  const { t, f, user, failed } = await fixture();
  const ids = await t.run(async ctx => {
    const version = (await ctx.db.get(f.versionId))!;
    const { _id: vid, _creationTime: vc, ...versionFields } = version;
    // An older version of the published resource that once had a provider document.
    const superseded = await ctx.db.insert("documentVersions", { ...versionFields, versionNumber: 0, status: "superseded",
      geminiDocumentName: `${f.storeName}/documents/old` });
    // A draft that never left the app is not in the store and is not listed.
    const draft = await ctx.db.insert("documentVersions", { ...versionFields, resourceId: failed.resourceId, versionNumber: 3, status: "draft",
      geminiDocumentName: undefined });
    return { superseded, draft };
  });
  const result = await user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" });
  const excluded = result.stores[0].publicationFilter.excludedVersionIds;
  expect(excluded).toEqual([failed.versionId, ids.superseded].sort());
  expect(excluded).not.toContain(ids.draft);
  expect(excluded).not.toContain(f.versionId);
});

it("omits the exclusion list when a resource's version history is too long to account for", async () => {
  const { t, f, user } = await fixture();
  await t.run(async ctx => {
    const version = (await ctx.db.get(f.versionId))!;
    const { _id: vid, _creationTime: vc, ...versionFields } = version;
    for (let index = 0; index < 16; index++) {
      await ctx.db.insert("documentVersions", { ...versionFields, versionNumber: 100 + index, status: "superseded", geminiDocumentName: undefined });
    }
  });
  const result = await user.client.query(resolve, { jurisdictionId: f.jurisdictionId, publicationFilterProtocol: "published-v1" });
  // The published version is still found exactly; only the exclusion form is withheld.
  expect(result.stores[0].publicationFilter.documents).toEqual([{ resourceId: f.resourceId, versionId: f.versionId, sha256: "0".repeat(64) }]);
  expect(result.stores[0].publicationFilter).not.toHaveProperty("excludedVersionIds");
});
