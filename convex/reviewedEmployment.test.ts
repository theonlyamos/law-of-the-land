/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
const authorizeSource = makeFunctionReference<"query">("reviewedEmployment:authorizeSource");
const AS_OF = "2026-10-05";

async function fixture() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  const ids = await t.run(async ctx => {
    const now = Date.now();
    const account = async (name: string) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
        name, email: `${name}@example.com`, emailVerified: true, createdAt: now, updatedAt: now,
        role: "user", banned: false, twoFactorEnabled: false,
      } } });
      const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
        token: crypto.randomUUID(), userId: user._id, expiresAt: now + 86_400_000, createdAt: now, updatedAt: now,
      } } });
      return { subject: user._id, sessionId: session._id };
    };
    const ownerIdentity = await account("employment-owner"), otherIdentity = await account("employment-other");
    await ctx.db.insert("featureFlags", { key: "unified_jurisdictions", environment: "test", enabled: true, updatedAt: now });
    const storeName = "fileSearchStores/employment-fixture";
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "Synthetic employment jurisdiction", slug: "synthetic-employment", status: "enabled", isDefault: false,
      kind: "geographic", visibility: "public", providerSyncState: "synced", geminiFileSearchStoreName: storeName,
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const profileId = await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId, googlePlaceId: "synthetic-employment-place", level: "country", latitude: 0, longitude: 0,
      formattedAddress: "Synthetic employment jurisdiction", createdAt: now, updatedAt: now,
    });
    const original = new TextEncoder().encode("Synthetic original; this is not a legal authority fixture.");
    const expectedSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", original)))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const originalStorageId = await ctx.storage.store(new Blob([original], { type: "application/pdf" }));
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: "Synthetic Act", issuer: "Fixture", officialCitation: "Fixture 651",
      officialCitationKey: "fixture 651", sourceUrl: "https://example.com/fixture", topics: ["employment"],
      status: "active", catalogPublished: true, effectiveDate: "2003-10-08",
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const providerDocumentName = `${storeName}/documents/fixture`;
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 1, originalStorageId, filename: "synthetic.pdf", mimeType: "application/pdf",
      byteSize: original.byteLength, sha256: expectedSha256, sourceUrl: "https://example.com/fixture", status: "published",
      geminiDocumentName: providerDocumentName, submittedBy: "fixture", publishedAt: now, createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(resourceId, { activeVersionId: versionId });
    return { ownerIdentity, otherIdentity, jurisdictionId, profileId, resourceId, versionId, originalStorageId,
      storeName, providerDocumentName, expectedSha256, expectedByteSize: original.byteLength };
  });
  const owner = t.withIdentity(ids.ownerIdentity), other = t.withIdentity(ids.otherIdentity);
  const externalId = "normal-employment-fixture";
  await owner.mutation(api.chats.ensure, { externalId, jurisdictionId: ids.jurisdictionId });
  const args = { externalId, jurisdictionId: ids.jurisdictionId, resourceId: ids.resourceId, versionId: ids.versionId,
    expectedSha256: ids.expectedSha256, expectedByteSize: ids.expectedByteSize, asOfDate: AS_OF };
  return { t, ids, owner, other, args, authorize: () => owner.query(authorizeSource, args) };
}

beforeEach(() => vi.stubEnv("ADMIN_ENVIRONMENT", "test"));
afterEach(() => vi.unstubAllEnvs());

