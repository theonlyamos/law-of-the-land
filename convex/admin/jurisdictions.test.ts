/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
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

async function asAdmin(t: Backend) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Admin fixture",
          email: `admin-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "content_manager",
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
