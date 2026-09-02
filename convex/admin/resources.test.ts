/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);

type Backend = TestConvex<typeof schema>;

const getPublicByCode = makeFunctionReference<"query">(
  "jurisdictions:getPublicByCode",
);
const listPublicEnabled = makeFunctionReference<"query">(
  "jurisdictions:listPublicEnabled",
);
const listJurisdictions = makeFunctionReference<"query">(
  "admin/resources:listJurisdictions",
);
const createJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:createJurisdiction",
);
const updateJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:updateJurisdiction",
);
const enableJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:enableJurisdiction",
);
const archiveJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:archiveJurisdiction",
);
const listResources = makeFunctionReference<"query">(
  "admin/resources:listResources",
);
const getResource = makeFunctionReference<"query">(
  "admin/resources:getResource",
);
const createResource = makeFunctionReference<"mutation">(
  "admin/resources:createResource",
);
const updateResource = makeFunctionReference<"mutation">(
  "admin/resources:updateResource",
);
const archiveResource = makeFunctionReference<"mutation">(
  "admin/resources:archiveResource",
);
const markResourceRepealed = makeFunctionReference<"mutation">(
  "admin/resources:markResourceRepealed",
);
const listVersions = makeFunctionReference<"query">(
  "admin/resources:listVersions",
);
const enqueueSystemJob = makeFunctionReference<"mutation">(
  "admin/jobs:enqueueSystemJob",
);

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", {
      key: "admin_panel",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    });
  });
}

