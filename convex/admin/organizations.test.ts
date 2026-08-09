/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "../lib/jurisdictionDomain";
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

const createOrganization = makeFunctionReference<"mutation">(
  "admin/organizations:createOrganization",
);
const setOrganizationMemberStatus = makeFunctionReference<"mutation">(
  "admin/organizations:setOrganizationMemberStatus",
);
const updateOrganization = makeFunctionReference<"mutation">(
  "admin/organizations:updateOrganization",
);
const archiveOrganization = makeFunctionReference<"mutation">(
  "admin/organizations:archiveOrganization",
);
const listActiveOrganizationOptions = makeFunctionReference<"query">(
  "admin/organizations:listActiveOrganizationOptions",
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

async function asUser(
  t: Backend,
  role: "auditor" | "content_manager" | "content_reviewer" | "user",
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
          twoFactorEnabled: role !== "user",
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
          ...(role !== "user" ? { adminTwoFactorVerifiedAt: now } : {}),
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return { client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }), userId: identity.userId };
}

describe("organization administration", () => {
  afterEach(() => {
    delete process.env.ADMIN_PANEL_ENABLED;
    delete process.env.ADMIN_ENVIRONMENT;
  });

  it("permission-gates active organization option pages for read-or-write admins", async () => {
    const t = createBackend();
    const writer = await asUser(t, "content_manager");
    const reader = await asUser(t, "auditor");
    const forbidden = await asUser(t, "content_reviewer");
    const args = { paginationOpts: { numItems: 20, cursor: null } };

    await expect(t.query(listActiveOrganizationOptions, args)).rejects.toThrow(
      "ADMIN_AUTH_REQUIRED",
    );
    await expect(writer.client.query(listActiveOrganizationOptions, args)).rejects.toThrow(
      "ADMIN_DISABLED",
    );

    await enablePanel(t);
    await expect(forbidden.client.query(listActiveOrganizationOptions, args)).rejects.toThrow(
      "ADMIN_FORBIDDEN",
    );
    await expect(writer.client.query(listActiveOrganizationOptions, args)).resolves.toMatchObject({
      page: [],
    });
    await expect(reader.client.query(listActiveOrganizationOptions, args)).resolves.toMatchObject({
      page: [],
    });
  });

  it("returns bounded active organization projections for ordered and search pages", async () => {
    const t = createBackend();
    await enablePanel(t);
    const reader = await asUser(t, "auditor");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 22; index += 1) {
        await ctx.db.insert("organizations", {
          name: `Active Organization ${String(index).padStart(2, "0")}`,
          slug: `active-organization-${index}`,
          class: index % 2 === 0 ? "university" : "nonprofit",
          website: `https://private-${index}.example.com/`,
          status: "active",
          createdBy: `creator-${index}`,
          updatedBy: `updater-${index}`,
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
      await ctx.db.insert("organizations", {
        name: "Archived Organization",
        slug: "archived-organization",
        class: "company",
        status: "archived",
        createdBy: "creator-archived",
        updatedBy: "updater-archived",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(reader.client.query(listActiveOrganizationOptions, {
      paginationOpts: { numItems: 21, cursor: null },
    })).rejects.toThrow("INVALID_ADMIN_PAGINATION");

    const first = await reader.client.query(listActiveOrganizationOptions, {
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(first.page).toHaveLength(20);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).not.toBe("");
    expect(Object.keys(first.page[0]).sort()).toEqual(["class", "id", "name", "slug"]);
    expect(JSON.stringify(first.page)).not.toContain("private-");
    expect(JSON.stringify(first.page)).not.toContain("creator-");

    const second = await reader.client.query(listActiveOrganizationOptions, {
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(2);
    expect(second.isDone).toBe(true);

    const search = await reader.client.query(listActiveOrganizationOptions, {
      query: "  07  ",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(search.page).toEqual([
      expect.objectContaining({ name: "Active Organization 07" }),
    ]);
    const firstSearchPage = await reader.client.query(listActiveOrganizationOptions, {
      query: "Active",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(firstSearchPage.page).toHaveLength(20);
    expect(firstSearchPage.isDone).toBe(false);
    const secondSearchPage = await reader.client.query(listActiveOrganizationOptions, {
      query: "Active",
      paginationOpts: { numItems: 20, cursor: firstSearchPage.continueCursor },
    });
    expect(secondSearchPage.page).toHaveLength(2);
    expect(secondSearchPage.isDone).toBe(true);
    await expect(reader.client.query(listActiveOrganizationOptions, {
      query: "a",
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow("INVALID_ADMIN_SEARCH_QUERY");
  });

  it("requires organization authority, keeps slugs unique, and audits membership changes", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asUser(t, "content_manager");
    const reviewer = await asUser(t, "content_reviewer");
    const member = await asUser(t, "user");

    await expect(reviewer.client.mutation(createOrganization, {
      name: "Forbidden University",
      slug: "forbidden-university",
      class: "university",
      reason: "Verify administrative boundary",
    })).rejects.toThrow("ADMIN_FORBIDDEN");

    const organizationId = await admin.client.mutation(createOrganization, {
      name: "Example University",
      slug: "example-university",
      class: "university",
      reason: "Create governed organization",
    });
    await expect(admin.client.mutation(createOrganization, {
      name: "Duplicate University",
      slug: "example-university",
      class: "university",
      reason: "Prevent duplicate organization",
    })).rejects.toThrow("ORGANIZATION_SLUG_EXISTS");

    await admin.client.mutation(setOrganizationMemberStatus, {
      organizationId,
      userId: member.userId,
      status: "active",
      reason: "Add organization member",
    });

    const audits = await t.run((ctx) => ctx.db
      .query("auditEvents")
      .withIndex("by_targetType_and_targetId", (q) =>
        q.eq("targetType", "organizationMembership").eq("targetId", `${organizationId}:${member.userId}`),
      )
      .take(2));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "organization.member_status_set",
      reason: "Add organization member",
      outcome: "success",
    });
  });

  it("rejects activation above the explicit membership bound instead of truncating access", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asUser(t, "content_manager");
    const member = await asUser(t, "user");
    const extraOrganizationId = await t.run(async (ctx) => {
      const now = Date.now();
      const ids = [];
      for (let index = 0; index < MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS; index += 1) {
        const organizationId = await ctx.db.insert("organizations", {
          name: `Organization ${index}`,
          slug: `organization-${index}`,
          class: "university",
          status: "active",
          createdBy: "fixture",
          updatedBy: "fixture",
          createdAt: now,
          updatedAt: now,
        });
        ids.push(organizationId);
        await ctx.db.insert("organizationMemberships", {
          organizationId,
          userId: member.userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      return await ctx.db.insert("organizations", {
        name: "Extra Organization",
        slug: "extra-organization",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(admin.client.mutation(setOrganizationMemberStatus, {
      organizationId: extraOrganizationId,
      userId: member.userId,
      status: "active",
      reason: "Add member",
    })).rejects.toThrow("ORGANIZATION_MEMBERSHIP_LIMIT");
  });

  it("renames draft labels and blocks archival until memberships and enabled jurisdictions are retired", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asUser(t, "content_manager");
    const member = await asUser(t, "user");
    const organizationId = await admin.client.mutation(createOrganization, {
      name: "Example University",
      slug: "example-university",
      class: "university",
      reason: "Create governed organization",
    });
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Example University Rules",
        slug: "example-university-rules",
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
    });

    await expect(admin.client.mutation(updateOrganization, {
      id: organizationId,
      name: "Renamed University",
      slug: "renamed-university",
      class: "university",
      reason: "Correct organization name",
    })).resolves.toMatchObject({ name: "Renamed University", slug: "renamed-university" });
    await expect(t.run((ctx) => ctx.db.get("jurisdictions", jurisdictionId)))
      .resolves.toMatchObject({ name: "Renamed University" });

    await admin.client.mutation(setOrganizationMemberStatus, {
      organizationId,
      userId: member.userId,
      status: "active",
      reason: "Add organization member",
    });
    await expect(admin.client.mutation(archiveOrganization, {
      id: organizationId,
      reason: "Retire organization",
    })).rejects.toThrow("ORGANIZATION_HAS_ACTIVE_MEMBERSHIPS");

    await admin.client.mutation(setOrganizationMemberStatus, {
      organizationId,
      userId: member.userId,
      status: "inactive",
      reason: "Offboarding",
    });
    await t.run((ctx) => ctx.db.patch(jurisdictionId, { status: "enabled" }));
    await expect(admin.client.mutation(archiveOrganization, {
      id: organizationId,
      reason: "Retire organization",
    })).rejects.toThrow("ORGANIZATION_HAS_ENABLED_JURISDICTION");
    await expect(admin.client.mutation(updateOrganization, {
      id: organizationId,
      name: "Blocked rename",
      slug: "blocked-rename",
      class: "university",
      reason: "Attempt enabled rename",
    })).rejects.toThrow("ORGANIZATION_JURISDICTION_ENABLED");

    await t.run((ctx) => ctx.db.patch(jurisdictionId, { status: "archived" }));
    await expect(admin.client.mutation(archiveOrganization, {
      id: organizationId,
      reason: "Retire organization",
    })).resolves.toMatchObject({ status: "archived" });
  });
});
