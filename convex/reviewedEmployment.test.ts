/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import { createTelemetryServiceProof } from "./lib/telemetryProof";
import { citationFileProofParts } from "../shared/citation-source-preview";

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

beforeEach(() => { vi.stubEnv("ADMIN_ENVIRONMENT", "test"); vi.stubEnv("TELEMETRY_INGEST_SECRET", "source-file-tests-secret-at-least-32-characters"); });
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

const resolveGeneralCitationFile = makeFunctionReference<"action">("chatSources:resolveCitationFile");
async function signGeneralSourceArgs<T extends { externalId: string; messageId: string; citationIndex: number }>(value: T) {
  const input = { ...value, expiresAt: Date.now() + 60_000 };
  return { ...input, serviceProof: await createTelemetryServiceProof(citationFileProofParts(input)) };
}
async function savedGeneralCitation() {
  const f = await fixture();
  const messageId = await f.t.run(async ctx => {
    const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
      q.eq("userId", f.ids.ownerIdentity.subject).eq("externalId", f.args.externalId)).unique();
    return await ctx.db.insert("messages", { sessionId: session!._id, role: "assistant", content: "Verified synthetic answer.",
      answerKind: "legal", createdAt: Date.now(), citations: [{ label: "Synthetic Act, page 7", jurisdictionId: f.ids.jurisdictionId,
        jurisdictionName: "Synthetic employment jurisdiction", jurisdictionKind: "geographic", relation: "selected" }],
      citationProvenance: [{ jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId,
        providerStoreName: f.ids.storeName, providerDocumentName: f.ids.providerDocumentName, pageNumber: 7,
        expectedSha256: f.ids.expectedSha256, expectedByteSize: f.ids.expectedByteSize,
        passages: [{ pageNumber: 7, quote: "Verified original excerpt." }] }] });
  });
  const args = { externalId: f.args.externalId, messageId, citationIndex: 0, expiresAt: Date.now() + 60_000 };
  return { ...f, messageId, sourceArgs: { ...args, serviceProof: await createTelemetryServiceProof(citationFileProofParts(args)) } };
}

