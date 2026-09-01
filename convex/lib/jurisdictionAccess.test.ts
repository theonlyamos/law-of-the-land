/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "./jurisdictionDomain";
import { activeOrganizationIdsForUser } from "./jurisdictionAccess";
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

const getAccessibleById = makeFunctionReference<"query">(
  "jurisdictions:getAccessibleById",
);
const setOrganizationMemberStatus = makeFunctionReference<"mutation">(
  "admin/organizations:setOrganizationMemberStatus",
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

async function asUser(t: Backend, role: "content_manager" | "user") {
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

describe("jurisdiction membership access", () => {
  it("fails closed for a member-only read when persisted active memberships exceed the limit", async () => {
    const t = createBackend();
    const member = await asUser(t, "user");
    const membersJurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      let jurisdictionId;
      for (let index = 0; index <= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS; index += 1) {
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
        await ctx.db.insert("organizationMemberships", {
          organizationId,
          userId: member.userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        if (index === 0) {
          jurisdictionId = await ctx.db.insert("jurisdictions", {
            name: "Organization Rules",
            slug: "organization-rules",
            status: "enabled",
            isDefault: false,
            providerSyncState: "synced",
            kind: "organizational",
            visibility: "members",
            organizationId,
            createdBy: "fixture",
            updatedBy: "fixture",
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      return jurisdictionId!;
    });

    await expect(member.client.query(getAccessibleById, { id: membersJurisdictionId }))
      .rejects.toThrow("ORGANIZATION_MEMBERSHIP_LIMIT");
  });

  it("fails closed when duplicate persisted memberships make the active set ambiguous", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Example University",
        slug: "example-university",
        class: "university",
        status: "active",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert("organizationMemberships", {
          organizationId,
          userId: "member-fixture",
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    await expect(t.run(async (ctx) => {
      await activeOrganizationIdsForUser(ctx, "member-fixture");
      return null;
    })).rejects.toThrow("ORGANIZATION_MEMBERSHIP_STATE_INVALID");
  });

  it("allows an active member and denies a former member", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asUser(t, "content_manager");
    const member = await asUser(t, "user");
    const { organizationId, membersJurisdictionId } = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Example University",
        slug: "example-university",
        class: "university",
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
      const membersJurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Example University Rules",
        slug: "example-university-rules",
        status: "enabled",
        isDefault: false,
        providerSyncState: "synced",
        kind: "organizational",
        visibility: "members",
        organizationId,
        stagingBucketId: "provider-config-must-not-leak",
        productionBucketId: "4242",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      return { organizationId, membersJurisdictionId };
    });

    await expect(member.client.query(getAccessibleById, { id: membersJurisdictionId })).resolves.toMatchObject({
      _id: membersJurisdictionId,
      name: "Example University Rules",
      visibility: "members",
    });
    await expect(member.client.query(getAccessibleById, { id: membersJurisdictionId })).resolves.not.toHaveProperty("productionBucketId");
    await admin.client.mutation(setOrganizationMemberStatus, {
      organizationId,
      userId: member.userId,
      status: "inactive",
      reason: "Offboarding",
    });
    await expect(member.client.query(getAccessibleById, { id: membersJurisdictionId }))
      .resolves.toBeNull();
  });

  it("permits an enabled public jurisdiction without a membership", async () => {
    const t = createBackend();
    const member = await asUser(t, "user");
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        name: "Public rules",
        slug: "public-rules",
        status: "enabled",
        isDefault: false,
        providerSyncState: "synced",
        kind: "organizational",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(member.client.query(getAccessibleById, { id: jurisdictionId }))
      .resolves.toMatchObject({ _id: jurisdictionId, visibility: "public" });
  });
});
