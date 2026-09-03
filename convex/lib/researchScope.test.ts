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
  "jurisdictions:resolveChatResearchStores",
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
      geminiFileSearchStoreName: `fileSearchStores/${crypto.randomUUID()}`,
      providerSyncState: "synced",
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
    return { jurisdictionId, profileId };
  });
}

async function insertOrganization(
  t: Backend,
  input: {
    visibility: "public" | "members";
    scopeMode: "global" | "linked_geographies";
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Fixture organization",
      slug: `fixture-${crypto.randomUUID()}`,
      class: "intergovernmental",
      status: "active",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "Fixture authority",
      slug: `fixture-authority-${crypto.randomUUID()}`,
      status: "enabled",
      isDefault: false,
      geminiFileSearchStoreName: `fileSearchStores/${crypto.randomUUID()}`,
      providerSyncState: "synced",
      kind: "organizational",
      visibility: input.visibility,
      organizationId,
      createdBy: "fixture",
      updatedBy: "fixture",
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

async function linkGeography(t: Backend, organizationProfileId: string, geographicProfileId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("organizationGeographicScopes", {
      organizationalJurisdictionId: organizationProfileId as never,
      geographicJurisdictionId: geographicProfileId as never,
      createdAt: Date.now(),
    });
  });
}

describe("deterministic authorized research scope", () => {
  it("caps a selected geographic jurisdiction and nearest ancestors at four stores", async () => {
    const t = createBackend();
    const country = await insertGeographic(t, { name: "Country", level: "country" });
    const region = await insertGeographic(t, { name: "Region", level: "region", parentJurisdictionId: country.jurisdictionId });
    const district = await insertGeographic(t, { name: "District", level: "district", parentJurisdictionId: region.jurisdictionId });
    const city = await insertGeographic(t, { name: "City", level: "city", parentJurisdictionId: district.jurisdictionId });

    const result = await t.query(resolveResearchScope, { jurisdictionId: city.jurisdictionId });

    expect(result.stores.map((item: { jurisdictionId: string; relation: string }) => ({
      jurisdictionId: item.jurisdictionId,
      relation: item.relation,
    }))).toEqual([
      { jurisdictionId: city.jurisdictionId, relation: "selected" },
      { jurisdictionId: district.jurisdictionId, relation: "geographic_ancestor" },
      { jurisdictionId: region.jurisdictionId, relation: "geographic_ancestor" },
      { jurisdictionId: country.jurisdictionId, relation: "geographic_ancestor" },
    ]);
    expect(result.partialCoverage).toBe(false);
  });

  it("keeps a global organization selected-only", async () => {
    const t = createBackend();
    const organization = await insertOrganization(t, { visibility: "public", scopeMode: "global" });
    await insertGeographic(t, { name: "Unrelated", level: "country" });

    const result = await t.query(resolveResearchScope, { jurisdictionId: organization.jurisdictionId });

    expect(result.stores).toEqual([
      expect.objectContaining({
        jurisdictionId: organization.jurisdictionId,
        kind: "organizational",
        relation: "selected",
      }),
    ]);
    expect(result.partialCoverage).toBe(false);
  });

  it("uses at most three direct linked geographies in jurisdiction ID order without ancestors", async () => {
    const t = createBackend();
    const ancestor = await insertGeographic(t, { name: "Ancestor", level: "country" });
    const linked = await Promise.all([
      insertGeographic(t, { name: "Linked D", level: "region", parentJurisdictionId: ancestor.jurisdictionId }),
      insertGeographic(t, { name: "Linked C", level: "country" }),
      insertGeographic(t, { name: "Linked B", level: "country" }),
      insertGeographic(t, { name: "Linked A", level: "country" }),
    ]);
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "linked_geographies",
    });
    const reverseById = [...linked].sort((a, b) => b.jurisdictionId.localeCompare(a.jurisdictionId));
    for (const geography of reverseById) {
      await linkGeography(t, organization.profileId, geography.profileId);
    }
    const expected = [...linked]
      .sort((a, b) => a.jurisdictionId.localeCompare(b.jurisdictionId))
      .slice(0, 3)
      .map((item) => item.jurisdictionId);

    const result = await t.query(resolveResearchScope, { jurisdictionId: organization.jurisdictionId });

    expect(result.stores.map((item: { jurisdictionId: string }) => item.jurisdictionId)).toEqual([
      organization.jurisdictionId,
      ...expected,
    ]);
    expect(result.stores.slice(1).every((item: { relation: string }) => item.relation === "organizational_geography")).toBe(true);
    expect(result.stores.map((item: { jurisdictionId: string }) => item.jurisdictionId)).not.toContain(ancestor.jurisdictionId);
  });

  it("does not let question-like alias text change organizational scope", async () => {
    const t = createBackend();
    const linked = await insertGeographic(t, { name: "Linked", level: "country" });
    const unlinked = await insertGeographic(t, { name: "Question target", level: "country" });
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "linked_geographies",
    });
    await linkGeography(t, organization.profileId, linked.profileId);
    await t.run(async (ctx) => {
      await ctx.db.insert("geographicJurisdictionAliases", {
        jurisdictionId: unlinked.jurisdictionId,
        normalizedAlias: "question target",
        source: "fixture",
        createdAt: Date.now(),
      });
    });

    const result = await t.query(resolveResearchScope, { jurisdictionId: organization.jurisdictionId });

    expect(result.stores.map((item: { jurisdictionId: string }) => item.jurisdictionId)).toEqual([
      organization.jurisdictionId,
      linked.jurisdictionId,
    ]);
  });

  it("stops at the selected node when the immediate geographic parent is disabled", async () => {
    const t = createBackend();
    const country = await insertGeographic(t, { name: "Country", level: "country" });
    const region = await insertGeographic(t, {
      name: "Disabled region",
      level: "region",
      parentJurisdictionId: country.jurisdictionId,
      status: "archived",
    });
    const city = await insertGeographic(t, {
      name: "City",
      level: "city",
      parentJurisdictionId: region.jurisdictionId,
    });

    const result = await t.query(resolveResearchScope, { jurisdictionId: city.jurisdictionId });

    expect(result.stores.map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual([city.jurisdictionId]);
  });

  it("fails closed for denied, disabled, and malformed selected jurisdictions", async () => {
    const t = createBackend();
    const outsider = await asUser(t, "outsider");
    const members = await insertOrganization(t, { visibility: "members", scopeMode: "global" });
    const disabled = await insertGeographic(t, { name: "Disabled", level: "country", status: "draft" });
    const malformed = await insertGeographic(t, { name: "Malformed", level: "country" });
    await t.run(async (ctx) => await ctx.db.delete(malformed.profileId as never));

    await expect(outsider.client.query(resolveResearchScope, {
      jurisdictionId: members.jurisdictionId,
    })).rejects.toThrow("JURISDICTION_ACCESS_DENIED");
    await expect(t.query(resolveResearchScope, {
      jurisdictionId: disabled.jurisdictionId,
    })).rejects.toThrow("JURISDICTION_ACCESS_DENIED");
    await expect(t.query(resolveResearchScope, {
      jurisdictionId: malformed.jurisdictionId,
    })).rejects.toThrow("JURISDICTION_SCOPE_STATE_INVALID");
  });

  it("rejects duplicate organization links", async () => {
    const t = createBackend();
    const linked = await insertGeographic(t, { name: "Linked", level: "country" });
    const organization = await insertOrganization(t, {
      visibility: "public",
      scopeMode: "linked_geographies",
    });
    await linkGeography(t, organization.profileId, linked.profileId);
    await linkGeography(t, organization.profileId, linked.profileId);

    await expect(t.query(resolveResearchScope, {
      jurisdictionId: organization.jurisdictionId,
    })).rejects.toThrow("JURISDICTION_SCOPE_STATE_INVALID");
  });

  it.each(["inactive", "global-linked", "linked-empty"] as const)(
    "rejects %s organizational scope state",
    async (corruption) => {
      const t = createBackend();
      const linked = await insertGeographic(t, { name: "Linked", level: "country" });
      const organization = await insertOrganization(t, {
        visibility: "public",
        scopeMode: corruption === "linked-empty" ? "linked_geographies" : "global",
      });
      if (corruption === "inactive") {
        await t.run(async (ctx) => await ctx.db.patch(organization.organizationId, { status: "archived" }));
      }
      if (corruption === "global-linked") {
        await linkGeography(t, organization.profileId, linked.profileId);
      }

      await expect(t.query(resolveResearchScope, {
        jurisdictionId: organization.jurisdictionId,
      })).rejects.toThrow("JURISDICTION_SCOPE_STATE_INVALID");
    },
  );
});