async function asAdmin(t: Backend, role: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: `${role} fixture`,
          email: `${role}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: true,
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
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return {
    client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }),
    userId: identity.userId,
  };
}

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  if (previousAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
});

const page = { paginationOpts: { numItems: 20, cursor: null } };

describe("jurisdiction governance", () => {
  it("blocks an active resource while a Gemini store teardown is active", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        code: "GH", name: "Ghana", slug: "ghana-teardown", status: "draft", isDefault: false,
        providerSyncState: "drifted", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
    });
    const input = {
      jurisdictionId, type: "act", title: "Teardown Act", issuer: "Parliament", officialCitation: "Act teardown",
      sourceUrl: "https://example.invalid/teardown", topics: [], effectiveDate: "2026-01-01", reason: "Add resource",
    };
    await expect(manager.client.mutation(createResource, input)).resolves.toBeDefined();
    const teardown = await t.mutation(enqueueSystemJob, {
      type: "gemini_delete_store", targetType: "jurisdictionGeminiStore", targetId: jurisdictionId,
      payload: { storeName: "fileSearchStores/ghana-teardown" }, idempotencyKey: "gemini-delete-resource-race", systemActor: "gemini_orchestrator",
    });
    await expect(manager.client.mutation(createResource, {
      ...input, title: "Blocked teardown Act", officialCitation: "Act teardown blocked",
    })).rejects.toThrow("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
    await t.run((ctx) => ctx.db.patch(teardown.jobId, { status: "running" }));
    await expect(manager.client.mutation(createResource, {
      ...input, title: "Blocked running teardown Act", officialCitation: "Act teardown running",
    })).rejects.toThrow("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
  });

  it("lists browser-safe enabled jurisdictions with the default first", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const jurisdiction of [
        {
          code: "NG",
          name: "Nigeria",
          slug: "nigeria",
          status: "enabled" as const,
          isDefault: true,
          geminiFileSearchStoreName: "fileSearchStores/nigeria-resources-test",
          geminiEmbeddingModel: "models/gemini-embedding-2",
        },
        {
          code: "GH",
          name: "Ghana",
          slug: "ghana",
          status: "enabled" as const,
          isDefault: false,
          geminiFileSearchStoreName: "fileSearchStores/ghana-resources-test",
          geminiEmbeddingModel: "models/gemini-embedding-2",
        },
        {
          code: "CI",
          name: "Cote d'Ivoire",
          slug: "cote-divoire",
          status: "draft" as const,
          isDefault: false,
        },
      ]) {
        await ctx.db.insert("jurisdictions", {
          ...jurisdiction,
          providerSyncState: "synced",
          createdBy: "fixture",
          updatedBy: "fixture",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const publicRows = await t.query(listPublicEnabled, {});

    expect(publicRows).toEqual([
      {
        code: "NG",
        name: "Nigeria",
        slug: "nigeria",
        isDefault: true,
      },
      {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        isDefault: false,
      },
    ]);
    expect(publicRows.every((row: Record<string, unknown>) => !Object.prototype.hasOwnProperty.call(row, "providerSyncState"))).toBe(true);
  });

  it("keeps the bounded governed catalog while placing its default first", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 250; index += 1) {
        const code = `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
        await ctx.db.insert("jurisdictions", {
          code,
          name: `Jurisdiction ${String(index).padStart(3, "0")}`,
          slug: `jurisdiction-${index}`,
          status: "enabled",
          isDefault: index === 249,
          geminiFileSearchStoreName: `fileSearchStores/jurisdiction-${index}`,
          geminiEmbeddingModel: "models/gemini-embedding-2",
          providerSyncState: "synced",
          createdBy: "fixture",
          updatedBy: "fixture",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const result = await t.query(listPublicEnabled, {});
    expect(result).toHaveLength(250);
    expect(result[0]).toEqual({
      code: "JP",
      name: "Jurisdiction 249",
      slug: "jurisdiction-249",
      isDefault: true,
    });
  });

  it("returns only enabled, search-ready jurisdictions publicly", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        geminiFileSearchStoreName: "fileSearchStores/ghana-public-test",
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: "synced",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jurisdictions", {
        code: "NG",
        name: "Nigeria",
        slug: "nigeria",
        status: "draft",
        isDefault: false,
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(t.query(getPublicByCode, { code: "gh" })).resolves.toEqual({
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      enabled: true,
      isDefault: true,
      searchReady: true,
    });
    await expect(t.query(getPublicByCode, { code: "NG" })).resolves.toBeNull();
    await expect(t.query(getPublicByCode, { code: "GHA" })).rejects.toThrow(
      "INVALID_JURISDICTION_CODE",
    );
  });

  it("projects typed countries through the exact legacy admin contract", async () => {
    const t = createBackend();
    await enablePanel(t);
    const auditor = await asAdmin(t, "auditor");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("jurisdictions", {
        legacyCountryCode: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        geminiFileSearchStoreName: "fileSearchStores/ghana-admin-test",
        geminiEmbeddingModel: "models/gemini-embedding-2",
        providerSyncState: "synced",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await auditor.client.query(listJurisdictions, page);
    expect(result.page).toEqual([expect.objectContaining({ code: "GH", name: "Ghana" })]);
    expect(Object.keys(result.page[0]).sort()).toEqual([
      "_creationTime", "_id", "code", "createdAt", "createdBy", "isDefault",
      "name", "providerSyncState", "slug",
      "status", "updatedAt", "updatedBy",
    ].sort());
    await expect(auditor.client.query(listJurisdictions, {
      code: "gh",
      paginationOpts: { numItems: 25, cursor: null },
    })).resolves.toMatchObject({
      page: [expect.objectContaining({ code: "GH", name: "Ghana" })],
      isDone: true,
    });
  });

  it("returns a code-less organizational jurisdiction's real ID for resource creation", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const organizationJurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Accra Bar Association",
        slug: "accra-bar-association",
        class: "professional_association",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Accra Bar Association",
        slug: "accra-bar-association",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
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
      return jurisdictionId;
    });

    const jurisdictions = await manager.client.query(listJurisdictions, page);
    const selected = jurisdictions.page.find(
      (jurisdiction: { _id: string }) => jurisdiction._id === organizationJurisdictionId,
    );
    expect(selected).toMatchObject({
      _id: organizationJurisdictionId,
      code: "accra-bar-association",
      name: "Accra Bar Association",
    });

    await expect(manager.client.mutation(createResource, {
      jurisdictionId: selected!._id,
      type: "policy",
      title: "Professional conduct policy",
      issuer: "Accra Bar Association",
      officialCitation: "ABA Policy 1",
      sourceUrl: "https://example.gov.gh/aba-policy-1",
      topics: [],
      effectiveDate: "2026-01-01",
      reason: "Add organizational authority policy",
    })).resolves.toBeDefined();
  });

  it("enforces authority, validation, uniqueness, named transitions, and audit", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const auditor = await asAdmin(t, "auditor");
    const superAdmin = await asAdmin(t, "super_admin");

    await expect(
      auditor.client.mutation(createJurisdiction, {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        isDefault: true,
        reason: "Initial governed jurisdiction",
      }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");

    const ghId = await manager.client.mutation(createJurisdiction, {
      code: "gh",
      name: "Ghana",
      slug: "ghana",
      isDefault: true,
      reason: "Initial governed jurisdiction",
    });
    await expect(
      manager.client.mutation(createJurisdiction, {
        code: "GH",
        name: "Another Ghana",
        slug: "another-ghana",
        isDefault: false,
        reason: "Duplicate code check",
      }),
    ).rejects.toThrow("JURISDICTION_CODE_EXISTS");
    await t.run((ctx) => ctx.db.patch(ghId, {
      geminiFileSearchStoreName: "fileSearchStores/ghana",
      geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced",
    }));
    await expect(
      manager.client.mutation(enableJurisdiction, {
        id: ghId,
        reason: "Ready for public search",
      }),
    ).resolves.toMatchObject({ status: "enabled" });
    await expect(
      manager.client.mutation(enableJurisdiction, {
        id: ghId,
        reason: "Duplicate enable",
      }),
    ).rejects.toThrow("INVALID_JURISDICTION_TRANSITION");
    await expect(
      manager.client.mutation(updateJurisdiction, {
        id: ghId,
        name: "Republic of Ghana",
        slug: "ghana",
        isDefault: true,
        reason: "Use official display name",
      }),
    ).resolves.toMatchObject({ name: "Republic of Ghana" });
    await expect(manager.client.query(listJurisdictions, page)).resolves.toMatchObject({
      page: [expect.objectContaining({ code: "GH" })],
    });
    await expect(manager.client.query(listJurisdictions, {
      code: "gh",
      paginationOpts: { numItems: 25, cursor: null },
    })).resolves.toMatchObject({
      page: [expect.objectContaining({ code: "GH" })],
      isDone: true,
    });

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "jurisdiction").eq("targetId", ghId),
        )
        .take(10),
    );
    expect(audits.map((row) => row.action)).toEqual([
      "jurisdiction.created",
      "jurisdiction.enabled",
      "jurisdiction.updated",
    ]);
    const updateAudit = audits[2];
    expect(updateAudit.reason).toBe("Use official display name");
    expect(updateAudit.correlationId).toMatch(/^op_[a-f0-9]{32}$/);
    expect(JSON.parse(updateAudit.beforeSummary!)).toMatchObject({
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
      isDefault: true,
    });
    expect(JSON.parse(updateAudit.afterSummary!)).toMatchObject({
      code: "GH", name: "Republic of Ghana", slug: "ghana", status: "enabled",
      isDefault: true,
    });

    process.env.ADMIN_PANEL_ENABLED = "false";
    await expect(superAdmin.client.query(listJurisdictions, page)).rejects.toThrow(
      "ADMIN_DISABLED",
    );
  });

  it("preserves a synced legacy store when updating jurisdiction metadata", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: false,
      reason: "Create legacy jurisdiction",
    });
    await t.run(async (ctx) => await ctx.db.patch(jurisdictionId, {
      geminiFileSearchStoreName: "fileSearchStores/ghana",
      providerSyncState: "synced",
    }));

    const updated = await manager.client.mutation(updateJurisdiction, {
      id: jurisdictionId,
      name: "Republic of Ghana",
      slug: "ghana",
      isDefault: false,
      reason: "Update display metadata",
    });

    expect(updated).toMatchObject({
      name: "Republic of Ghana",
      providerSyncState: "synced",
    });
    await expect(t.run(async (ctx) => await ctx.db.get(jurisdictionId))).resolves.toMatchObject({
      geminiFileSearchStoreName: "fileSearchStores/ghana",
      providerSyncState: "synced",
    });
  });

  it("rejects legacy updates for typed geographic rows that retain a two-letter code", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "draft",
        isDefault: false,
        providerSyncState: "synced",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: id,
        googlePlaceId: "place-gh",
        level: "country",
        countryCode: "GH",
        latitude: 5.6037,
        longitude: -0.187,
        formattedAddress: "Ghana",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });

    await expect(
      manager.client.mutation(updateJurisdiction, {
        id: jurisdictionId,
        name: "Republic of Ghana",
        slug: "republic-of-ghana",
        isDefault: true,
        reason: "Attempt legacy update for typed geography",
      }),
    ).rejects.toThrow("JURISDICTION_NOT_FOUND");

    await expect(t.run((ctx) => ctx.db.get("jurisdictions", jurisdictionId))).resolves.toMatchObject({
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: false,
      providerSyncState: "synced",
      kind: "geographic",
    });
  });
});

