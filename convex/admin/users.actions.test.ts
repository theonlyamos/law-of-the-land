/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
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

type Backend = TestConvex<typeof schema>;

const banUser = makeFunctionReference<"mutation">("admin/users:banUser");
const assignRoles =
  makeFunctionReference<"mutation">("admin/users:assignRoles");
const revokeSession =
  makeFunctionReference<"mutation">("admin/users:revokeSession");
const startImpersonation = makeFunctionReference<"mutation">(
  "admin/users:startImpersonation",
);
const queueUserDeletion = makeFunctionReference<"mutation">(
  "admin/users:queueUserDeletion",
);
const resendVerification = makeFunctionReference<"mutation">(
  "admin/users:resendVerification",
);
const consumePreparedImpersonation = makeFunctionReference<"mutation">(
  "admin/users:consumePreparedImpersonation",
);
const finalizePreparedImpersonation = makeFunctionReference<"mutation">(
  "admin/users:finalizePreparedImpersonation",
);

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) {
    delete process.env.ADMIN_PANEL_ENABLED;
  } else {
    process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  }
  if (previousAdminEnvironment === undefined) {
    delete process.env.ADMIN_ENVIRONMENT;
  } else {
    process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
  }
});

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

async function createUser(
  t: Backend,
  options: {
    role?: string;
    twoFactorEnabled?: boolean;
    emailVerified?: boolean;
  } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Admin action fixture",
          email: `fixture-${crypto.randomUUID()}@example.com`,
          emailVerified: options.emailVerified ?? true,
          createdAt: now,
          updatedAt: now,
          role: options.role ?? "user",
          banned: false,
          twoFactorEnabled: options.twoFactorEnabled ?? false,
        },
      },
    });
  });
}

