/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, components, internal } from "../_generated/api";
import { createAuthOptions } from "../auth";
import authSchema from "../betterAuth/schema";
import {
  ADMIN_ROLES,
  betterAuthAdminRoles,
  hasRolePermission,
} from "../lib/adminPermissions";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../")
      ? `./${path.slice(3)}`
      : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);

type AuthFixture = {
  userId: string;
  sessionId: string;
};

async function createAuthFixture(
  t: TestConvex<typeof schema>,
  options: {
    role: string;
    twoFactorEnabled: boolean;
    impersonatedBy?: string;
  },
): Promise<AuthFixture> {
  const now = Date.now();

  return await t.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Admin Test",
          email: `admin-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: options.role,
          banned: false,
          twoFactorEnabled: options.twoFactorEnabled,
        },
      },
    });
    const session = await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            token: crypto.randomUUID(),
            userId: user._id,
            expiresAt: now + 60_000,
            createdAt: now,
            updatedAt: now,
            impersonatedBy: options.impersonatedBy,
          },
        },
      },
    );

    return { userId: user._id, sessionId: session._id };
  });
}

async function readAuthUser(t: TestConvex<typeof schema>, userId: string) {
  return await t.run(async (ctx) =>
    await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", operator: "eq", value: userId }],
    }),
  );
}

async function readAuthSession(
  t: TestConvex<typeof schema>,
  sessionId: string,
) {
  return await t.run(async (ctx) =>
    await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session",
      where: [{ field: "_id", operator: "eq", value: sessionId }],
    }),
  );
}

function createTestBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

describe("admin permission registry", () => {
  it("grants only the fixed role permissions", () => {
    expect(
      hasRolePermission(["support_agent"], "conversation", "read_content"),
    ).toBe(true);
    expect(
      hasRolePermission(["billing_manager"], "conversation", "read_content"),
    ).toBe(false);
    expect(
      hasRolePermission(["content_manager"], "document", "publish"),
    ).toBe(false);
    expect(
      hasRolePermission(["content_reviewer"], "document", "publish"),
    ).toBe(true);
    expect(hasRolePermission(["unknown"], "document", "read")).toBe(false);
  });

  it("expands super admin permissions without enabling admin impersonation", () => {
    expect(hasRolePermission(["super_admin"], "anything", "dangerous")).toBe(
      true,
    );
    expect(
      betterAuthAdminRoles.super_admin.authorize({
        user: ["impersonate-admins"],
      }).success,
    ).toBe(false);
  });

  it("exposes only the fixed administrative roles", () => {
    expect(ADMIN_ROLES).toEqual([
      "super_admin",
      "content_manager",
      "content_reviewer",
      "support_agent",
      "billing_manager",
      "auditor",
    ]);
  });

  it("rejects an authoritative admin whose Two Factor enrollment is disabled", async () => {
    const t = createTestBackend();
    const fixture = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: false,
    });
    const asAdminWithoutTwoFactor = t.withIdentity({
      subject: fixture.userId,
      sessionId: fixture.sessionId,
    });

    await expect(
      asAdminWithoutTwoFactor.query(api.admin.overview.get, {}),
    ).rejects.toThrow("Two-factor authentication required");
  });

  it("uses the authoritative Better Auth role instead of identity claims", async () => {
    const t = createTestBackend();
    const fixture = await createAuthFixture(t, {
      role: "billing_manager",
      twoFactorEnabled: true,
    });
    const forgedIdentity = t.withIdentity({
      subject: fixture.userId,
      sessionId: fixture.sessionId,
      role: "super_admin",
    });

    await expect(
      forgedIdentity.query(api.admin.overview.get, {}),
    ).rejects.toThrow("Admin permission required");
  });

  it("rejects OAuth session creation for a current administrator", async () => {
    const t = createTestBackend();
    const admin = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    await expect(
      t.run(async (ctx) => {
        const hook = createAuthOptions(ctx as never).databaseHooks?.session
          ?.create?.before;
        if (!hook) {
          throw new Error("OAuth admin session policy missing");
        }
        return await hook(
          { userId: admin.userId } as never,
          { path: "/callback/:id" } as never,
        );
      }),
    ).rejects.toThrow("Administrators must use Two Factor credential sign-in");
  });

  it("allows OAuth sessions for non-admin users", async () => {
    const t = createTestBackend();
    const user = await createAuthFixture(t, {
      role: "user",
      twoFactorEnabled: false,
    });

    await expect(
      t.run(async (ctx) => {
        const hook = createAuthOptions(ctx as never).databaseHooks?.session
          ?.create?.before;
        if (!hook) {
          throw new Error("OAuth admin session policy missing");
        }
        return await hook(
          { userId: user.userId } as never,
          { path: "/callback/:id" } as never,
        );
      }),
    ).resolves.toBeNull();
  });

  it("allows an administrator session after credential Two Factor", async () => {
    const t = createTestBackend();
    const admin = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    await expect(
      t.run(async (ctx) => {
        const hook = createAuthOptions(ctx as never).databaseHooks?.session
          ?.create?.before;
        if (!hook) {
          throw new Error("OAuth admin session policy missing");
        }
        return await hook(
          { userId: admin.userId } as never,
          { path: "/two-factor/verify-totp" } as never,
        );
      }),
    ).resolves.toBeNull();
  });

  it("blocks role changes from an impersonated session", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
      impersonatedBy: "original-admin",
    });
    const target = await createAuthFixture(t, {
      role: "user",
      twoFactorEnabled: true,
    });

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: target.userId,
          roles: ["auditor"],
        }),
    ).rejects.toThrow("Impersonated sessions cannot perform this admin action");
  });

  it("requires target Two Factor enrollment before assigning an admin role", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    const target = await createAuthFixture(t, {
      role: "user",
      twoFactorEnabled: false,
    });

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: target.userId,
          roles: ["content_manager"],
        }),
    ).rejects.toThrow("Target administrator must enroll in Two Factor");
    await expect(readAuthUser(t, target.userId)).resolves.toMatchObject({
      role: "user",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.query("auditEvents").collect()),
    ).resolves.toHaveLength(0);
  });

  it("prevents removing the last active super administrator", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: actor.userId,
          roles: ["auditor"],
        }),
    ).rejects.toThrow("Cannot remove the last active super administrator");
    await expect(readAuthUser(t, actor.userId)).resolves.toMatchObject({
      role: "super_admin",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.query("auditEvents").collect()),
    ).resolves.toHaveLength(0);
  });

  it("allows a super administrator removal when another active one remains", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: actor.userId,
          roles: ["auditor"],
        }),
    ).resolves.toEqual({ changed: true, roles: ["auditor"] });
  });

  it("updates Better Auth roles and appends one immutable audit event", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    const target = await createAuthFixture(t, {
      role: "user",
      twoFactorEnabled: true,
    });

    await t
      .withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
      .mutation(api.admin.roles.setAdminRoles, {
        targetUserId: target.userId,
        roles: ["content_reviewer"],
      });

    await expect(readAuthUser(t, target.userId)).resolves.toMatchObject({
      role: "content_reviewer",
    });
    await expect(readAuthSession(t, target.sessionId)).resolves.toBeNull();
    const auditEvents = await t.run(async (ctx) =>
      await ctx.db.query("auditEvents").collect(),
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actorType: "user",
      actorUserId: actor.userId,
      action: "admin.roles_changed",
      targetType: "user",
      targetId: target.userId,
      metadata: {
        revokedSessions: 1,
      },
    });
  });

  it("keeps sessions when changing roles for an existing administrator", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    const target = await createAuthFixture(t, {
      role: "auditor",
      twoFactorEnabled: true,
    });

    await t
      .withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
      .mutation(api.admin.roles.setAdminRoles, {
        targetUserId: target.userId,
        roles: ["auditor", "content_reviewer"],
      });

    await expect(readAuthSession(t, target.sessionId)).resolves.toMatchObject({
      _id: target.sessionId,
    });
  });

  it("bootstraps only enrolled allowlisted users and remains idempotent", async () => {
    const t = createTestBackend();
    const target = await createAuthFixture(t, {
      role: "user",
      twoFactorEnabled: true,
    });
    const previousAllowlist = process.env.INITIAL_SUPER_ADMIN_IDS;
    process.env.INITIAL_SUPER_ADMIN_IDS = target.userId;

    try {
      await expect(
        t.mutation(internal.admin.migrations.bootstrapSuperAdmins, {}),
      ).resolves.toEqual({ promoted: 1, unchanged: 0 });
      await expect(
        t.mutation(internal.admin.migrations.bootstrapSuperAdmins, {}),
      ).resolves.toEqual({ promoted: 0, unchanged: 1 });
    } finally {
      if (previousAllowlist === undefined) {
        delete process.env.INITIAL_SUPER_ADMIN_IDS;
      } else {
        process.env.INITIAL_SUPER_ADMIN_IDS = previousAllowlist;
      }
    }

    await expect(readAuthUser(t, target.userId)).resolves.toMatchObject({
      role: "super_admin",
    });
    await expect(readAuthSession(t, target.sessionId)).resolves.toBeNull();
    const auditEvents = await t.run(async (ctx) =>
      await ctx.db.query("auditEvents").collect(),
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actorType: "system",
      action: "admin.bootstrap_super_admin",
      targetId: target.userId,
      metadata: {
        revokedSessions: 1,
      },
    });
  });
});
