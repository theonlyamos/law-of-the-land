/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "./lib/jurisdictionDomain";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("./betterAuth/".length)}`,
    load,
  ]),
);

type Backend = TestConvex<typeof schema>;
const searchAccessible = makeFunctionReference<"query">("jurisdictions:searchAccessible");
const isUnifiedJurisdictionsEnabled = makeFunctionReference<"query">(
  "jurisdictions:isUnifiedJurisdictionsEnabled",
);
const listPublicEnabled = makeFunctionReference<"query">("jurisdictions:listPublicEnabled");

const previousEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

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
  input: { name: string; status?: "draft" | "enabled"; visibility?: "public" | "members" },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: input.name,
      slug: input.name.toLowerCase().replaceAll(" ", "-"),
      status: input.status ?? "enabled",
      isDefault: false,
      providerSyncState: "synced",
      kind: "geographic",
      visibility: input.visibility ?? "public",
      stagingBucketId: "SECRET_STAGING_BUCKET",
      productionBucketId: "9911",
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId,
      googlePlaceId: `SECRET_PLACE_${input.name}`,
      level: "country",
      latitude: 0,
      longitude: 0,
      formattedAddress: input.name,
      createdAt: now,
      updatedAt: now,
    });
    return jurisdictionId;
  });
}

async function insertOrganizationJurisdiction(
  t: Backend,
  input: {
    name: string;
    visibility: "public" | "members";
    status?: "draft" | "enabled";
    organizationStatus?: "active" | "archived";
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: input.name,
      slug: `org-${crypto.randomUUID()}`,
      class: "university",
      status: input.organizationStatus ?? "active",
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
      createdAt: now,
      updatedAt: now,
    });
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: input.name,
      slug: `jurisdiction-${crypto.randomUUID()}`,
      status: input.status ?? "enabled",
      isDefault: false,
      providerSyncState: "synced",
      kind: "organizational",
      visibility: input.visibility,
      organizationId,
      productionBucketId: "8822",
      createdBy: "SECRET_ACTOR",
      updatedBy: "SECRET_ACTOR",
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

describe("bounded accessible jurisdiction search", () => {
  it("paginates typed public geographies at twenty without disclosing governed fields", async () => {
    const t = createBackend();
    for (let index = 0; index < 21; index += 1) {
      await insertGeographic(t, { name: `Place ${String(index).padStart(2, "0")}` });
    }
    await insertGeographic(t, { name: "Draft Place", status: "draft" });
    await insertOrganizationJurisdiction(t, { name: "Hidden Organization", visibility: "members" });

    const first = await t.query(searchAccessible, {
      kind: "geographic",
      query: "",
      cursor: null,
    });
    expect(first.group).toBe("geographic");
    expect(first.page).toHaveLength(20);
    expect(first.isDone).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(/SECRET_|productionBucket|visibility|organizationId/);

    const second = await t.query(searchAccessible, {
      kind: "geographic",
      query: "",
      cursor: first.continueCursor,
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
    expect(new Set([...first.page, ...second.page].map((row: { id: string }) => row.id)).size)
      .toBe(21);
  });

  it("uses public lifecycle filters for signed-out text searches", async () => {
    const t = createBackend();
    await insertGeographic(t, { name: "Accra Public" });
    await insertGeographic(t, { name: "Accra Draft", status: "draft" });
    await insertOrganizationJurisdiction(t, { name: "Accra Members", visibility: "members" });

    const result = await t.query(searchAccessible, {
      kind: "geographic",
      query: "  Accra  ",
      cursor: null,
    });
    expect(result.page.map((row: { name: string }) => row.name)).toEqual(["Accra Public"]);
  });

  it("keeps member and public organization phases separate and denies former members", async () => {
    const t = createBackend();
    const member = await asUser(t, "member");
    const former = await asUser(t, "former");
    const owned = await insertOrganizationJurisdiction(t, {
      name: "Member Council Rules",
      visibility: "members",
    });
    await insertOrganizationJurisdiction(t, { name: "Public Council Rules", visibility: "public" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("organizationMemberships", {
        organizationId: owned.organizationId,
        userId: member.userId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("organizationMemberships", {
        organizationId: owned.organizationId,
        userId: former.userId,
        status: "inactive",
        createdAt: now,
        updatedAt: now,
      });
    });

    const memberPage = await member.client.query(searchAccessible, {
      kind: "organizational",
      query: "Council",
      cursor: null,
    });
    expect(memberPage.group).toBe("your_organizations");
    expect(memberPage.page.map((row: { name: string }) => row.name)).toEqual([
      "Member Council Rules",
    ]);
    expect(memberPage.continueCursor).not.toContain("Member Council");

    const publicPage = await member.client.query(searchAccessible, {
      kind: "organizational",
      query: "Council",
      cursor: memberPage.continueCursor,
    });
    expect(publicPage.group).toBe("public_organizations");
    expect(publicPage.page.map((row: { name: string }) => row.name)).toEqual([
      "Public Council Rules",
    ]);

    const formerPage = await former.client.query(searchAccessible, {
      kind: "organizational",
      query: "Council",
      cursor: null,
    });
    expect(JSON.stringify(formerPage)).not.toContain("Member Council Rules");
  });

  it("rejects invalid query and cursor state", async () => {
    const t = createBackend();
    for (let index = 0; index < 21; index += 1) {
      await insertGeographic(t, { name: `Cursor Place ${index}` });
    }
    await expect(
      t.query(searchAccessible, {
        kind: "geographic",
        query: "x".repeat(121),
        cursor: null,
      }),
    ).rejects.toThrow("INVALID_JURISDICTION_SEARCH_QUERY");
    await expect(
      t.query(searchAccessible, { kind: "geographic", query: "", cursor: "not-a-cursor" }),
    ).rejects.toThrow("INVALID_JURISDICTION_SEARCH_CURSOR");

    const first = await t.query(searchAccessible, {
      kind: "geographic",
      query: "",
      cursor: null,
    });
    await expect(
      t.query(searchAccessible, {
        kind: "organizational",
        query: "",
        cursor: first.continueCursor,
      }),
    ).rejects.toThrow("INVALID_JURISDICTION_SEARCH_CURSOR");
  });

  it("fails closed for duplicate and excessive active membership state", async () => {
    const t = createBackend();
    const member = await asUser(t, "bounded-member");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index <= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS; index += 1) {
        const organizationId = await ctx.db.insert("organizations", {
          name: `Organization ${index}`,
          slug: `organization-${index}`,
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
    await expect(
      member.client.query(searchAccessible, {
        kind: "organizational",
        query: "",
        cursor: null,
      }),
    ).rejects.toThrow("ORGANIZATION_MEMBERSHIP_LIMIT");
  });

  it("revalidates membership integrity before an authenticated public continuation", async () => {
    const t = createBackend();
    const member = await asUser(t, "continuation-member");
    for (let index = 0; index < 21; index += 1) {
      await insertOrganizationJurisdiction(t, {
        name: `Public Organization ${String(index).padStart(2, "0")}`,
        visibility: "public",
      });
    }
    const first = await member.client.query(searchAccessible, {
      kind: "organizational",
      query: "",
      cursor: null,
    });
    expect(first.group).toBe("public_organizations");
    expect(first.continueCursor).not.toBeNull();

    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index <= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS; index += 1) {
        const organizationId = await ctx.db.insert("organizations", {
          name: `Membership Organization ${index}`,
          slug: `membership-organization-${index}`,
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

    await expect(
      member.client.query(searchAccessible, {
        kind: "organizational",
        query: "",
        cursor: first.continueCursor,
      }),
    ).rejects.toThrow("ORGANIZATION_MEMBERSHIP_LIMIT");
  });
});

describe("unified selector rollout state", () => {
  it("returns only a fail-closed boolean while preserving the Ghana legacy adapter", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = createBackend();
    await expect(t.query(isUnifiedJurisdictionsEnabled, {})).resolves.toBe(false);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("featureFlags", {
        key: "unified_jurisdictions",
        environment: "test",
        enabled: true,
        updatedAt: now,
      });
      await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        productionBucketId: "11833",
        providerSyncState: "synced",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(t.query(isUnifiedJurisdictionsEnabled, {})).resolves.toBe(true);
    await expect(t.query(listPublicEnabled, {})).resolves.toEqual([
      { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
    ]);
  });
});
