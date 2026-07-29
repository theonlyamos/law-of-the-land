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
          stagingBucketId: "staging-ng",
          productionBucketId: "22001",
        },
        {
          code: "GH",
          name: "Ghana",
          slug: "ghana",
          status: "enabled" as const,
          isDefault: false,
          stagingBucketId: "staging-gh",
          productionBucketId: "11833",
        },
        {
          code: "CI",
          name: "Cote d'Ivoire",
          slug: "cote-divoire",
          status: "draft" as const,
          isDefault: false,
          stagingBucketId: "staging-ci",
          productionBucketId: "22002",
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
    expect(publicRows.every((row: Record<string, unknown>) => !Object.hasOwn(row, "productionBucketId"))).toBe(true);
    expect(publicRows.every((row: Record<string, unknown>) => !Object.hasOwn(row, "providerSyncState"))).toBe(true);
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
          stagingBucketId: `staging-${index}`,
          productionBucketId: String(30_000 + index),
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
    expect(result.every((jurisdiction: Record<string, unknown>) => !Object.hasOwn(jurisdiction, "productionBucketId"))).toBe(true);
  });

  it("returns only enabled, production-configured jurisdictions publicly", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        stagingBucketId: "staging-gh",
        productionBucketId: "11833",
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
        stagingBucketId: "staging-ng",
        productionBucketId: "production-ng",
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
      productionBucketId: "11833",
    });
    await expect(t.query(getPublicByCode, { code: "NG" })).resolves.toBeNull();
    await expect(t.query(getPublicByCode, { code: "GHA" })).rejects.toThrow(
      "INVALID_JURISDICTION_CODE",
    );
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
        stagingBucketId: "staging-gh",
        productionBucketId: "11833",
        isDefault: true,
        reason: "Initial governed jurisdiction",
      }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");

    const ghId = await manager.client.mutation(createJurisdiction, {
      code: "gh",
      name: "Ghana",
      slug: "ghana",
      stagingBucketId: "staging-gh",
      productionBucketId: "11833",
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
        stagingBucketId: "staging-gh",
        productionBucketId: "11833",
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
      isDefault: true, stagingBucketId: "staging-gh", productionBucketId: "11833",
    });
    expect(JSON.parse(updateAudit.afterSummary!)).toMatchObject({
      code: "GH", name: "Republic of Ghana", slug: "ghana", status: "enabled",
      isDefault: true, stagingBucketId: "staging-gh", productionBucketId: "11833",
    });

    process.env.ADMIN_PANEL_ENABLED = "false";
    await expect(superAdmin.client.query(listJurisdictions, page)).rejects.toThrow(
      "ADMIN_DISABLED",
    );
  });
});

describe("legal resource governance", () => {
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
    ).rejects.toThrow("active resources");
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
});