describe("general saved citation originals", () => {
  it("rechecks account eligibility inside the atomic general-source query", async () => {
    const f = await savedGeneralCitation();
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "user",
      where: [{ field: "_id", value: f.ids.ownerIdentity.subject }], update: { banned: true } } }));
    const { expiresAt: _expiry, serviceProof: _proof, ...args } = f.sourceArgs;
    expect(await f.owner.query(makeFunctionReference<"query">("chatSources:resolveCitationFileInternal"), args)).toBeNull();
  });

  it("does not expose a storage bearer URL to direct browser callers without the proxy proof", async () => {
    const f = await savedGeneralCitation();
    const { expiresAt: _expiresAt, serviceProof: _proof, ...args } = f.sourceArgs;
    expect(await f.owner.action(resolveGeneralCitationFile, args)).toBeNull();
  });
  it.each(["malformed", "expired", "future", "message", "index", "chat"] as const)("rejects %s proxy proofs", async change => {
    const f = await savedGeneralCitation();
    expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).not.toBeNull();
    const args = { ...f.sourceArgs };
    if (change === "malformed") args.serviceProof = "x".repeat(43);
    if (change === "message") {
      args.messageId = await f.t.run(async ctx => { const row = (await ctx.db.get(f.messageId))!;
        const { _id: _id, _creationTime: _time, ...values } = row; return ctx.db.insert("messages", values); });
    }
    if (change === "index") args.citationIndex = 1;
    if (change === "chat") args.externalId = "another-chat";
    if (change === "expired" || change === "future") {
      args.expiresAt = Date.now() + (change === "expired" ? -1 : 120_000);
      args.serviceProof = await createTelemetryServiceProof(citationFileProofParts(args));
    }
    expect(await f.owner.action(resolveGeneralCitationFile, args)).toBeNull();
  });

  it("revokes an original and its excerpt when the owner's organization membership is revoked", async () => {
    const f = await savedGeneralCitation();
    const membershipId = await f.t.run(async ctx => {
      const now = Date.now(), organizationId = await ctx.db.insert("organizations", { name: "Fixture organization", slug: "fixture-org",
        class: "company", status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
      const membership = await ctx.db.insert("organizationMemberships", { organizationId, userId: f.ids.ownerIdentity.subject,
        status: "active", role: "member", createdAt: now, updatedAt: now });
      await ctx.db.patch(f.ids.jurisdictionId, { kind: "organizational", visibility: "members", organizationId });
      await ctx.db.delete(f.ids.profileId);
      await ctx.db.insert("organizationalJurisdictions", { jurisdictionId: f.ids.jurisdictionId, scopeMode: "global", createdAt: now, updatedAt: now });
      const message = (await ctx.db.get(f.messageId))!;
      await ctx.db.patch(message.sessionId, { jurisdictionKind: "organizational" });
      await ctx.db.patch(f.messageId, { citations: message.citations!.map(citation => ({ ...citation, jurisdictionKind: "organizational" as const })) });
      return membership;
    });
    expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).not.toBeNull();
    await f.t.run(ctx => ctx.db.patch(membershipId, { status: "inactive" }));
    expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).toBeNull();
    const messages = await f.owner.query(api.chats.listMessages, { externalId: f.args.externalId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(JSON.stringify(messages)).not.toContain("Verified original excerpt.");
  });

  it.each(["publication withdrawn", "ancestor unlinked"] as const)("revokes an ancestor source when %s", async change => {
    const f = await savedGeneralCitation();
    await f.t.run(async ctx => {
      const now = Date.now(), common = (await ctx.db.get(f.ids.jurisdictionId))!;
      const { _id: _id, _creationTime: _time, ...commonFields } = common;
      const parentStore = "fileSearchStores/ancestor-source", parentDocument = `${parentStore}/documents/fixture`;
      const parentId = await ctx.db.insert("jurisdictions", { ...commonFields, name: "Parent jurisdiction", slug: "parent-jurisdiction",
        geminiFileSearchStoreName: parentStore });
      const parentProfileId = await ctx.db.insert("geographicJurisdictions", { jurisdictionId: parentId, googlePlaceId: "parent-place",
        level: "country", latitude: 0, longitude: 0, formattedAddress: "Parent jurisdiction", createdAt: now, updatedAt: now });
      await ctx.db.patch(f.ids.profileId, { level: "city", parentJurisdictionId: parentId });
      const originalResource = (await ctx.db.get(f.ids.resourceId))!, originalVersion = (await ctx.db.get(f.ids.versionId))!;
      const { _id: _resourceId, _creationTime: _resourceTime, ...resourceFields } = originalResource;
      const { _id: _versionId, _creationTime: _versionTime, ...versionFields } = originalVersion;
      const selectedResource = await ctx.db.insert("legalResources", { ...resourceFields, activeVersionId: undefined,
        title: "Selected law", officialCitation: "Selected law", officialCitationKey: "selected law" });
      const selectedVersion = await ctx.db.insert("documentVersions", { ...versionFields, resourceId: selectedResource,
        geminiDocumentName: `${f.ids.storeName}/documents/selected-law` });
      await ctx.db.patch(selectedResource, { activeVersionId: selectedVersion });
      await ctx.db.patch(f.ids.resourceId, { jurisdictionId: parentId });
      await ctx.db.patch(f.ids.versionId, { geminiDocumentName: parentDocument });
      const message = (await ctx.db.get(f.messageId))!;
      await ctx.db.patch(f.messageId, { citations: message.citations!.map(citation => ({ ...citation,
        jurisdictionId: parentId, jurisdictionName: "Parent jurisdiction", relation: "geographic_ancestor" as const })),
        citationProvenance: message.citationProvenance!.map(source => ({ ...source, jurisdictionId: parentId,
          providerStoreName: parentStore, providerDocumentName: parentDocument })) });
      expect(parentProfileId).toBeTruthy();
    });
    expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).not.toBeNull();
    await f.t.run(ctx => change === "publication withdrawn" ? ctx.db.patch(f.ids.resourceId, { catalogPublished: false })
      : ctx.db.patch(f.ids.profileId, { parentJurisdictionId: undefined }));
    expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).toBeNull();
    const messages = await f.owner.query(api.chats.listMessages, { externalId: f.args.externalId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(JSON.stringify(messages)).not.toContain("Verified original excerpt.");
  });

  it("authorizes arbitrary stored citation pages for the owner and projects only bounded public preview data", async () => {
    const f = await savedGeneralCitation();
    const file = await f.owner.action(resolveGeneralCitationFile, f.sourceArgs);
    expect(file).toMatchObject({ filename: "synthetic.pdf", mimeType: "application/pdf", byteSize: f.ids.expectedByteSize });
    expect(file.url).toMatch(/\/api\/storage\//);
    const messages = await f.owner.query(api.chats.listMessages, { externalId: f.args.externalId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(messages.page[0]).toMatchObject({ citationPreviews: [{ pageNumber: 7,
      passages: [{ pageNumber: 7, quote: "Verified original excerpt." }] }] });
    expect(JSON.stringify(messages)).not.toContain(f.ids.originalStorageId);
    expect(JSON.stringify(messages)).not.toContain(f.ids.providerDocumentName);
  });

  it("closes for anonymous users, other owners, wrong messages and invalid indices", async () => {
    const f = await savedGeneralCitation();
    expect(await f.t.action(resolveGeneralCitationFile, f.sourceArgs)).toBeNull();
    expect(await f.other.action(resolveGeneralCitationFile, f.sourceArgs)).toBeNull();
    for (const citationIndex of [-1, 0.5, 1, 16, Number.NaN])
      expect(await f.owner.action(resolveGeneralCitationFile, await signGeneralSourceArgs({ ...f.sourceArgs, citationIndex }))).toBeNull();
    expect(await f.owner.action(resolveGeneralCitationFile, await signGeneralSourceArgs({ ...f.sourceArgs, externalId: "different-chat" }))).toBeNull();
  });

  it.each(["missing provenance", "misaligned provenance", "resource unpublished", "resource archived", "version unpublished",
    "superseded version", "provider document moved", "hash changed", "size changed", "original deleted", "original replaced",
    "mime changed", "lifecycle lock", "expired lifecycle lock", "access revoked", "scope removed", "session expired", "owner banned", "owner unverified"] as const)(
    "rechecks %s before file access and withholds original quote data", async change => {
      const f = await savedGeneralCitation();
      expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).not.toBeNull();
      await f.t.run(async ctx => {
        switch (change) {
          case "missing provenance": await ctx.db.patch(f.messageId, { citationProvenance: undefined }); break;
          case "misaligned provenance": await ctx.db.patch(f.messageId, { citations: [] }); break;
          case "resource unpublished": await ctx.db.patch(f.ids.resourceId, { catalogPublished: false }); break;
          case "resource archived": await ctx.db.patch(f.ids.resourceId, { status: "archived" }); break;
          case "version unpublished": await ctx.db.patch(f.ids.versionId, { status: "unpublished" }); break;
          case "superseded version": await ctx.db.patch(f.ids.resourceId, { activeVersionId: undefined }); break;
          case "provider document moved": await ctx.db.patch(f.ids.versionId, { geminiDocumentName: `${f.ids.storeName}/documents/changed` }); break;
          case "hash changed": await ctx.db.patch(f.ids.versionId, { sha256: "a".repeat(64) }); break;
          case "size changed": await ctx.db.patch(f.ids.versionId, { byteSize: 1 }); break;
          case "original deleted": await ctx.storage.delete(f.ids.originalStorageId); break;
          case "original replaced": {
            const blob = new Blob(["x".repeat(f.ids.expectedByteSize)], { type: "application/pdf" });
            await ctx.db.patch(f.ids.versionId, { originalStorageId: await ctx.storage.store(blob) }); break;
          }
          case "mime changed": await ctx.db.patch(f.ids.versionId, { mimeType: "text/plain" }); break;
          case "lifecycle lock": case "expired lifecycle lock": await ctx.db.insert("documentLifecycleLocks", {
            jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId, operation: "unpublish",
            actorId: "fixture", idempotencyKey: "source-lock", expiresAt: change === "lifecycle lock" ? Date.now() + 60_000 : 0,
            createdAt: 0, updatedAt: 0 }); break;
          case "access revoked": await ctx.db.patch(f.ids.jurisdictionId, { visibility: "members" }); break;
          case "scope removed": await ctx.db.delete(f.ids.profileId); break;
          case "owner banned": case "owner unverified": await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "user",
            where: [{ field: "_id", value: f.ids.ownerIdentity.subject }], update: change === "owner banned" ? { banned: true } : { emailVerified: false } } }); break;
          case "session expired": await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session",
            where: [{ field: "_id", value: f.ids.ownerIdentity.sessionId }], update: { expiresAt: 0 } } }); break;
        }
      });
      expect(await f.owner.action(resolveGeneralCitationFile, f.sourceArgs)).toBeNull();
      const messages = await f.owner.query(api.chats.listMessages, { externalId: f.args.externalId, paginationOpts: { cursor: null, numItems: 10 } });
      expect(JSON.stringify(messages)).not.toContain("Verified original excerpt.");
    },
  );
});