describe("legal resource governance", () => {
  it("accepts typed jurisdiction IDs without requiring a legacy country code", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("jurisdictions", {
        name: "Accra",
        slug: "accra",
        status: "draft",
        isDefault: false,
        providerSyncState: "pending",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    const resourceId = await manager.client.mutation(createResource, {
      jurisdictionId,
      type: "ordinance",
      title: "Accra local instrument",
      issuer: "Accra authority",
      officialCitation: "LI 1",
      sourceUrl: "https://example.gov.gh/li-1",
      topics: ["local government"],
      effectiveDate: "2026-01-01",
      reason: "Add typed jurisdiction resource",
    });

    await expect(manager.client.query(getResource, { id: resourceId })).resolves.toMatchObject({
      jurisdiction: { name: "Accra", status: "draft" },
    });
  });

  it("rejects invalid metadata and duplicate official citations", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const auditor = await asAdmin(t, "auditor");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: true,
      reason: "Catalog setup",
    });
    const valid = {
      jurisdictionId,
      type: "constitution",
      title: "Constitution of the Republic of Ghana",
      issuer: "Republic of Ghana",
      officialCitation: "1992 Constitution",
      sourceUrl: "https://www.constituteproject.org/constitution/Ghana_1996",
      topics: ["constitutional law"],
      effectiveDate: "1993-01-07",
      reason: "Add authoritative source",
    };

    await expect(auditor.client.mutation(createResource, valid)).rejects.toThrow(
      "ADMIN_FORBIDDEN",
    );
    const resourceId = await manager.client.mutation(createResource, valid);
    const counter = await t.run(async (ctx) =>
      ctx.db
        .query("resourceVersionCounters")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
        .unique(),
    );
    expect(counter?.nextVersionNumber).toBe(1);
    await expect(auditor.client.query(getResource, { id: resourceId })).resolves.toMatchObject({
      _id: resourceId,
      officialCitation: "1992 Constitution",
    });
    await expect(manager.client.mutation(createResource, valid)).rejects.toThrow(
      "RESOURCE_CITATION_EXISTS",
    );
    await expect(
      manager.client.mutation(createResource, {
        ...valid,
        officialCitation: "  1992 CONSTITUTION  ",
      }),
    ).rejects.toThrow("RESOURCE_CITATION_EXISTS");
    await expect(
      manager.client.mutation(createResource, {
        ...valid,
        officialCitation: "1992 Constituti\u006fn".normalize("NFD"),
      }),
    ).rejects.toThrow("RESOURCE_CITATION_EXISTS");
    await manager.client.mutation(createResource, {
      ...valid,
      title: "Cafe law",
      officialCitation: "Caf\u00e9 Act",
      sourceUrl: "https://example.gov.gh/cafe-act",
    });
    await expect(
      manager.client.mutation(createResource, {
        ...valid,
        title: "Duplicate cafe law",
        officialCitation: "Cafe\u0301 Act",
        sourceUrl: "https://example.gov.gh/cafe-act-copy",
      }),
    ).rejects.toThrow("RESOURCE_CITATION_EXISTS");
    await expect(
      manager.client.mutation(createResource, {
        ...valid,
        officialCitation: "Act 1",
        type: "bill",
      }),
    ).rejects.toThrow("INVALID_RESOURCE_TYPE");
    await expect(
      manager.client.mutation(updateResource, {
        id: resourceId,
        title: valid.title,
        issuer: valid.issuer,
        officialCitation: valid.officialCitation,
        sourceUrl: "javascript:alert(1)",
        topics: [],
        effectiveDate: "1993-01-07",
        reason: "Invalid update",
      }),
    ).rejects.toThrow();
    await expect(
      manager.client.mutation(createResource, {
        ...valid,
        officialCitation: "Act with invalid lifecycle",
        repealDate: "2024-01-01",
      }),
    ).rejects.toThrow();
  });

  it("blocks jurisdiction archival while active resources exist, then archives by named transitions", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: false,
      reason: "Catalog setup",
    });
    const resourceId = await manager.client.mutation(createResource, {
      jurisdictionId,
      type: "act",
      title: "Data Protection Act",
      issuer: "Parliament of Ghana",
      officialCitation: "Act 843",
      sourceUrl: "https://example.gov.gh/act-843",
      topics: ["privacy"],
      effectiveDate: "2012-05-10",
      reason: "Catalog authoritative act",
    });

    await expect(
      manager.client.mutation(markResourceRepealed, {
        id: resourceId,
        repealDate: "2024-01-31",
        reason: "Act was repealed",
      }),
    ).resolves.toMatchObject({ status: "repealed", repealDate: "2024-01-31" });
    await expect(
      manager.client.mutation(markResourceRepealed, {
        id: resourceId,
        repealDate: "2024-02-01",
        reason: "Duplicate repeal",
      }),
    ).rejects.toThrow("INVALID_RESOURCE_TRANSITION");
    await expect(
      manager.client.mutation(updateResource, {
        id: resourceId,
        title: "Updated title",
        issuer: "Updated issuer",
        officialCitation: "Act 843",
        sourceUrl: "https://example.gov.gh/act-843-updated",
        topics: ["privacy", "data"],
        effectiveDate: "2012-05-10",
        reason: "Update governed metadata",
      }),
    ).resolves.toMatchObject({ status: "repealed", repealDate: "2024-01-31" });
    await expect(
      manager.client.mutation(archiveJurisdiction, {
        id: jurisdictionId,
        reason: "Retire catalog",
      }),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      manager.client.mutation(archiveJurisdiction, {
        id: jurisdictionId,
        reason: "Duplicate archive",
      }),
    ).rejects.toThrow("INVALID_JURISDICTION_TRANSITION");

    const resourceAudits = await t.run(async (ctx) =>
      ctx.db.query("auditEvents").withIndex("by_targetType_and_targetId", (q) =>
        q.eq("targetType", "legalResource").eq("targetId", resourceId),
      ).take(10),
    );
    const updateAudit = resourceAudits.find((row) => row.action === "resource.updated")!;
    expect(updateAudit.reason).toBe("Update governed metadata");
    expect(updateAudit.correlationId).toMatch(/^op_[a-f0-9]{32}$/);
    expect(JSON.parse(updateAudit.beforeSummary!)).toMatchObject({
      issuer: "Parliament of Ghana", sourceUrl: "example.gov.gh/act-843",
      topics: ["privacy"], effectiveDate: "2012-05-10", repealDate: "2024-01-31",
      status: "repealed",
    });
    expect(JSON.parse(updateAudit.afterSummary!)).toMatchObject({
      issuer: "Updated issuer", sourceUrl: "example.gov.gh/act-843-updated",
      topics: ["privacy", "data"], effectiveDate: "2012-05-10", repealDate: "2024-01-31",
      status: "repealed",
    });
  });

  it("blocks jurisdiction archival while active resources exist, then archives both records", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: false,
      reason: "Catalog setup",
    });
    const resourceId = await manager.client.mutation(createResource, {
      jurisdictionId,
      type: "act",
      title: "Data Protection Act",
      issuer: "Parliament of Ghana",
      officialCitation: "Act 843",
      sourceUrl: "https://example.gov.gh/act-843",
      topics: ["privacy"],
      effectiveDate: "2012-05-10",
      reason: "Catalog authoritative act",
    });

    await expect(
      manager.client.mutation(archiveJurisdiction, {
        id: jurisdictionId,
        reason: "Retire catalog",
      }),
    ).rejects.toThrow("JURISDICTION_HAS_ACTIVE_RESOURCES");
    await expect(
      manager.client.mutation(archiveResource, {
        id: resourceId,
        reason: "Instrument withdrawn",
      }),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      manager.client.mutation(archiveResource, {
        id: resourceId,
        reason: "Duplicate archive",
      }),
    ).rejects.toThrow("INVALID_RESOURCE_TRANSITION");
    await expect(
      manager.client.mutation(markResourceRepealed, {
        id: resourceId,
        repealDate: "2025-01-01",
        reason: "Out of order repeal",
      }),
    ).rejects.toThrow("INVALID_RESOURCE_TRANSITION");
    await expect(
      manager.client.mutation(archiveJurisdiction, {
        id: jurisdictionId,
        reason: "Retire catalog",
      }),
    ).resolves.toMatchObject({ status: "archived" });
  });

  it("requires unpublish before repealing or archiving a resource", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: false,
      reason: "Catalog setup",
    });
    const resourceId = await manager.client.mutation(createResource, {
      jurisdictionId,
      type: "act",
      title: "Published Act",
      issuer: "Parliament of Ghana",
      officialCitation: "Act 1",
      sourceUrl: "https://example.gov.gh/act-1",
      topics: [],
      effectiveDate: "2026-01-01",
      reason: "Catalog authoritative act",
    });
    const versionId = await t.run(async (ctx) => {
      const now = Date.now();
      const storageId = await ctx.storage.store(new Blob(["act"]));
      const versionId = await ctx.db.insert("documentVersions", {
        resourceId,
        versionNumber: 1,
        originalStorageId: storageId,
        filename: "act.pdf",
        mimeType: "application/pdf",
        byteSize: 3,
        sha256: "a".repeat(64),
        sourceUrl: "https://example.gov.gh/act-1",
        status: "published",
        submittedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(resourceId, { activeVersionId: versionId });
      return versionId;
    });

    await expect(manager.client.mutation(markResourceRepealed, {
      id: resourceId,
      repealDate: "2026-02-01",
      reason: "Repeal published act",
    })).rejects.toThrow("RESOURCE_MUST_BE_UNPUBLISHED");
    await expect(manager.client.mutation(archiveResource, {
      id: resourceId,
      reason: "Archive published act",
    })).rejects.toThrow("RESOURCE_MUST_BE_UNPUBLISHED");

    const lockId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(resourceId, { activeVersionId: undefined });
      await ctx.db.patch(versionId, { status: "publishing" });
      return await ctx.db.insert("documentLifecycleLocks", {
        resourceId,
        versionId,
        operation: "publish",
        actorId: "fixture",
        idempotencyKey: "first-publish-in-flight",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(manager.client.mutation(markResourceRepealed, {
      id: resourceId,
      repealDate: "2026-02-01",
      reason: "Repeal while publication is running",
    })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");
    await expect(manager.client.mutation(archiveResource, {
      id: resourceId,
      reason: "Archive while publication is running",
    })).rejects.toThrow("DOCUMENT_LIFECYCLE_BUSY");

    await t.run((ctx) => ctx.db.delete(lockId));
    await expect(manager.client.mutation(markResourceRepealed, {
      id: resourceId,
      repealDate: "2026-02-01",
      reason: "Repeal unpublished act",
    })).resolves.toMatchObject({ status: "repealed" });
  });

  it("paginates bounded jurisdiction, resource, and version history reads", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const auditor = await asAdmin(t, "auditor");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: true,
      reason: "Catalog setup",
    });
    for (let index = 1; index <= 3; index += 1) {
      await manager.client.mutation(createResource, {
        jurisdictionId,
        type: "act",
        title: `Act ${index}`,
        issuer: "Parliament",
        officialCitation: `Act ${index}`,
        sourceUrl: `https://example.gov.gh/acts/${index}`,
        topics: [],
        effectiveDate: `2020-01-0${index}`,
        reason: "Catalog fixture",
      });
    }
    const first = await auditor.client.query(listResources, {
      jurisdictionId,
      status: "active",
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    await expect(
      manager.client.query(listResources, {
        jurisdictionId,
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).resolves.toMatchObject({ page: expect.arrayContaining([
      expect.objectContaining({ jurisdictionId }),
    ]) });
    await expect(
      auditor.client.query(listJurisdictions, {
        paginationOpts: { numItems: 101, cursor: null },
      }),
    ).rejects.toThrow("INVALID_ADMIN_PAGINATION");
    await expect(
      auditor.client.query(listVersions, {
        resourceId: first.page[0]._id,
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [] });
  });

  it("reads legacy GroundX document-version statuses as inert history", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const auditor = await asAdmin(t, "auditor");
    const jurisdictionId = await manager.client.mutation(createJurisdiction, {
      code: "GH",
      name: "Ghana",
      slug: "ghana-legacy-versions",
      isDefault: false,
      reason: "Legacy history fixture",
    });
    const resourceId = await manager.client.mutation(createResource, {
      jurisdictionId,
      type: "act",
      title: "Legacy status act",
      issuer: "Parliament",
      officialCitation: "Legacy Status 1",
      sourceUrl: "https://example.gov.gh/legacy-status",
      topics: [],
      effectiveDate: "2020-01-01",
      reason: "Legacy history fixture",
    });
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["legacy"]));
      for (const [index, status] of (["uploading", "staging_processing", "failed"] as const).entries()) {
        await ctx.db.insert("documentVersions", {
          resourceId,
          versionNumber: index + 1,
          originalStorageId: storageId,
          filename: `legacy-${index + 1}.pdf`,
          mimeType: "application/pdf",
          byteSize: 6,
          sha256: "a".repeat(64),
          sourceUrl: "https://example.gov.gh/legacy-status",
          status,
          submittedBy: "legacy",
          createdAt: Date.now() + index,
          updatedAt: Date.now() + index,
        });
      }
    });

    const result = await auditor.client.query(listVersions, {
      resourceId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(result.page.map((version: { status: string }) => version.status)).toEqual([
      "failed",
      "staging_processing",
      "uploading",
    ]);
  });

  it("paginates unified picker rows, including code-less jurisdictions", async () => {
    const t = createBackend();
    await enablePanel(t);
    const auditor = await asAdmin(t, "auditor");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [code, name] of [
        [undefined, "A Organization"],
        ["GH", "Ghana"],
        ["GH", "Duplicate Ghana"],
        ["KE", "Kenya"],
        ["NG", "Nigeria"],
      ] as const) {
        await ctx.db.insert("jurisdictions", {
          code,
          name,
          slug: `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`,
          status: "enabled",
          isDefault: false,
          providerSyncState: "synced",
          createdBy: "system",
          updatedBy: "system",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const first = await auditor.client.query(listJurisdictions, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.page).toMatchObject([{ name: "A Organization" }]);
    expect(first.isDone).toBe(false);

    const second = await auditor.client.query(listJurisdictions, {
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    });
    expect(second.page).toMatchObject([{ code: "GH", name: "Ghana" }]);
    expect(second.isDone).toBe(false);

    await expect(auditor.client.query(listJurisdictions, {
      paginationOpts: { numItems: 1, cursor: "legacy-country-code:KE" },
    })).resolves.toMatchObject({
      page: [expect.objectContaining({ code: "NG", name: "Nigeria" })],
      isDone: true,
    });
  });
});
