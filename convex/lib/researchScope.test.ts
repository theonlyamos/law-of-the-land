/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./lib/${path.slice(2)}`,
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
const resolveResearchScope = makeFunctionReference<"query">(
  "jurisdictions:resolveResearchScope",
);

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

type GeographicLevel =
  | "country"
  | "state"
  | "province"
  | "region"
  | "district"
  | "city"
  | "town"
  | "territory"
  | "other_locality";

async function insertGeographic(
  t: Backend,
  input: {
    name: string;
    level: GeographicLevel;
    parentJurisdictionId?: string;
    status?: "draft" | "enabled" | "archived";
    productionBucketId?: string;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: input.name,
      slug: `${input.name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`,
      status: input.status ?? "enabled",
      isDefault: false,
      providerSyncState: "synced",
      kind: "geographic",
      visibility: "public",
      stagingBucketId: "SECRET_STAGING_BUCKET",
      productionBucketId: input.productionBucketId,
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId,
      googlePlaceId: `SECRET_PLACE_${crypto.randomUUID()}`,
      level: input.level,
      latitude: 0,
      longitude: 0,
      formattedAddress: `SECRET_ADDRESS_${input.name}`,
      parentJurisdictionId: input.parentJurisdictionId as never,
      createdAt: now,
      updatedAt: now,
    });
    return { jurisdictionId, profileId };
  });
}

async function insertOrganization(
  t: Backend,
  input: { visibility: "public" | "members"; scopeMode: "global" | "linked_geographies" },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "World Health Organization",
      slug: `who-${crypto.randomUUID()}`,
      class: "intergovernmental",
      status: "active",
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
      createdAt: now,
      updatedAt: now,
    });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "WHO",
      slug: `who-rules-${crypto.randomUUID()}`,
      status: "enabled",
      isDefault: false,
      providerSyncState: "synced",
      kind: "organizational",
      visibility: input.visibility,
      organizationId,
      stagingBucketId: "SECRET_STAGING_BUCKET",
      productionBucketId: "7100",
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("organizationalJurisdictions", {
      jurisdictionId,
      scopeMode: input.scopeMode,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, jurisdictionId, profileId };
  });
}

async function addAlias(t: Backend, jurisdictionId: string, alias: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("geographicJurisdictionAliases", {
      jurisdictionId: jurisdictionId as never,
      normalizedAlias: alias,
      source: "fixture",
      createdAt: Date.now(),
    });
  });
}

describe("authorized research scope", () => {
  it("returns a selected town and verified parents in narrow-to-broad order", async () => {
    const t = createBackend();
    const ghana = await insertGeographic(t, { name: "Ghana", level: "country" });
    const greaterAccra = await insertGeographic(t, {
      name: "Greater Accra",
      level: "region",
      parentJurisdictionId: ghana.jurisdictionId,
    });
    const accra = await insertGeographic(t, {
      name: "Accra",
      level: "town",
      parentJurisdictionId: greaterAccra.jurisdictionId,
      productionBucketId: " 11833 ",
    });

    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: accra.jurisdictionId,
      geographicHints: [],
    });

    expect(scope).toEqual({
      selectedJurisdictionId: accra.jurisdictionId,
      items: [
        { jurisdictionId: accra.jurisdictionId, name: "Accra", kind: "geographic", relation: "selected" },
        { jurisdictionId: greaterAccra.jurisdictionId, name: "Greater Accra", kind: "geographic", relation: "geographic_ancestor" },
        { jurisdictionId: ghana.jurisdictionId, name: "Ghana", kind: "geographic", relation: "geographic_ancestor" },
      ],
    });
    expect(JSON.stringify(scope)).not.toMatch(
      /11833|SECRET_|bucket|provider|visibility|alias|organization|actor/i,
    );
  });

  it("stops at the last verified node when an ancestor is disabled or cyclic", async () => {
    const t = createBackend();
    const country = await insertGeographic(t, {
      name: "Disabled Country",
      level: "country",
      status: "archived",
    });
    const town = await insertGeographic(t, {
      name: "Visible Town",
      level: "town",
      parentJurisdictionId: country.jurisdictionId,
    });

    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: town.jurisdictionId,
      geographicHints: [],
    });
    expect(scope.items.map((item: { name: string }) => item.name)).toEqual(["Visible Town"]);
  });

  it("keeps a global organization selected-only unless one unique valid alias is supplied", async () => {
    const t = createBackend();
    const ghana = await insertGeographic(t, { name: "Ghana", level: "country" });
    const accra = await insertGeographic(t, {
      name: "Accra",
      level: "town",
      parentJurisdictionId: ghana.jurisdictionId,
    });
    await addAlias(t, accra.jurisdictionId, "accra");
    const who = await insertOrganization(t, { visibility: "public", scopeMode: "global" });

    const selectedOnly = await t.query(resolveResearchScope, {
      jurisdictionId: who.jurisdictionId,
      geographicHints: [],
    });
    expect(selectedOnly.items).toHaveLength(1);

    const expanded = await t.query(resolveResearchScope, {
      jurisdictionId: who.jurisdictionId,
      geographicHints: ["  ACCRA  "],
    });
    expect(expanded.items.map((item: { jurisdictionId: string }) => item.jurisdictionId)).toEqual([
      who.jurisdictionId,
      accra.jurisdictionId,
      ghana.jurisdictionId,
    ]);
    expect(expanded.items[1].relation).toBe("organizational_geography");
  });

  it("rejects ambiguous aliases and permits linked geography only through one exact link", async () => {
    const t = createBackend();
    const first = await insertGeographic(t, { name: "First Accra", level: "country" });
    const second = await insertGeographic(t, { name: "Second Accra", level: "country" });
    await addAlias(t, first.jurisdictionId, "accra");
    await addAlias(t, second.jurisdictionId, "accra");
    const linked = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "linked_geographies",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: linked.profileId,
        geographicJurisdictionId: first.profileId,
        createdAt: Date.now(),
      });
    });

    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: linked.jurisdictionId,
      geographicHints: ["Accra"],
    });
    expect(scope.items.map((item: { jurisdictionId: string }) => item.jurisdictionId)).toEqual([
      linked.jurisdictionId,
      first.jurisdictionId,
    ]);
  });

  it("fails closed for inaccessible and corrupt selected organizational state", async () => {
    const t = createBackend();
    const outsider = await asUser(t, "outsider");
    const members = await insertOrganization(t, {
      visibility: "members",
      scopeMode: "global",
    });
    await expect(
      outsider.client.query(resolveResearchScope, {
        jurisdictionId: members.jurisdictionId,
        geographicHints: [],
      }),
    ).rejects.toThrow("JURISDICTION_ACCESS_DENIED");

    await t.run(async (ctx) => {
      await ctx.db.insert("organizationalJurisdictions", {
        jurisdictionId: members.jurisdictionId,
        scopeMode: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("organizationMemberships", {
        organizationId: members.organizationId,
        userId: outsider.userId,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      outsider.client.query(resolveResearchScope, {
        jurisdictionId: members.jurisdictionId,
        geographicHints: [],
      }),
    ).rejects.toThrow("JURISDICTION_SCOPE_STATE_INVALID");
  });

  it("rejects more than three hostile hints before alias expansion", async () => {
    const t = createBackend();
    const who = await insertOrganization(t, { visibility: "public", scopeMode: "global" });
    await expect(
      t.query(resolveResearchScope, {
        jurisdictionId: who.jurisdictionId,
        geographicHints: ["a", "b", "c", "d"],
      }),
    ).rejects.toThrow("INVALID_GEOGRAPHIC_HINTS");
  });

  it("enforces the same hostile-hint bound for a geographic selection", async () => {
    const t = createBackend();
    const ghana = await insertGeographic(t, { name: "Ghana", level: "country" });
    await expect(
      t.query(resolveResearchScope, {
        jurisdictionId: ghana.jurisdictionId,
        geographicHints: ["a", "b", "c", "d"],
      }),
    ).rejects.toThrow("INVALID_GEOGRAPHIC_HINTS");
  });
});
