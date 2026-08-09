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
});