async function asAdmin(t: Backend, role: string) {
  const user = await createUser(t, { role, twoFactorEnabled: true });
  const session = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `fixture-session-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
  });
  return {
    client: t.withIdentity({ subject: user._id, sessionId: session._id }),
    session,
    user,
  };
}

describe("audited administrative user actions", () => {
  it("denies role assignment without the authoritative permission", async () => {
    const t = createBackend();
    await enablePanel(t);
    const support = await asAdmin(t, "support_agent");
    const target = await createUser(t, { twoFactorEnabled: true });

    await expect(
      support.client.mutation(assignRoles, {
        userId: target._id,
        roles: ["content_manager"],
        reason: "Approved staffing change",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Admin permission required");
  });

  it("rejects self-ban before changing the account", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");

    await expect(
      admin.client.mutation(banUser, {
        userId: admin.user._id,
        reason: "Unsafe self action",
        confirmation: `BAN ${admin.user._id}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_SELF_ACTION_FORBIDDEN");
  });

  it("executes an identical idempotent ban only once and replays its result", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const request = {
      userId: target._id,
      reason: "Confirmed abuse investigation",
      confirmation: `BAN ${target._id}`,
      idempotencyKey: crypto.randomUUID(),
    };

    const first = await admin.client.mutation(banUser, request);
    const replay = await admin.client.mutation(banUser, request);

    expect(replay).toEqual(first);
    const targetAfter = await t.run(async (ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "_id", operator: "eq", value: target._id }],
      }),
    );
    expect(targetAfter?.banned).toBe(true);

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(10),
    );
    expect(events.map((event) => event.action)).toEqual([
      "admin.user_ban.attempt",
      "admin.user_ban.success",
    ]);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
  });

  it("rejects idempotency-key reuse with different input", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const firstTarget = await createUser(t);
    const secondTarget = await createUser(t);
    const idempotencyKey = crypto.randomUUID();

    await admin.client.mutation(banUser, {
      userId: firstTarget._id,
      reason: "First reviewed case",
      confirmation: `BAN ${firstTarget._id}`,
      idempotencyKey,
    });
    await expect(
      admin.client.mutation(banUser, {
        userId: secondTarget._id,
        reason: "Second reviewed case",
        confirmation: `BAN ${secondTarget._id}`,
        idempotencyKey,
      }),
    ).rejects.toThrow("ADMIN_IDEMPOTENCY_CONFLICT");
  });

  it("never accepts or returns a session token for revocation", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const targetSession = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "session",
          data: {
            token: `do-not-expose-${crypto.randomUUID()}`,
            userId: target._id,
            expiresAt: now + 60_000,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
    });

    const result = await admin.client.mutation(revokeSession, {
      sessionId: targetSession._id,
      userId: target._id,
      reason: "User reported an unknown device",
      confirmation: `REVOKE ${targetSession._id}`,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(JSON.stringify(result)).not.toContain("do-not-expose");
    const deleted = await t.run(async (ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", operator: "eq", value: targetSession._id }],
      }),
    );
    expect(deleted).toBeNull();
  });

  it("rejects administrator impersonation targets", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const targetAdmin = await createUser(t, {
      role: "auditor",
      twoFactorEnabled: true,
    });

    await expect(
      admin.client.mutation(startImpersonation, {
        userId: targetAdmin._id,
        reason: "Investigate reported navigation",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_IMPERSONATION_TARGET_FORBIDDEN");
  });

  it("requires an exact deletion confirmation and rejects self-deletion", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);

    await expect(
      admin.client.mutation(queueUserDeletion, {
        userId: target._id,
        reason: "Validated privacy request",
        confirmation: "DELETE wrong-user",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_CONFIRMATION_MISMATCH");
    await expect(
      admin.client.mutation(queueUserDeletion, {
        userId: admin.user._id,
        reason: "Unsafe self action",
        confirmation: `DELETE ${admin.user._id}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_SELF_ACTION_FORBIDDEN");
  });

  it("rejects secret-bearing reasons before they reach the audit log", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);

    await expect(
      admin.client.mutation(banUser, {
        userId: target._id,
        reason: "password hunter2",
        confirmation: `BAN ${target._id}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("must not contain secrets");
    expect(
      await t.run(async (ctx) => ctx.db.query("auditEvents").take(1)),
    ).toEqual([]);
  });

  it("requires an exact action-bound step-up proof for role grants", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { twoFactorEnabled: true });

    await expect(
      admin.client.mutation(assignRoles, {
        userId: target._id,
        roles: ["content_manager"],
        reason: "Approved staffing change",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_STEP_UP_REQUIRED");
  });

  it("replays a completed stepped-up role change without consuming a second proof", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { twoFactorEnabled: true });
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("adminStepUpProofs", {
        actorId: admin.user._id,
        sessionId: admin.session._id,
        action: "roles_assign",
        targetId: target._id,
        idempotencyKey,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
    });
    const request = {
      userId: target._id,
      roles: ["content_manager"],
      reason: "Approved staffing change",
      idempotencyKey,
    };

    const first = await admin.client.mutation(assignRoles, request);
    const replay = await admin.client.mutation(assignRoles, request);

    expect(first).toMatchObject({ status: "succeeded" });
    expect(replay).toEqual(first);
  });

  it("queues one verification resend and rate-limits new keys", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { emailVerified: false });

    const first = await admin.client.mutation(resendVerification, {
      userId: target._id,
      reason: "User requested another verification message",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first).toMatchObject({
      status: "queued",
      action: "verification_resend",
      targetId: target._id,
    });
    await expect(
      admin.client.mutation(resendVerification, {
        userId: target._id,
        reason: "Repeated request inside the safe window",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("ADMIN_VERIFICATION_RATE_LIMITED");

    const queued = await t.run(async (ctx) =>
      ctx.db
        .query("verificationEmailRequests")
        .withIndex("by_targetUserId_and_createdAt", (q) =>
          q.eq("targetUserId", target._id),
        )
        .take(2),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued" });
  });

  it("fails closed when the admin feature gate is disabled", async () => {
    const t = createBackend();
    process.env.ADMIN_PANEL_ENABLED = "false";
    process.env.ADMIN_ENVIRONMENT = "test";
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);

    await expect(
      admin.client.mutation(banUser, {
        userId: target._id,
        reason: "Reviewed policy violation",
        confirmation: `BAN ${target._id}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Administration is not enabled");
  });

  it("expires prepared impersonation authorization after five minutes", async () => {
    const t = createBackend();
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const old = Date.now() - 6 * 60_000;
      await ctx.db.insert("adminOperations", {
        actorId: admin.user._id,
        action: "impersonation_start",
        targetId: target._id,
        idempotencyKey,
        requestFingerprint: "{}",
        correlationId: `op_${crypto.randomUUID().replaceAll("-", "")}`,
        status: "authorized",
        result: {
          status: "authorized",
          correlationId: "op_original",
          action: "impersonation_start",
          targetId: target._id,
        },
        createdAt: old,
        updatedAt: old,
      });
    });

    await expect(
      t.mutation(consumePreparedImpersonation, {
        actorId: admin.user._id,
        sessionId: admin.session._id,
        targetId: target._id,
        idempotencyKey,
      }),
    ).resolves.toBe(false);
  });

  it("finalizes impersonation audit without changing the prepared replay result", async () => {
    const t = createBackend();
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const idempotencyKey = crypto.randomUUID();
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationId = await t.run(async (ctx) =>
      ctx.db.insert("adminOperations", {
        actorId: admin.user._id,
        action: "impersonation_start",
        targetId: target._id,
        idempotencyKey,
        requestFingerprint: "{}",
        correlationId,
        status: "pending",
        result: {
          status: "authorized",
          correlationId,
          action: "impersonation_start",
          targetId: target._id,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(finalizePreparedImpersonation, {
      actorId: admin.user._id,
      targetId: target._id,
      idempotencyKey,
      succeeded: true,
    });

    const operation = await t.run(async (ctx) => ctx.db.get(operationId));
    expect(operation).toMatchObject({
      status: "succeeded",
      result: { status: "authorized", correlationId },
    });
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(5),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "admin.impersonation_start.success",
        correlationId,
        outcome: "success",
      }),
    );
  });
});
