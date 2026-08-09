/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import { issueVerifiedPlaceClaim, type VerifiedPlace } from "../lib/placeClaim";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("../betterAuth/".length)}`,
    load,
  ]),
);

type Backend = TestConvex<typeof schema>;

const createGeographicJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:createGeographicJurisdiction",
);
const createOrganizationalJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:createOrganizationalJurisdiction",
);
const updateGeographicJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:updateGeographicJurisdiction",
);
const updateOrganizationalJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:updateOrganizationalJurisdiction",
);
const enableJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:enableJurisdiction",
);
const archiveJurisdiction = makeFunctionReference<"mutation">(
  "admin/jurisdictions:archiveJurisdiction",
);
const listGeographicJurisdictionOptions = makeFunctionReference<"query">(
  "admin/jurisdictions:listGeographicJurisdictionOptions",
);
const suggestGeographicParentsByAliases = makeFunctionReference<"query">(
  "admin/jurisdictions:suggestGeographicParentsByAliases",
);
const listAdminJurisdictions = makeFunctionReference<"query">(
  "admin/jurisdictions:listAdminJurisdictions",
);

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run((ctx) => ctx.db.insert("featureFlags", {
    key: "admin_panel",
    environment: "test",
    enabled: true,
    updatedAt: Date.now(),
  }));
}

async function asAdmin(
  t: Backend,
  role: "auditor" | "content_manager" | "content_reviewer" = "content_manager",
) {
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
    userId: identity.userId,
    client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }),
  };
}

function place(name: string, googlePlaceId: string): VerifiedPlace {
  return {
    googlePlaceId,
    name,
    formattedAddress: `${name}, Ghana`,
    latitude: 5.5,
    longitude: -0.2,
    countryCode: "GH",
    aliases: [name],
  };
}

async function createGeo(
  admin: Awaited<ReturnType<typeof asAdmin>>,
  input: {
    name: string;
    placeId: string;
    level: "country" | "region" | "district" | "town";
    parentJurisdictionId?: string;
    productionBucketId?: string;
  },
) {
  const verifiedPlaceClaim = await issueVerifiedPlaceClaim(
    admin.userId,
    place(input.name, input.placeId),
  );
  return await admin.client.mutation(createGeographicJurisdiction, {
    verifiedPlaceClaim,
    level: input.level,
    parentJurisdictionId: input.parentJurisdictionId,
    productionBucketId: input.productionBucketId,
    reason: `Create ${input.name}`,
  });
}

describe("typed jurisdiction administration", () => {
  beforeEach(() => {
    process.env.PLACE_CLAIM_SECRET = "test-place-claim-secret-that-is-at-least-32-bytes";
  });

  afterEach(() => {
    delete process.env.PLACE_CLAIM_SECRET;
    delete process.env.ADMIN_PANEL_ENABLED;
    delete process.env.ADMIN_ENVIRONMENT;
  });

  it("requires an enabled broader geographic parent and rejects cycles", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const countryId = await createGeo(admin, {
      name: "Ghana",
      placeId: "place-ghana",
      level: "country",
      productionBucketId: "11833",
    });
    await admin.client.mutation(enableJurisdiction, { id: countryId, reason: "Publish Ghana" });
    const draftRegionId = await createGeo(admin, {
      name: "Greater Accra Region",
      placeId: "place-greater-accra",
      level: "region",
      parentJurisdictionId: countryId,
      productionBucketId: "11834",
    });

    await t.run((ctx) => ctx.db.patch(countryId, { status: "archived" }));

    await expect(admin.client.mutation(enableJurisdiction, {
      id: draftRegionId,
      reason: "Publish region",
    })).rejects.toThrow("GEOGRAPHIC_PARENT_REQUIRED");

    await t.run((ctx) => ctx.db.patch(countryId, { status: "enabled" }));
    await admin.client.mutation(enableJurisdiction, {
      id: draftRegionId,
      reason: "Publish region",
    });
    const townId = await createGeo(admin, {
      name: "Accra",
      placeId: "place-accra",
      level: "town",
      parentJurisdictionId: draftRegionId,
      productionBucketId: "11837",
    });

    const replacementClaim = await issueVerifiedPlaceClaim(
      admin.userId,
      place("Ghana", "place-ghana"),
    );
    await expect(admin.client.mutation(updateGeographicJurisdiction, {
      id: countryId,
      verifiedPlaceClaim: replacementClaim,
      level: "country",
      parentJurisdictionId: townId,
      productionBucketId: "11833",
      reason: "Cycle test",
    })).rejects.toThrow("GEOGRAPHIC_PARENT_CYCLE");

    const otherTownId = await createGeo(admin, {
      name: "Tema",
      placeId: "place-tema",
      level: "town",
      parentJurisdictionId: draftRegionId,
      productionBucketId: "11836",
    });
    await admin.client.mutation(enableJurisdiction, {
      id: otherTownId,
      reason: "Publish Tema",
    });
    await expect(createGeo(admin, {
      name: "Osu",
      placeId: "place-osu",
      level: "town",
      parentJurisdictionId: otherTownId,
    })).rejects.toThrow("GEOGRAPHIC_PARENT_LEVEL_INVALID");

    await admin.client.mutation(enableJurisdiction, { id: townId, reason: "Publish Accra" });
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: draftRegionId,
      reason: "Retire region with enabled children",
    })).rejects.toThrow("JURISDICTION_HAS_ENABLED_CHILDREN");
  });

  it("enforces a maximum chain of eight geographic nodes", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const result = [];
      let parentJurisdictionId;
      for (let index = 0; index < 8; index += 1) {
        const jurisdictionId = await ctx.db.insert("jurisdictions", {
          name: `Level ${index}`,
          slug: `level-${index}`,
          status: "enabled",
          isDefault: false,
          productionBucketId: String(20_000 + index),
          providerSyncState: "pending",
          kind: "geographic",
          visibility: "public",
          createdBy: "fixture",
          updatedBy: "fixture",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictions", {
          jurisdictionId,
          googlePlaceId: `depth-${index}`,
          level: index === 0 ? "country" : "other_locality",
          latitude: 0,
          longitude: 0,
          formattedAddress: `Level ${index}`,
          parentJurisdictionId,
          createdAt: now,
          updatedAt: now,
        });
        result.push(jurisdictionId);
        parentJurisdictionId = jurisdictionId;
      }
      return result;
    });

    await expect(createGeo(admin, {
      name: "Ninth level",
      placeId: "depth-8",
      level: "town",
      parentJurisdictionId: ids[7],
    })).rejects.toThrow("GEOGRAPHIC_DEPTH_EXCEEDED");
  });

  it("validates organization scope links, organization uniqueness, and archival blockers", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const countryId = await createGeo(admin, {
      name: "Ghana",
      placeId: "place-ghana",
      level: "country",
      productionBucketId: "11833",
    });
    await admin.client.mutation(enableJurisdiction, { id: countryId, reason: "Publish Ghana" });
    const organizationId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("organizations", {
        name: "Example University",
        slug: "example-university",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(admin.client.mutation(createOrganizationalJurisdiction, {
      organizationId,
      visibility: "members",
      scopeMode: "global",
      geographicJurisdictionIds: [countryId],
      reason: "Invalid global scope",
    })).rejects.toThrow("INVALID_SCOPE_MODE");
    await expect(admin.client.mutation(createOrganizationalJurisdiction, {
      organizationId,
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: [],
      reason: "Missing linked scope",
    })).rejects.toThrow("INVALID_SCOPE_MODE");

    const jurisdictionId = await admin.client.mutation(createOrganizationalJurisdiction, {
      organizationId,
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: [countryId],
      productionBucketId: "11835",
      reason: "Create organization rules",
    });
    await expect(admin.client.mutation(createOrganizationalJurisdiction, {
      organizationId,
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: [countryId],
      reason: "Duplicate organization rules",
    })).rejects.toThrow("ORGANIZATION_JURISDICTION_EXISTS");
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: countryId,
      reason: "Retire scoped geography",
    })).rejects.toThrow("JURISDICTION_HAS_ACTIVE_SCOPE_LINKS");
    await expect(admin.client.mutation(enableJurisdiction, {
      id: jurisdictionId,
      reason: "Publish organization rules",
    })).resolves.toMatchObject({ status: "enabled", organizationId });
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: jurisdictionId,
      reason: "Retire linked organization rules",
    })).rejects.toThrow("JURISDICTION_HAS_ACTIVE_SCOPE_LINKS");
    await expect(admin.client.mutation(updateOrganizationalJurisdiction, {
      id: jurisdictionId,
      visibility: "public",
      scopeMode: "global",
      geographicJurisdictionIds: [],
      productionBucketId: "11835",
      reason: "Make organization scope global",
    })).resolves.toMatchObject({ visibility: "public" });
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: jurisdictionId,
      reason: "Retire global organization rules",
    })).resolves.toMatchObject({ status: "archived" });
  });

  it("fails closed for corrupt ancestor state at every bounded hop", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const { ancestorId, ancestorProfileId, parentId } = await t.run(async (ctx) => {
      const now = Date.now();
      const ancestorId = await ctx.db.insert("jurisdictions", {
        name: "Corrupt ancestor",
        slug: "corrupt-ancestor",
        status: "enabled",
        isDefault: false,
        productionBucketId: "12101",
        providerSyncState: "pending",
        kind: "organizational",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const ancestorProfileId = await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: ancestorId,
        googlePlaceId: "corrupt-ancestor-place",
        level: "country",
        countryCode: "GH",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Corrupt ancestor",
        createdAt: now,
        updatedAt: now,
      });
      const parentId = await ctx.db.insert("jurisdictions", {
        name: "Immediate district",
        slug: "immediate-district",
        status: "enabled",
        isDefault: false,
        productionBucketId: "12102",
        providerSyncState: "pending",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: parentId,
        googlePlaceId: "immediate-district-place",
        level: "district",
        latitude: 5.1,
        longitude: 0,
        formattedAddress: "Immediate district",
        parentJurisdictionId: ancestorId,
        createdAt: now,
        updatedAt: now,
      });
      return { ancestorId, ancestorProfileId, parentId };
    });

    await expect(createGeo(admin, {
      name: "Kind rejected",
      placeId: "kind-rejected",
      level: "town",
      parentJurisdictionId: parentId,
    })).rejects.toThrow("GEOGRAPHIC_PARENT_CHAIN_INVALID");

    await t.run((ctx) => ctx.db.patch(ancestorId, {
      kind: "geographic",
      status: "archived",
    }));
    await expect(createGeo(admin, {
      name: "Archived rejected",
      placeId: "archived-rejected",
      level: "town",
      parentJurisdictionId: parentId,
    })).rejects.toThrow("GEOGRAPHIC_PARENT_CHAIN_INVALID");

    await t.run(async (ctx) => {
      const now = Date.now();
      const rootId = await ctx.db.insert("jurisdictions", {
        name: "Valid root",
        slug: "valid-corrupt-test-root",
        status: "enabled",
        isDefault: false,
        productionBucketId: "12103",
        providerSyncState: "pending",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: rootId,
        googlePlaceId: "valid-corrupt-test-root-place",
        level: "country",
        countryCode: "GH",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Valid root",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(ancestorId, { status: "enabled" });
      await ctx.db.patch(ancestorProfileId, {
        level: "district",
        parentJurisdictionId: rootId,
      });
    });
    await expect(createGeo(admin, {
      name: "Same level rejected",
      placeId: "same-level-rejected",
      level: "town",
      parentJurisdictionId: parentId,
    })).rejects.toThrow("GEOGRAPHIC_PARENT_LEVEL_INVALID");

    await t.run(async (ctx) => {
      await ctx.db.patch(ancestorProfileId, {
        level: "country",
        parentJurisdictionId: undefined,
      });
      await ctx.db.delete(ancestorId);
    });
    await expect(createGeo(admin, {
      name: "Missing ancestor rejected",
      placeId: "missing-ancestor-rejected",
      level: "town",
      parentJurisdictionId: parentId,
    })).rejects.toThrow("GEOGRAPHIC_PARENT_CHAIN_INVALID");
  });

  it("rejects an enabled cross-kind row with a geographic profile as organization scope", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const { organizationId, corruptScopeId } = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Scoped organization",
        slug: "scoped-organization",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const corruptScopeId = await ctx.db.insert("jurisdictions", {
        name: "Not a geography",
        slug: "not-a-geography",
        status: "enabled",
        isDefault: false,
        productionBucketId: "12201",
        providerSyncState: "pending",
        kind: "organizational",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: corruptScopeId,
        googlePlaceId: "cross-kind-place",
        level: "country",
        countryCode: "GH",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Cross-kind row",
        createdAt: now,
        updatedAt: now,
      });
      return { organizationId, corruptScopeId };
    });

    await expect(admin.client.mutation(createOrganizationalJurisdiction, {
      organizationId,
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: [corruptScopeId],
      reason: "Reject corrupt scope target",
    })).rejects.toThrow("GEOGRAPHIC_SCOPE_INVALID");
  });

  it("records bounded geographic and organizational audit differences", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const countryId = await createGeo(admin, {
      name: "Ghana",
      placeId: "audit-ghana",
      level: "country",
      productionBucketId: "12301",
    });
    await admin.client.mutation(enableJurisdiction, { id: countryId, reason: "Publish Ghana" });
    const firstRegionId = await createGeo(admin, {
      name: "First Region",
      placeId: "audit-region-1",
      level: "region",
      parentJurisdictionId: countryId,
      productionBucketId: "12302",
    });
    const secondRegionId = await createGeo(admin, {
      name: "Second Region",
      placeId: "audit-region-2",
      level: "region",
      parentJurisdictionId: countryId,
      productionBucketId: "12303",
    });
    await admin.client.mutation(enableJurisdiction, { id: firstRegionId, reason: "Publish first" });
    await admin.client.mutation(enableJurisdiction, { id: secondRegionId, reason: "Publish second" });

    const firstTownClaim = await issueVerifiedPlaceClaim(admin.userId, {
      ...place("Audit Town", "audit-town-v1"),
      aliases: ["Old Audit Alias"],
    });
    const townId = await admin.client.mutation(createGeographicJurisdiction, {
      verifiedPlaceClaim: firstTownClaim,
      level: "town",
      parentJurisdictionId: firstRegionId,
      stagingBucketId: "staging-old",
      productionBucketId: "12304",
      reason: "Create audited town",
    });
    const secondTownClaim = await issueVerifiedPlaceClaim(admin.userId, {
      ...place("Audit Town", "audit-town-v2"),
      aliases: ["New Audit Alias"],
    });
    await admin.client.mutation(updateGeographicJurisdiction, {
      id: townId,
      verifiedPlaceClaim: secondTownClaim,
      level: "town",
      parentJurisdictionId: secondRegionId,
      stagingBucketId: "staging-new",
      productionBucketId: "12305",
      reason: "Reparent audited town",
    });
    await admin.client.mutation(enableJurisdiction, {
      id: townId,
      reason: "Publish audited town",
    });

    const organizationId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("organizations", {
        name: "Audit University",
        slug: "audit-university",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    const organizationJurisdictionId = await admin.client.mutation(
      createOrganizationalJurisdiction,
      {
        organizationId,
        visibility: "members",
        scopeMode: "linked_geographies",
        geographicJurisdictionIds: [firstRegionId],
        productionBucketId: "12306",
        reason: "Create audited organization",
      },
    );
    await admin.client.mutation(updateOrganizationalJurisdiction, {
      id: organizationJurisdictionId,
      visibility: "members",
      scopeMode: "linked_geographies",
      geographicJurisdictionIds: [secondRegionId],
      productionBucketId: "12307",
      reason: "Change audited organization scope",
    });

    const { townAudits, organizationAudits } = await t.run(async (ctx) => ({
      townAudits: await ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "jurisdiction").eq("targetId", townId),
        )
        .take(10),
      organizationAudits: await ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "jurisdiction").eq("targetId", organizationJurisdictionId),
        )
        .take(10),
    }));
    const townCreateAfter = JSON.parse(townAudits[0].afterSummary!);
    const townUpdateBefore = JSON.parse(townAudits[1].beforeSummary!);
    const townUpdateAfter = JSON.parse(townAudits[1].afterSummary!);
    const townEnableAfter = JSON.parse(townAudits[2].afterSummary!);
    expect(townCreateAfter).toMatchObject({
      common: { stagingBucketId: "staging-old", productionBucketId: "12304" },
      geographic: {
        googlePlaceId: "audit-town-v1",
        parentJurisdictionId: firstRegionId,
        aliases: ["audit town", "old audit alias"],
      },
    });
    expect(townUpdateBefore.geographic.parentJurisdictionId).toBe(firstRegionId);
    expect(townUpdateAfter).toMatchObject({
      common: { stagingBucketId: "staging-new", productionBucketId: "12305" },
      geographic: {
        googlePlaceId: "audit-town-v2",
        parentJurisdictionId: secondRegionId,
        aliases: ["audit town", "new audit alias"],
      },
    });
    expect(townEnableAfter).toMatchObject({
      common: { status: "enabled", productionBucketId: "12305" },
      geographic: {
        googlePlaceId: "audit-town-v2",
        parentJurisdictionId: secondRegionId,
        aliases: ["audit town", "new audit alias"],
      },
    });

    const organizationCreateAfter = JSON.parse(organizationAudits[0].afterSummary!);
    const organizationUpdateBefore = JSON.parse(organizationAudits[1].beforeSummary!);
    const organizationUpdateAfter = JSON.parse(organizationAudits[1].afterSummary!);
    expect(organizationCreateAfter.organizational.geographicJurisdictionIds).toEqual([
      firstRegionId,
    ]);
    expect(organizationUpdateBefore.organizational.geographicJurisdictionIds).toEqual([
      firstRegionId,
    ]);
    expect(organizationUpdateAfter).toMatchObject({
      common: { productionBucketId: "12307" },
      organizational: { geographicJurisdictionIds: [secondRegionId] },
    });
  });

  it("enforces lifecycle guards for migrated legacy geographic profiles", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    const { ancestorId, ancestorProfileId, childId } = await t.run(async (ctx) => {
      const now = Date.now();
      const ancestorId = await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana-legacy-profile",
        status: "archived",
        isDefault: false,
        productionBucketId: "12401",
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const ancestorProfileId = await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: ancestorId,
        googlePlaceId: "legacy-ghana-place",
        level: "country",
        countryCode: "GH",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Ghana",
        createdAt: now,
        updatedAt: now,
      });
      const childId = await ctx.db.insert("jurisdictions", {
        code: "AC",
        name: "Legacy Accra",
        slug: "legacy-accra-profile",
        status: "draft",
        isDefault: false,
        productionBucketId: "12402",
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: childId,
        googlePlaceId: "legacy-accra-place",
        level: "town",
        latitude: 5.6,
        longitude: 0,
        formattedAddress: "Legacy Accra",
        parentJurisdictionId: ancestorId,
        createdAt: now,
        updatedAt: now,
      });
      return { ancestorId, ancestorProfileId, childId };
    });

    await expect(admin.client.mutation(enableJurisdiction, {
      id: childId,
      reason: "Reject archived legacy parent",
    })).rejects.toThrow("GEOGRAPHIC_PARENT_REQUIRED");
    await t.run((ctx) => ctx.db.patch(ancestorId, { status: "enabled" }));
    await admin.client.mutation(enableJurisdiction, {
      id: childId,
      reason: "Publish migrated legacy child",
    });
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: ancestorId,
      reason: "Reject enabled legacy child",
    })).rejects.toThrow("JURISDICTION_HAS_ENABLED_CHILDREN");

    await t.run((ctx) => ctx.db.patch(childId, {
      kind: "organizational",
      status: "archived",
    }));
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: ancestorId,
      reason: "Reject corrupt legacy child",
    })).rejects.toThrow("GEOGRAPHIC_CHILD_STATE_INVALID");

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(childId, { kind: undefined });
      const organizationId = await ctx.db.insert("organizations", {
        name: "Legacy scope organization",
        slug: "legacy-scope-organization",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const commonId = await ctx.db.insert("jurisdictions", {
        name: "Legacy scope rules",
        slug: "legacy-scope-rules",
        status: "draft",
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
      const organizationalProfileId = await ctx.db.insert("organizationalJurisdictions", {
        jurisdictionId: commonId,
        scopeMode: "linked_geographies",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: organizationalProfileId,
        geographicJurisdictionId: ancestorProfileId,
        createdAt: now,
      });
    });
    await expect(admin.client.mutation(archiveJurisdiction, {
      id: ancestorId,
      reason: "Reject legacy active scope link",
    })).rejects.toThrow("JURISDICTION_HAS_ACTIVE_SCOPE_LINKS");
  });
});

describe("administration catalog projections", () => {
  beforeEach(() => {
    process.env.PLACE_CLAIM_SECRET = "test-place-claim-secret-that-is-at-least-32-bytes";
  });

  afterEach(() => {
    delete process.env.PLACE_CLAIM_SECRET;
    delete process.env.ADMIN_PANEL_ENABLED;
    delete process.env.ADMIN_ENVIRONMENT;
  });

  it("requires enabled jurisdiction read-or-write authority before catalog enumeration", async () => {
    const t = createBackend();
    const writer = await asAdmin(t, "content_manager");
    const reader = await asAdmin(t, "auditor");
    const forbidden = await asAdmin(t, "content_reviewer");
    const geographicArgs = {
      purpose: "linked_scope",
      paginationOpts: { numItems: 20, cursor: null },
    };
    const tableArgs = { paginationOpts: { numItems: 20, cursor: null } };
    const aliasArgs = { childLevel: "town", aliases: ["ghana"] };

    await expect(t.query(listAdminJurisdictions, tableArgs)).rejects.toThrow(
      "ADMIN_AUTH_REQUIRED",
    );
    await expect(writer.client.query(listGeographicJurisdictionOptions, geographicArgs))
      .rejects.toThrow("ADMIN_DISABLED");
    await enablePanel(t);
    await expect(forbidden.client.query(listAdminJurisdictions, tableArgs)).rejects.toThrow(
      "ADMIN_FORBIDDEN",
    );
    await expect(forbidden.client.query(suggestGeographicParentsByAliases, aliasArgs))
      .rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(writer.client.query(listAdminJurisdictions, tableArgs)).resolves.toMatchObject({
      page: [],
    });
    await expect(reader.client.query(listGeographicJurisdictionOptions, geographicArgs))
      .resolves.toMatchObject({ page: [] });
    await expect(reader.client.query(suggestGeographicParentsByAliases, aliasArgs))
      .resolves.toEqual([]);
  });

  it("returns only eligible governed geographic options with safe bounded pagination", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reader = await asAdmin(t, "auditor");
    const { countryId, regionId, townId } = await t.run(async (ctx) => {
      const now = Date.now();
      const insertGeographic = async (
        name: string,
        slug: string,
        level: "country" | "region" | "town",
        status: "draft" | "enabled" | "archived",
        parentJurisdictionId?: Id<"jurisdictions">,
      ) => {
        const jurisdictionId = await ctx.db.insert("jurisdictions", {
          name,
          slug,
          status,
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
          jurisdictionId,
          googlePlaceId: `secret-place-${slug}`,
          level,
          latitude: 5,
          longitude: 0,
          formattedAddress: `Secret ${name} address`,
          parentJurisdictionId,
          createdAt: now,
          updatedAt: now,
        });
        return jurisdictionId;
      };
      const countryId = await insertGeographic("Ghana", "ghana", "country", "enabled");
      const regionId = await insertGeographic(
        "Greater Accra Region",
        "greater-accra-region",
        "region",
        "enabled",
        countryId,
      );
      const townId = await insertGeographic("Accra", "accra", "town", "enabled", regionId);
      await insertGeographic("Draft Region", "draft-region", "region", "draft", countryId);
      await insertGeographic("Archived Region", "archived-region", "region", "archived", countryId);
      await ctx.db.insert("jurisdictions", {
        code: "ZZ",
        name: "Legacyland",
        slug: "legacyland",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jurisdictions", {
        name: "Organization Rules",
        slug: "organization-rules",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        kind: "organizational",
        visibility: "members",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      return { countryId, regionId, townId };
    });

    await expect(reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "parent",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("INVALID_GEOGRAPHIC_OPTION_REQUEST");
    await expect(reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      childLevel: "town",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("INVALID_GEOGRAPHIC_OPTION_REQUEST");
    await expect(reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      paginationOpts: { numItems: 21, cursor: null },
    })).rejects.toThrow("INVALID_ADMIN_PAGINATION");

    const parentPage = await reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "parent",
      childLevel: "town",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(parentPage.page.map((row: { id: string }) => row.id)).toEqual([
      countryId,
      regionId,
    ]);
    expect(parentPage.page[1]).toEqual({
      id: regionId,
      name: "Greater Accra Region",
      level: "region",
      parent: { id: countryId, name: "Ghana", level: "country" },
    });
    expect(JSON.stringify(parentPage.page)).not.toContain("secret-place-");
    expect(JSON.stringify(parentPage.page)).not.toContain("Secret Ghana address");

    const linkedPage = await reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      query: "  Accra  ",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(linkedPage.page.map((row: { id: string }) => row.id).sort()).toEqual(
      [regionId, townId].sort(),
    );
  });

  it("suggests exact normalized aliases without authorizing an invalid parent", async () => {
    const t = createBackend();
    await enablePanel(t);
    const writer = await asAdmin(t, "content_manager");
    const { countryId, draftCountryId } = await t.run(async (ctx) => {
      const now = Date.now();
      const countryId = await ctx.db.insert("jurisdictions", {
        name: "Ghana",
        slug: "ghana-alias",
        status: "enabled",
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
        jurisdictionId: countryId,
        googlePlaceId: "secret-google-ghana",
        level: "country",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Secret Ghana address",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictionAliases", {
        jurisdictionId: countryId,
        normalizedAlias: "ghana",
        source: "secret-provider-source",
        createdAt: now,
      });
      const broaderNameOnlyId = await ctx.db.insert("jurisdictions", {
        name: "Greater Ghana",
        slug: "greater-ghana-alias",
        status: "enabled",
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
        jurisdictionId: broaderNameOnlyId,
        googlePlaceId: "secret-google-greater-ghana",
        level: "country",
        latitude: 5,
        longitude: 0,
        formattedAddress: "Secret Greater Ghana address",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictionAliases", {
        jurisdictionId: broaderNameOnlyId,
        normalizedAlias: "greater ghana",
        source: "secret-provider-source",
        createdAt: now,
      });
      for (let index = 0; index < 21; index += 1) {
        const aliasCandidateId = await ctx.db.insert("jurisdictions", {
          name: `Alias Candidate ${index}`,
          slug: `alias-candidate-${index}`,
          status: "enabled",
          isDefault: false,
          providerSyncState: "pending",
          kind: "geographic",
          visibility: "public",
          createdBy: "fixture",
          updatedBy: "fixture",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictions", {
          jurisdictionId: aliasCandidateId,
          googlePlaceId: `alias-candidate-place-${index}`,
          level: "country",
          latitude: 0,
          longitude: 0,
          formattedAddress: `Alias Candidate ${index}`,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictionAliases", {
          jurisdictionId: aliasCandidateId,
          normalizedAlias: `alias ${Math.min(index, 19)}`,
          source: "fixture",
          createdAt: now,
        });
      }
      const draftCountryId = await ctx.db.insert("jurisdictions", {
        name: "Draft Country",
        slug: "draft-country-alias",
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
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: draftCountryId,
        googlePlaceId: "secret-google-draft",
        level: "country",
        latitude: 0,
        longitude: 0,
        formattedAddress: "Secret draft address",
        createdAt: now,
        updatedAt: now,
      });
      return { countryId, draftCountryId };
    });

    const suggestions = await writer.client.query(suggestGeographicParentsByAliases, {
      childLevel: "town",
      aliases: ["  GHANA  ", "ghana"],
    });
    expect(suggestions).toEqual([
      { id: countryId, name: "Ghana", level: "country", parent: null },
    ]);
    expect(JSON.stringify(suggestions)).not.toContain("greater ghana");
    expect(suggestions.map((row: { name: string }) => row.name)).not.toContain(
      "Greater Ghana",
    );
    expect(JSON.stringify(suggestions)).not.toContain("secret-");
    const capped = await writer.client.query(suggestGeographicParentsByAliases, {
      childLevel: "town",
      aliases: Array.from({ length: 20 }, (_, index) => `alias ${index}`),
    });
    expect(capped).toHaveLength(20);
    await expect(writer.client.query(suggestGeographicParentsByAliases, {
      childLevel: "town",
      aliases: Array.from({ length: 21 }, (_, index) => `alias ${index}`),
    })).rejects.toThrow("INVALID_GEOGRAPHIC_ALIASES");
    await expect(writer.client.query(suggestGeographicParentsByAliases, {
      childLevel: "town",
      aliases: Array.from({ length: 21 }, () => "ghana"),
    })).rejects.toThrow("INVALID_GEOGRAPHIC_ALIASES");

    const claim = await issueVerifiedPlaceClaim(
      writer.userId,
      place("Alias Suggested Town", "alias-suggested-town"),
    );
    await expect(writer.client.mutation(createGeographicJurisdiction, {
      verifiedPlaceClaim: claim,
      level: "town",
      parentJurisdictionId: draftCountryId,
      reason: "Browser alias must not authorize a draft parent",
    })).rejects.toThrow("GEOGRAPHIC_PARENT_REQUIRED");
  });

  it("projects typed and legacy table rows through every bounded index branch", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reader = await asAdmin(t, "auditor");
    const { countryId, organizationId, organizationalJurisdictionId } = await t.run(
      async (ctx) => {
        const now = Date.now();
        const countryId = await ctx.db.insert("jurisdictions", {
          name: "Ghana Catalog",
          slug: "ghana-catalog",
          status: "enabled",
          isDefault: false,
          stagingBucketId: "secret-staging-bucket",
          productionBucketId: "secret-production-bucket",
          providerSyncState: "synced",
          kind: "geographic",
          visibility: "public",
          createdBy: "secret-creator",
          updatedBy: "secret-updater",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictions", {
          jurisdictionId: countryId,
          googlePlaceId: "secret-google-place",
          level: "country",
          latitude: 5,
          longitude: 0,
          formattedAddress: "Secret formatted address",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("geographicJurisdictionAliases", {
          jurisdictionId: countryId,
          normalizedAlias: "secret-alias",
          source: "secret-provider-source",
          createdAt: now,
        });
        const organizationId = await ctx.db.insert("organizations", {
          name: "Example University",
          slug: "example-university-catalog",
          class: "university",
          website: "https://secret-organization.example.com/",
          status: "active",
          createdBy: "secret-organization-creator",
          updatedBy: "secret-organization-updater",
          createdAt: now,
          updatedAt: now,
        });
        const organizationalJurisdictionId = await ctx.db.insert("jurisdictions", {
          name: "Example University Rules",
          slug: "example-university-rules-catalog",
          status: "draft",
          isDefault: false,
          providerSyncState: "drifted",
          kind: "organizational",
          visibility: "members",
          organizationId,
          createdBy: "secret-creator",
          updatedBy: "secret-updater",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("organizationalJurisdictions", {
          jurisdictionId: organizationalJurisdictionId,
          scopeMode: "linked_geographies",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("jurisdictions", {
          code: "LG",
          name: "Legacy Catalog",
          slug: "legacy-catalog",
          status: "archived",
          isDefault: false,
          providerSyncState: "failed",
          createdBy: "secret-creator",
          updatedBy: "secret-updater",
          createdAt: now,
          updatedAt: now,
        });
        for (let index = 0; index < 20; index += 1) {
          await ctx.db.insert("jurisdictions", {
            name: `Paged Legacy ${String(index).padStart(2, "0")}`,
            slug: `paged-legacy-${index}`,
            status: "enabled",
            isDefault: false,
            providerSyncState: "pending",
            createdBy: "fixture",
            updatedBy: "fixture",
            createdAt: now + index,
            updatedAt: now + index,
          });
        }
        return { countryId, organizationId, organizationalJurisdictionId };
      },
    );

    await expect(reader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 21, cursor: null },
    })).rejects.toThrow("INVALID_ADMIN_PAGINATION");
    const first = await reader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(first.page).toHaveLength(20);
    expect(first.isDone).toBe(false);
    const second = await reader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    });
    expect(second.page.length).toBeGreaterThan(0);

    const byKind = await reader.client.query(listAdminJurisdictions, {
      kind: "geographic",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(byKind.page.map((row: { id: string }) => row.id)).toContain(countryId);
    const byStatus = await reader.client.query(listAdminJurisdictions, {
      status: "draft",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(byStatus.page).toHaveLength(1);
    const byKindAndStatus = await reader.client.query(listAdminJurisdictions, {
      kind: "organizational",
      status: "draft",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(byKindAndStatus.page).toHaveLength(1);

    for (const filters of [
      {},
      { kind: "organizational" },
      { status: "draft" },
      { kind: "organizational", status: "draft" },
    ]) {
      const searched = await reader.client.query(listAdminJurisdictions, {
        ...filters,
        query: "  University Rules  ",
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(searched.page.map((row: { id: string }) => row.id)).toEqual([
        organizationalJurisdictionId,
      ]);
    }

    const typedOrganization = byKindAndStatus.page[0];
    expect(typedOrganization).toMatchObject({
      id: organizationalJurisdictionId,
      migrationState: "typed",
      geographic: null,
      organization: {
        id: organizationId,
        name: "Example University",
        slug: "example-university-catalog",
        class: "university",
        status: "active",
      },
      provider: {
        syncState: "drifted",
        stagingConfigured: false,
        productionConfigured: false,
      },
      scopeMode: "linked_geographies",
    });
    const safePayload = JSON.stringify([...first.page, ...second.page]);
    for (const secret of [
      "secret-staging-bucket",
      "secret-production-bucket",
      "secret-google-place",
      "Secret formatted address",
      "secret-alias",
      "secret-provider-source",
      "secret-creator",
      "secret-updater",
      "secret-organization.example.com",
    ]) {
      expect(safePayload).not.toContain(secret);
    }
    const legacy = [...first.page, ...second.page].find(
      (row: { name: string }) => row.name === "Legacy Catalog",
    );
    expect(legacy).toMatchObject({
      kind: "geographic",
      visibility: "public",
      migrationState: "legacy",
      geographic: null,
      organization: null,
      scopeMode: null,
    });
  });

  it("fails closed when typed profile, parent, or organization relationships are malformed", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reader = await asAdmin(t, "auditor");
    const missingProfileId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Missing Geographic Profile",
        slug: "missing-geographic-profile",
        status: "enabled",
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

    await expect(reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");
    await expect(reader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");

    await t.run(async (ctx) => {
      await ctx.db.delete(missingProfileId);
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Cross-kind Organization",
        slug: "cross-kind-organization",
        class: "company",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Cross-kind Geography",
        slug: "cross-kind-geography",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        kind: "geographic",
        visibility: "public",
        organizationId,
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId,
        googlePlaceId: "cross-kind-place",
        level: "country",
        latitude: 0,
        longitude: 0,
        formattedAddress: "Cross-kind Geography",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(reader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");

    const t2 = createBackend();
    await enablePanel(t2);
    const reader2 = await asAdmin(t2, "auditor");
    await t2.run(async (ctx) => {
      const now = Date.now();
      const missingOrganization = await ctx.db.insert("organizations", {
        name: "Deleted Organization",
        slug: "deleted-organization",
        class: "company",
        status: "archived",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Broken Organization Rules",
        slug: "broken-organization-rules",
        status: "draft",
        isDefault: false,
        providerSyncState: "pending",
        kind: "organizational",
        visibility: "members",
        organizationId: missingOrganization,
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
      await ctx.db.delete(missingOrganization);
    });
    await expect(reader2.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");
  });

  it("fails closed on non-public typed geography and hybrid legacy rows", async () => {
    const typedBackend = createBackend();
    await enablePanel(typedBackend);
    const typedReader = await asAdmin(typedBackend, "auditor");
    await typedBackend.run(async (ctx) => {
      const now = Date.now();
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Members-only Geography",
        slug: "members-only-geography",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        kind: "geographic",
        visibility: "members",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId,
        googlePlaceId: "members-only-geography",
        level: "country",
        latitude: 0,
        longitude: 0,
        formattedAddress: "Members-only Geography",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(typedReader.client.query(listGeographicJurisdictionOptions, {
      purpose: "linked_scope",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");
    await expect(typedReader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");

    const legacyBackend = createBackend();
    await enablePanel(legacyBackend);
    const legacyReader = await asAdmin(legacyBackend, "auditor");
    const nonPublicLegacyId = await legacyBackend.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        code: "HY",
        name: "Non-public Legacy",
        slug: "non-public-legacy",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        visibility: "members",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(legacyReader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");

    await legacyBackend.run(async (ctx) => {
      await ctx.db.delete(nonPublicLegacyId);
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Hybrid Legacy Organization",
        slug: "hybrid-legacy-organization",
        class: "company",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jurisdictions", {
        code: "HZ",
        name: "Organization-linked Legacy",
        slug: "organization-linked-legacy",
        status: "enabled",
        isDefault: false,
        providerSyncState: "pending",
        organizationId,
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(legacyReader.client.query(listAdminJurisdictions, {
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("ADMIN_JURISDICTION_PROJECTION_INVALID");
  });
});
