/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "./jurisdictionDomain";

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
      /SECRET_|provider|visibility|alias|organization|actor/i,
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

  it("makes missing and existing member-only rows indistinguishable during membership overflow", async () => {
    const t = createBackend();
    const member = await asUser(t, "overflow-member");
    const existing = await insertOrganization(t, {
      visibility: "members",
      scopeMode: "global",
    });
    const missingId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("jurisdictions", {
        name: "Deleted",
        slug: `deleted-${crypto.randomUUID()}`,
        status: "enabled",
        isDefault: false,
        providerSyncState: "synced",
        kind: "organizational",
        visibility: "members",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.delete(id);
      return id;
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index <= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS; index += 1) {
        const organizationId = index === 0
          ? existing.organizationId
          : await ctx.db.insert("organizations", {
              name: `Overflow ${index}`,
              slug: `overflow-${index}-${crypto.randomUUID()}`,
              class: "other",
              status: "active",
              createdBy: "fixture",
              updatedBy: "fixture",
              createdAt: now,
              updatedAt: now,
            });
        await ctx.db.insert("organizationMemberships", {
          organizationId,
          userId: member.userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    for (const jurisdictionId of [missingId, existing.jurisdictionId]) {
      await expect(member.client.query(resolveResearchScope, {
        jurisdictionId,
        geographicHints: [],
      })).rejects.toThrow("JURISDICTION_ACCESS_DENIED");
    }
  });

  it("maps duplicate membership corruption to the same public access denial", async () => {
    const t = createBackend();
    const member = await asUser(t, "duplicate-member");
    const existing = await insertOrganization(t, {
      visibility: "members",
      scopeMode: "global",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert("organizationMemberships", {
          organizationId: existing.organizationId,
          userId: member.userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await expect(member.client.query(resolveResearchScope, {
      jurisdictionId: existing.jurisdictionId,
      geographicHints: [],
    })).rejects.toThrow("JURISDICTION_ACCESS_DENIED");
  });

  it.each([
    "missing",
    "disabled",
    "wrong-kind",
    "duplicate-profile",
    "invalid-level",
  ])("stops before a %s ancestor without skipping across it", async (corruption) => {
    const t = createBackend();
    const country = await insertGeographic(t, { name: "Country", level: "country" });
    const town = await insertGeographic(t, {
      name: "Town",
      level: "town",
      parentJurisdictionId: country.jurisdictionId,
    });
    await t.run(async (ctx) => {
      if (corruption === "missing") await ctx.db.delete(country.jurisdictionId);
      if (corruption === "disabled") await ctx.db.patch(country.jurisdictionId, { status: "archived" });
      if (corruption === "wrong-kind") await ctx.db.patch(country.jurisdictionId, { kind: "organizational" });
      if (corruption === "invalid-level") await ctx.db.patch(country.profileId, { level: "town" });
      if (corruption === "duplicate-profile") {
        const now = Date.now();
        await ctx.db.insert("geographicJurisdictions", {
          jurisdictionId: country.jurisdictionId,
          googlePlaceId: `duplicate-${crypto.randomUUID()}`,
          level: "country",
          latitude: 0,
          longitude: 0,
          formattedAddress: "Duplicate Country",
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: town.jurisdictionId,
      geographicHints: [],
    });
    expect(scope.items.map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual([town.jurisdictionId]);
  });

  it("terminates an actual stored parent cycle without duplicating an item", async () => {
    const t = createBackend();
    const region = await insertGeographic(t, { name: "Region", level: "region" });
    const town = await insertGeographic(t, {
      name: "Town",
      level: "town",
      parentJurisdictionId: region.jurisdictionId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(region.profileId, {
        parentJurisdictionId: town.jurisdictionId,
      });
    });
    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: town.jurisdictionId,
      geographicHints: [],
    });
    expect(scope.items.map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual([town.jurisdictionId, region.jurisdictionId]);
  });

  it.each(["inactive", "global-linked", "linked-empty", "duplicate-links"])(
    "fails closed for %s organizational scope state",
    async (corruption) => {
      const t = createBackend();
      const geography = await insertGeographic(t, { name: "Ghana", level: "country" });
      const organization = await insertOrganization(t, {
        visibility: "public",
        scopeMode: corruption === "linked-empty" || corruption === "duplicate-links"
          ? "linked_geographies"
          : "global",
      });
      await t.run(async (ctx) => {
        if (corruption === "inactive") {
          await ctx.db.patch(organization.organizationId, { status: "archived" });
        }
        if (corruption === "global-linked") {
          await ctx.db.insert("organizationGeographicScopes", {
            organizationalJurisdictionId: organization.profileId,
            geographicJurisdictionId: geography.profileId,
            createdAt: Date.now(),
          });
        }
        if (corruption === "duplicate-links") {
          for (let index = 0; index < 2; index += 1) {
            await ctx.db.insert("organizationGeographicScopes", {
              organizationalJurisdictionId: organization.profileId,
              geographicJurisdictionId: geography.profileId,
              createdAt: Date.now(),
            });
          }
        }
      });
      await expect(t.query(resolveResearchScope, {
        jurisdictionId: organization.jurisdictionId,
        geographicHints: [],
      })).rejects.toThrow("JURISDICTION_SCOPE_STATE_INVALID");
    },
  );

  it("rejects an eleven-row alias overflow and a stale alias target", async () => {
    const overflowBackend = createBackend();
    const place = await insertGeographic(overflowBackend, { name: "Accra", level: "country" });
    const organization = await insertOrganization(overflowBackend, {
      visibility: "public",
      scopeMode: "global",
    });
    for (let index = 0; index < 11; index += 1) {
      await addAlias(overflowBackend, place.jurisdictionId, "accra");
    }
    const overflow = await overflowBackend.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
      geographicHints: ["Accra"],
    });
    expect(overflow.items).toHaveLength(1);

    const staleBackend = createBackend();
    const stalePlace = await insertGeographic(staleBackend, { name: "Stale", level: "country" });
    await addAlias(staleBackend, stalePlace.jurisdictionId, "stale");
    const staleOrganization = await insertOrganization(staleBackend, {
      visibility: "public",
      scopeMode: "global",
    });
    await staleBackend.run(async (ctx) => await ctx.db.delete(stalePlace.jurisdictionId));
    const stale = await staleBackend.query(resolveResearchScope, {
      jurisdictionId: staleOrganization.jurisdictionId,
      geographicHints: ["Stale"],
    });
    expect(stale.items).toHaveLength(1);
  });

  it("ignores malformed and overlong hints while canonical duplicates expand only once", async () => {
    const t = createBackend();
    const accra = await insertGeographic(t, { name: "Accra", level: "country" });
    await addAlias(t, accra.jurisdictionId, "accra");
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "global",
    });
    const ignored = await t.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
      geographicHints: ["   ", "x".repeat(201)],
    });
    expect(ignored.items).toHaveLength(1);
    const deduplicated = await t.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
      geographicHints: ["Accra", "  ACCRA  "],
    });
    expect(deduplicated.items.map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual([organization.jurisdictionId, accra.jurisdictionId]);
  });

  it("preserves three-hint order, deduplicates shared ancestors, and hides provider state", async () => {
    const t = createBackend();
    const country = await insertGeographic(t, { name: "Ghana", level: "country" });
    const places = [];
    for (const name of ["Accra", "Tema", "Ada"]) {
      const place = await insertGeographic(t, {
        name,
        level: "town",
        parentJurisdictionId: country.jurisdictionId,
      });
      await addAlias(t, place.jurisdictionId, name.toLowerCase());
      places.push(place);
    }
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "global",
    });
    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
      geographicHints: ["Tema", "Accra", "Ada"],
    });
    expect(scope.items.map((item: { jurisdictionId: string }) => item.jurisdictionId)).toEqual([
      organization.jurisdictionId,
      places[1].jurisdictionId,
      country.jurisdictionId,
      places[0].jurisdictionId,
      places[2].jurisdictionId,
    ]);
    expect(JSON.stringify(scope)).not.toMatch(/provider|visibility/i);
  });

  it("caps three independent hint hierarchies at eight geographic nodes", async () => {
    const t = createBackend();
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "global",
    });
    const hints: string[] = [];
    const allIds: string[] = [];
    for (let branch = 0; branch < 3; branch += 1) {
      const country = await insertGeographic(t, { name: `Country ${branch}`, level: "country" });
      const region = await insertGeographic(t, {
        name: `Region ${branch}`,
        level: "region",
        parentJurisdictionId: country.jurisdictionId,
      });
      const district = await insertGeographic(t, {
        name: `District ${branch}`,
        level: "district",
        parentJurisdictionId: region.jurisdictionId,
      });
      const town = await insertGeographic(t, {
        name: `Town ${branch}`,
        level: "town",
        parentJurisdictionId: district.jurisdictionId,
      });
      const hint = `town ${branch}`;
      await addAlias(t, town.jurisdictionId, hint);
      hints.push(hint);
      allIds.push(town.jurisdictionId, district.jurisdictionId, region.jurisdictionId, country.jurisdictionId);
    }
    const scope = await t.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
      geographicHints: hints,
    });
    expect(scope.items).toHaveLength(9);
    expect(scope.items.slice(1).map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual(allIds.slice(0, 8));
    expect(scope.items.some((item: { jurisdictionId: string }) => item.jurisdictionId === allIds[8]))
      .toBe(false);
  });
});