describe("ordinary research source authorization", () => {
  it("requires filter capability for a restricted store while retaining exact reviewed-source authorization", async () => {
    const { t, ids, owner, args } = await fixture();
    await t.run(async ctx => {
      const { _id: _id, _creationTime: _creationTime, ...version } = (await ctx.db.get(ids.versionId))!;
      const failedId = await ctx.db.insert("documentVersions", { ...version, versionNumber: 2, status: "failed", geminiDocumentName: undefined });
      await ctx.db.patch(ids.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [failedId] } });
    });
    expect(await owner.query(authorizeSource, args)).toEqual({ status: "unavailable" });
    expect(await owner.query(authorizeSource, { ...args, publicationFilterProtocol: "published-v1" })).toMatchObject({ status: "authorized" });
  });
  it("authorizes a regular owner with only closed edition metadata", async () => {
    const { ids, args, authorize } = await fixture();
    const result = await authorize();
    expect(result).toEqual({ status: "authorized", externalId: args.externalId, jurisdictionId: ids.jurisdictionId,
      resourceId: ids.resourceId, versionId: ids.versionId, sha256: ids.expectedSha256, byteSize: ids.expectedByteSize,
      asOfDate: AS_OF, resourceEffectiveDate: "2003-10-08", resourceRepealDate: null,
      versionEffectiveDate: null, versionRepealDate: null });
    const serialized = JSON.stringify(result);
    for (const secret of [ids.originalStorageId, ids.storeName, ids.providerDocumentName, "https://", "storageId"])
      expect(serialized).not.toContain(secret);
  });

  it("closes for anonymous users, another real user, and a missing owner session", async () => {
    const { t, other, owner, args } = await fixture();
    await expect(t.query(authorizeSource, args)).resolves.toEqual({ status: "unavailable" });
    await expect(other.query(authorizeSource, args)).resolves.toEqual({ status: "unavailable" });
    await expect(owner.query(authorizeSource, { ...args, externalId: "missing" })).resolves.toEqual({ status: "unavailable" });
  });

  it.each(["catalog unpublished", "resource archived", "version unpublished", "active version replaced",
    "version hash mismatch", "version size mismatch", "resource future", "resource repealed", "version future",
    "version repealed", "malformed date", "lifecycle lock", "expired lifecycle lock", "store not ready",
    "provider document moved", "duplicate store owner", "jurisdiction archived", "access revoked",
    "invalid research scope", "selected jurisdiction changed", "original deleted", "original replaced"] as const)(
    "rechecks %s after a previously successful grant", async change => {
      const { t, ids, authorize } = await fixture();
      expect(await authorize()).toMatchObject({ status: "authorized" });
      await t.run(async ctx => {
        switch (change) {
          case "catalog unpublished": await ctx.db.patch(ids.resourceId, { catalogPublished: false }); break;
          case "resource archived": await ctx.db.patch(ids.resourceId, { status: "archived" }); break;
          case "version unpublished": await ctx.db.patch(ids.versionId, { status: "unpublished" }); break;
          case "active version replaced": await ctx.db.patch(ids.resourceId, { activeVersionId: undefined }); break;
          case "version hash mismatch": await ctx.db.patch(ids.versionId, { sha256: "a".repeat(64) }); break;
          case "version size mismatch": await ctx.db.patch(ids.versionId, { byteSize: ids.expectedByteSize + 1 }); break;
          case "resource future": await ctx.db.patch(ids.resourceId, { effectiveDate: "2026-10-06" }); break;
          case "resource repealed": await ctx.db.patch(ids.resourceId, { repealDate: AS_OF }); break;
          case "version future": await ctx.db.patch(ids.versionId, { effectiveDate: "2026-10-06" }); break;
          case "version repealed": await ctx.db.patch(ids.versionId, { repealDate: AS_OF }); break;
          case "malformed date": await ctx.db.patch(ids.versionId, { effectiveDate: "2026-02-30" }); break;
          case "lifecycle lock": case "expired lifecycle lock": await ctx.db.insert("documentLifecycleLocks", {
            jurisdictionId: ids.jurisdictionId, resourceId: ids.resourceId, versionId: ids.versionId, operation: "unpublish",
            actorId: "fixture", idempotencyKey: "fixture-lock", expiresAt: change === "lifecycle lock" ? Date.now() + 60_000 : 0,
            createdAt: 0, updatedAt: 0,
          }); break;
          case "store not ready": await ctx.db.patch(ids.jurisdictionId, { providerSyncState: "pending" }); break;
          case "provider document moved": await ctx.db.patch(ids.versionId, { geminiDocumentName: "fileSearchStores/other/documents/fixture" }); break;
          case "duplicate store owner": {
            const row = (await ctx.db.get(ids.jurisdictionId))!;
            const { _id: _id, _creationTime: _created, ...fields } = row;
            await ctx.db.insert("jurisdictions", { ...fields, slug: "duplicate" }); break;
          }
          case "jurisdiction archived": await ctx.db.patch(ids.jurisdictionId, { status: "archived" }); break;
          case "access revoked": await ctx.db.patch(ids.jurisdictionId, { visibility: "members" }); break;
          case "invalid research scope": await ctx.db.delete(ids.profileId); break;
          case "selected jurisdiction changed": {
            const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
              q.eq("userId", ids.ownerIdentity.subject).eq("externalId", "normal-employment-fixture")).unique();
            await ctx.db.patch(session!._id, { jurisdictionId: undefined }); break;
          }
          case "original deleted": await ctx.storage.delete(ids.originalStorageId); break;
          case "original replaced": {
            const swapped = await ctx.storage.store(new Blob(["x".repeat(ids.expectedByteSize)], { type: "application/pdf" }));
            await ctx.db.patch(ids.versionId, { originalStorageId: swapped }); break;
          }
        }
      });
      await expect(authorize()).resolves.toEqual({ status: "unavailable" });
    },
  );

  it.each([{ asOfDate: "2026-02-30" }, { asOfDate: "2026-1-1" }, { expectedSha256: "x".repeat(65) },
    { expectedByteSize: 1.5 }, { expectedByteSize: -1 }, { externalId: "x".repeat(257) }, { externalId: " " }])(
    "closes malformed bounded inputs %j", async patch => {
      const { owner, args } = await fixture();
      await expect(owner.query(authorizeSource, { ...args, ...patch })).resolves.toEqual({ status: "unavailable" });
    },
  );
});
