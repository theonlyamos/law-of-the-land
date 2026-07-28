/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { api, components, internal } from "../_generated/api";
import { createAuthOptions } from "../auth";
import authSchema from "../betterAuth/schema";
import { writeAdminRoles } from "./roles";
import {
  ADMIN_ROLES,
  betterAuthAdminRoles,
  hasRolePermission,
} from "../lib/adminPermissions";
import { isImpersonationRestrictedPermission } from "../lib/requireAdmin";
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

const setAdminPanel = makeFunctionReference<"mutation">(
  "admin/featureFlags:setAdminPanel",
);

async function createAuthFixture(
  t: TestConvex<typeof schema>,
  options: {
    role: string;
    twoFactorEnabled: boolean;
    impersonatedBy?: string;
    assured?: boolean;
  },
): Promise<AuthFixture> {
  const now = Date.now();
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";

  return await t.run(async (ctx) => {
    const flag = await ctx.db
      .query("featureFlags")
      .withIndex("by_key_and_environment", (q) =>
        q.eq("key", "admin_panel").eq("environment", "test"),
      )
      .unique();
    if (!flag) {
      await ctx.db.insert("featureFlags", {
        key: "admin_panel",
        environment: "test",
        enabled: true,
        updatedAt: now,
      });
    }
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
            ...(options.assured === false
              ? {}
              : { adminTwoFactorVerifiedAt: now }),
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
  it.each(ADMIN_ROLES)("enforces the recovery mutation and query matrix for %s while the deployment panel gate is off", async (role) => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, { role, twoFactorEnabled: true });
    const key = `flag-matrix-${role}`;
    await t.run((ctx) => ctx.db.insert("adminStepUpProofs", {
      actorId: actor.userId,
      sessionId: actor.sessionId,
      action: "admin_panel_set",
      targetId: "admin_panel:test",
      idempotencyKey: key,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    process.env.ADMIN_PANEL_ENABLED = "false";
    const client = t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId });
    const mutation = client.mutation(setAdminPanel, {
      environment: "test",
      enabled: false,
      confirmation: "ADMIN_PANEL test DISABLE",
      reason: "Exercise exact recovery role matrix",
      idempotencyKey: key,
    });
    if (role === "super_admin") {
      await expect(mutation).resolves.toMatchObject({ environment: "test", enabled: false });
      await expect(client.query(api.admin.featureFlags.getAdminPanelRecoveryState, {})).resolves.toEqual({ environment: "test", enabled: false });
    } else {
      await expect(mutation).rejects.toThrow("Admin permission required");
      await expect(client.query(api.admin.featureFlags.getAdminPanelRecoveryState, {})).rejects.toThrow("Admin permission required");
    }
  });

  it("rejects recovery from an impersonated Super Admin session even while the panel is disabled", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
      impersonatedBy: "original-admin",
    });
    process.env.ADMIN_PANEL_ENABLED = "false";
    const client = t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId });

    await expect(
      client.query(api.admin.featureFlags.getAdminPanelRecoveryState, {}),
    ).rejects.toThrow("Impersonated sessions cannot perform this admin action");
  });

  it("lets an assured Super Admin toggle only the current environment flag while the panel is off", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, { role: "super_admin", twoFactorEnabled: true });
    const addProof = async (key: string) =>
      await t.run((ctx) =>
        ctx.db.insert("adminStepUpProofs", {
          actorId: actor.userId,
          sessionId: actor.sessionId,
          action: "admin_panel_set",
          targetId: "admin_panel:test",
          idempotencyKey: key,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      );
    const client = t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId });
    await addProof("flag-disable-1");
    await expect(client.mutation(setAdminPanel, {
      environment: "test", enabled: false, confirmation: "ADMIN_PANEL test DISABLE",
      reason: "Contain an administrative incident", idempotencyKey: "flag-disable-1",
    })).resolves.toMatchObject({ environment: "test", enabled: false });
    await expect(client.query(api.admin.featureFlags.isAdminEnabled, {})).resolves.toBe(false);
    await addProof("flag-enable-1");
    await expect(client.mutation(setAdminPanel, {
      environment: "test", enabled: true, confirmation: "ADMIN_PANEL test ENABLE",
      reason: "Restore verified administrative access", idempotencyKey: "flag-enable-1",
    })).resolves.toMatchObject({ environment: "test", enabled: true });
    const replay = await client.mutation(setAdminPanel, {
      environment: "test", enabled: true, confirmation: "ADMIN_PANEL test ENABLE",
      reason: "Restore verified administrative access", idempotencyKey: "flag-enable-1",
    });
    expect(replay).toMatchObject({ environment: "test", enabled: true });
    await expect(client.query(api.admin.featureFlags.isAdminEnabled, {})).resolves.toBe(true);
    await expect(t.run(async (ctx) => ({
      operations: await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.userId).eq("idempotencyKey", "flag-enable-1")).take(2),
      audits: (await ctx.db.query("auditEvents").withIndex("by_actorId_and_createdAt", (q) => q.eq("actorId", actor.userId)).take(10)).filter((row) => row.action === "admin.panel_flag_set" && row.correlationId === replay.correlationId),
    }))).resolves.toMatchObject({ operations: [expect.any(Object)], audits: [expect.any(Object)] });
  });
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
    expect(hasRolePermission(["super_admin"], "operations", "write")).toBe(
      true,
    );
    expect(hasRolePermission(["super_admin"], "operations", "retry")).toBe(
      true,
    );
    expect(hasRolePermission(["super_admin"], "anything", "dangerous")).toBe(
      false,
    );
    expect(
      betterAuthAdminRoles.super_admin.authorize({
        operations: ["write", "retry"],
      }).success,
    ).toBe(true);
    expect(
      betterAuthAdminRoles.super_admin.authorize({
        user: ["impersonate-admins"],
      }).success,
    ).toBe(false);
  });

  it("classifies every write and unknown permission as impersonation-restricted", () => {
    expect(isImpersonationRestrictedPermission("quota", "write")).toBe(true);
    expect(isImpersonationRestrictedPermission("operations", "write")).toBe(
      true,
    );
    expect(isImpersonationRestrictedPermission("operations", "retry")).toBe(
      true,
    );
    expect(isImpersonationRestrictedPermission("future", "unknown")).toBe(
      true,
    );
    expect(isImpersonationRestrictedPermission("operations", "read")).toBe(
      false,
    );
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

  it("rejects an enrolled admin using an unassured email-auto-sign-in-like session", async () => {
    const t = createTestBackend();
    const fixture = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
      assured: false,
    });

    await expect(
      t.withIdentity({ subject: fixture.userId, sessionId: fixture.sessionId })
        .query(api.admin.overview.get, {}),
    ).rejects.toThrow("Two-factor verification required for this session");
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
          {
            path: "/callback/:id",
            context: {
              internalAdapter: {
                findUserById: async () => ({ role: "super_admin" }),
              },
            },
          } as never,
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
          {
            path: "/callback/:id",
            context: {
              internalAdapter: {
                findUserById: async () => ({ role: "user" }),
              },
            },
          } as never,
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
        const result = await hook(
          { userId: admin.userId } as never,
          { path: "/two-factor/verify-totp" } as never,
        );
        if (typeof result !== "object" || !("data" in result)) {
          return null;
        }
        const verifiedAt = result.data.adminTwoFactorVerifiedAt;
        return verifiedAt instanceof Date ? verifiedAt.getTime() : null;
      }),
    ).resolves.toEqual(expect.any(Number));
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

  it("does not count a partial role-name match as another super administrator", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    await createAuthFixture(t, {
      role: "not_super_admin",
      twoFactorEnabled: true,
    });

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: actor.userId,
          roles: ["auditor"],
        }),
    ).rejects.toThrow("Cannot remove the last active super administrator");
  });

  it("finds the only valid alternate super administrator after the first page", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 100; index += 1) {
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "user",
            data: {
              name: `Pagination User ${index}`,
              email: `pagination-${index}-${crypto.randomUUID()}@example.com`,
              emailVerified: true,
              createdAt: now + index,
              updatedAt: now + index,
              role: "user",
              banned: false,
              twoFactorEnabled: false,
            },
          },
        });
      }
    });
    await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });

    const boundedPage = await t.run(async (ctx) =>
      await ctx.runQuery(components.betterAuth.adminUsers.listPage, {
        paginationOpts: { numItems: 1_000, cursor: null },
      }),
    );
    expect(boundedPage.page).toHaveLength(100);
    expect(boundedPage.isDone).toBe(false);

    await expect(
      t.withIdentity({ subject: actor.userId, sessionId: actor.sessionId })
        .mutation(api.admin.roles.setAdminRoles, {
          targetUserId: actor.userId,
          roles: ["auditor"],
        }),
    ).resolves.toEqual({ changed: true, roles: ["auditor"] });
  });

  it("fails closed without role or audit writes when the alternate scan budget is exhausted", async () => {
    const t = createTestBackend();
    const actor = await createAuthFixture(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    let pageFetches = 0;

    await expect(
      t.run(async (ctx) =>
        await writeAdminRoles(
          ctx,
          {
            actorType: "user",
            actorUserId: actor.userId,
            targetUserId: actor.userId,
            roles: ["auditor"],
            auditAction: "admin.roles_changed",
          },
          {
            fetchAdminUserPage: async (paginationOpts: {
              numItems: number;
              cursor: string | null;
            }) => {
              pageFetches += 1;
              return {
                page: Array.from(
                  { length: paginationOpts.numItems },
                  (_, index) => ({
                    userId: `ordinary-${pageFetches}-${index}`,
                    role: "user",
                    twoFactorEnabled: false,
                    banned: false,
                    banExpires: null,
                  }),
                ),
                isDone: false,
                continueCursor: `page-${pageFetches}`,
              };
            },
          },
        ),
      ),
    ).rejects.toThrow(
      "Unable to verify another active super administrator within the safety limit",
    );

    expect(pageFetches).toBe(10);
    await expect(readAuthUser(t, actor.userId)).resolves.toMatchObject({
      role: "super_admin",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.query("auditEvents").take(1)),
    ).resolves.toHaveLength(0);
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

  it("denies an unassured session inserted after promotion revocation", async () => {
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
        roles: ["super_admin"],
      });

    const racedSessionId = await t.run(async (ctx) => {
      const now = Date.now();
      const session = await ctx.runMutation(
        components.betterAuth.adapter.create,
        {
          input: {
            model: "session",
            data: {
              token: crypto.randomUUID(),
              userId: target.userId,
              expiresAt: now + 60_000,
              createdAt: now,
              updatedAt: now,
            },
          },
        },
      );
      return session._id;
    });

    await expect(
      t.withIdentity({ subject: target.userId, sessionId: racedSessionId })
        .query(api.admin.overview.get, {}),
    ).rejects.toThrow("Two-factor verification required for this session");
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
