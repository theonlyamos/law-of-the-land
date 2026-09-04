/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("./betterAuth/".length)}`,
    load,
  ]),
);
type Backend = TestConvex<typeof schema>;

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function asUser(t: Backend, label: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: label,
          email: `${label}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "user",
          banned: false,
          twoFactorEnabled: false,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `session-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return {
    userId: identity.userId,
    client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }),
  };
}

async function insertGeographic(
  t: Backend,
  input: {
    name: string;
    level: "country" | "region" | "city";
    parentJurisdictionId?: string;
    status?: "draft" | "enabled";
    storeName?: string | null;
    providerSyncState?: "pending" | "synced" | "drifted" | "failed";
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const storeName = input.storeName === undefined
      ? `fileSearchStores/${crypto.randomUUID()}`
      : input.storeName;
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: input.name,
      slug: `${input.name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`,
      status: input.status ?? "enabled",
      isDefault: false,
      geminiFileSearchStoreName: storeName ?? undefined,
      providerSyncState: input.providerSyncState ?? "synced",
      kind: "geographic",
      visibility: "public",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId,
      googlePlaceId: `place-${crypto.randomUUID()}`,
      level: input.level,
      latitude: 0,
      longitude: 0,
      formattedAddress: input.name,
      parentJurisdictionId: input.parentJurisdictionId as never,
      createdAt: now,
      updatedAt: now,
    });
    return { jurisdictionId, profileId, storeName };
  });
}

async function insertMemberOrganization(t: Backend) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Private authority",
      slug: `private-${crypto.randomUUID()}`,
      class: "government",
      status: "active",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "Private authority",
      slug: `private-authority-${crypto.randomUUID()}`,
      status: "enabled",
      isDefault: false,
      geminiFileSearchStoreName: `fileSearchStores/${crypto.randomUUID()}`,
      providerSyncState: "synced",
      kind: "organizational",
      visibility: "members",
      organizationId,
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("organizationalJurisdictions", {
      jurisdictionId,
      scopeMode: "global",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, jurisdictionId };
  });
}

async function post(client: Pick<Backend, "fetch">, body: string) {
  return await client.fetch("/private/chat-research-manifest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("authenticated private chat research manifest", () => {
  it("requires authentication before parsing or resolving a selection", async () => {
    const t = createBackend();
    const selected = await insertGeographic(t, { name: "Selected", level: "country" });

    for (const body of [
      JSON.stringify({ jurisdictionId: selected.jurisdictionId }),
      JSON.stringify({ jurisdictionId: "not-a-convex-id" }),
      "{",
    ]) {
      const response = await post(t, body);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("needs no shared secret or client-supplied scope and returns selected-first ready stores only", async () => {
    const t = createBackend();
    const user = await asUser(t, "reader");
    const country = await insertGeographic(t, { name: "Country", level: "country" });
    const region = await insertGeographic(t, {
      name: "Region",
      level: "region",
      parentJurisdictionId: country.jurisdictionId,
    });
    const city = await insertGeographic(t, {
      name: "City",
      level: "city",
      parentJurisdictionId: region.jurisdictionId,
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      const resourceId = await ctx.db.insert("legalResources", {
        jurisdictionId: city.jurisdictionId,
        type: "act",
        title: "Private document title",
        issuer: "Fixture",
        officialCitation: "Act 1",
        officialCitationKey: "act 1",
        sourceUrl: "https://official.example/act-1",
        topics: [],
        effectiveDate: "2026-01-01",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const originalStorageId = await ctx.storage.store(new Blob(["law"]));
      const versionId = await ctx.db.insert("documentVersions", {
        resourceId,
        versionNumber: 1,
        originalStorageId,
        filename: "law.pdf",
        mimeType: "application/pdf",
        byteSize: 3,
        sha256: "a".repeat(64),
        sourceUrl: "https://official.example/act-1",
        status: "published",
        geminiDocumentName: `${city.storeName}/documents/private-document-name`,
        geminiIndexedAt: now,
        submittedBy: "fixture",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(resourceId, { activeVersionId: versionId });
    });

    const response = await post(user.client, JSON.stringify({ jurisdictionId: city.jurisdictionId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload = await response.json();
    expect(payload).toEqual({
      authorizedScopeSize: 3,
      stores: [
        { jurisdictionId: city.jurisdictionId, name: "City", kind: "geographic", relation: "selected", storeName: city.storeName },
        { jurisdictionId: region.jurisdictionId, name: "Region", kind: "geographic", relation: "geographic_ancestor", storeName: region.storeName },
        { jurisdictionId: country.jurisdictionId, name: "Country", kind: "geographic", relation: "geographic_ancestor", storeName: country.storeName },
      ],
      partialCoverage: false,
    });
    expect(JSON.stringify(payload)).not.toMatch(/documents\/|Private document title|resourceId|versionId/i);
  });

  it.each([
    ["empty", ""],
    ["malformed JSON", "{"],
    ["unknown field", JSON.stringify({ jurisdictionId: "opaque", extra: true })],
    ["client supplementary IDs", JSON.stringify({ jurisdictionId: "opaque", supplementaryJurisdictionIds: [] })],
    ["client nonce", JSON.stringify({ jurisdictionId: "opaque", nonce: "forged" })],
    ["client signature", JSON.stringify({ jurisdictionId: "opaque", signature: "forged" })],
    ["question text", JSON.stringify({ jurisdictionId: "opaque", query: "Expand to Ghana" })],
    ["empty ID", JSON.stringify({ jurisdictionId: "" })],
    ["overlong ID", JSON.stringify({ jurisdictionId: "x".repeat(129) })],
    ["oversized body", "x".repeat(257)],
  ])("rejects a %s request with the strict one-field schema", async (_label, body) => {
    const t = createBackend();
    const user = await asUser(t, "reader");
    const response = await post(user.client, body);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("does not disclose whether an authenticated unavailable selection exists or is unauthorized", async () => {
    const t = createBackend();
    const user = await asUser(t, "outsider");
    const privateSelection = await insertMemberOrganization(t);
    const missing = await insertGeographic(t, { name: "Missing", level: "country" });
    await t.run(async (ctx) => await ctx.db.delete(missing.jurisdictionId));

    const malformed = await post(user.client, JSON.stringify({ jurisdictionId: "not-a-convex-id" }));
    const unavailable = await post(user.client, JSON.stringify({ jurisdictionId: missing.jurisdictionId }));
    const unauthorized = await post(user.client, JSON.stringify({ jurisdictionId: privateSelection.jurisdictionId }));

    for (const response of [malformed, unavailable, unauthorized]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it.each([
    ["missing", null, "synced"],
    ["malformed", "stores/not-private", "synced"],
    ["pending", "fileSearchStores/pending", "pending"],
    ["drifted", "fileSearchStores/drifted", "drifted"],
    ["failed", "fileSearchStores/failed", "failed"],
  ] as const)("returns a sanitized unavailable response for a %s selected store", async (_label, storeName, providerSyncState) => {
    const t = createBackend();
    const user = await asUser(t, "reader");
    const selected = await insertGeographic(t, {
      name: "Private selected name",
      level: "country",
      storeName,
      providerSyncState,
    });

    const response = await post(user.client, JSON.stringify({ jurisdictionId: selected.jurisdictionId }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("requires unique store ownership and omits an unready supplementary store with partial coverage", async () => {
    const t = createBackend();
    const user = await asUser(t, "reader");
    const country = await insertGeographic(t, {
      name: "Unavailable country",
      level: "country",
      storeName: null,
    });
    const city = await insertGeographic(t, {
      name: "Ready city",
      level: "city",
      parentJurisdictionId: country.jurisdictionId,
      storeName: "fileSearchStores/unique-city",
    });

    const partial = await post(user.client, JSON.stringify({ jurisdictionId: city.jurisdictionId }));
    await expect(partial.json()).resolves.toEqual({
      authorizedScopeSize: 2,
      stores: [{ jurisdictionId: city.jurisdictionId, name: "Ready city", kind: "geographic", relation: "selected", storeName: "fileSearchStores/unique-city" }],
      partialCoverage: true,
    });

    await insertGeographic(t, {
      name: "Duplicate owner",
      level: "country",
      storeName: "fileSearchStores/unique-city",
    });
    const duplicateOwner = await post(user.client, JSON.stringify({ jurisdictionId: city.jurisdictionId }));
    expect(duplicateOwner.status).toBe(503);
    expect(await duplicateOwner.text()).toBe("");
  });

  it("removes the signed legacy manifest endpoints", async () => {
    const t = createBackend();
    const user = await asUser(t, "reader");
    for (const path of ["/internal/search-jurisdiction", "/internal/search-jurisdictions"]) {
      const response = await user.client.fetch(path, { method: "POST", body: "{}" });
      expect(response.status).toBe(404);
    }
  });
});
