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
const unbanUser = makeFunctionReference<"mutation">("admin/users:unbanUser");
const assignRoles =
  makeFunctionReference<"mutation">("admin/users:assignRoles");
const revokeSession =
  makeFunctionReference<"mutation">("admin/users:revokeSession");
const revokeAllSessions = makeFunctionReference<"mutation">(
  "admin/users:revokeAllSessions",
);
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
const executeQueuedUserDeletion = makeFunctionReference<"mutation">(
  "admin/users:executeQueuedUserDeletion",
);
const expirePreparedImpersonation = makeFunctionReference<"mutation">(
  "admin/users:expirePreparedImpersonation",
);
const claimVerificationEmail = makeFunctionReference<"mutation">(
  "admin/users:claimVerificationEmail",
);
const finalizeVerificationEmail = makeFunctionReference<"mutation">(
  "admin/users:finalizeVerificationEmail",
);
const recordAdminStepUpProof = makeFunctionReference<"mutation">(
  "admin/users:recordAdminStepUpProof",
);
const expireVerificationEmailRequest = makeFunctionReference<"mutation">(
  "admin/users:expireVerificationEmailRequest",
);
const sendQueuedVerificationEmail = makeFunctionReference<"action">(
  "admin/users:sendQueuedVerificationEmail",
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

async function insertPreparedImpersonation(
  t: Backend,
  input: {
    actorId: string;
    targetId: string;
    idempotencyKey: string;
    updatedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const updatedAt = input.updatedAt ?? Date.now();
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationId = await ctx.db.insert("adminOperations", {
      actorId: input.actorId,
      action: "impersonation_start",
      targetId: input.targetId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: "{}",
      correlationId,
      status: "authorized",
      result: {
        status: "authorized",
        correlationId,
        action: "impersonation_start",
        targetId: input.targetId,
      },
      createdAt: updatedAt,
      updatedAt,
    });
    return { correlationId, operationId };
  });
}

describe("audited administrative user actions", () => {
  it("issues jurisdiction store deletion proof only for a writable existing jurisdiction", async () => {
    const t = createBackend();
    await enablePanel(t);
    const writer = await asAdmin(t, "content_manager");
    const reviewer = await asAdmin(t, "content_reviewer");
    const jurisdictionId = await t.run((ctx) => ctx.db.insert("jurisdictions", {
      name: "Ghana",
      slug: "ghana",
      status: "archived",
      isDefault: false,
      providerSyncState: "synced",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.mutation(recordAdminStepUpProof, {
      actorId: writer.user._id,
      sessionId: writer.session._id,
      action: "jurisdiction_store_delete",
      targetId: jurisdictionId,
      idempotencyKey: "jurisdiction-store-delete-valid",
    })).resolves.toBeNull();
    await expect(t.mutation(recordAdminStepUpProof, {
      actorId: writer.user._id,
      sessionId: writer.session._id,
      action: "jurisdiction_store_delete",
      targetId: "missing-jurisdiction",
      idempotencyKey: "jurisdiction-store-delete-missing",
    })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
    await expect(t.mutation(recordAdminStepUpProof, {
      actorId: reviewer.user._id,
      sessionId: reviewer.session._id,
      action: "jurisdiction_store_delete",
      targetId: jurisdictionId,
      idempotencyKey: "jurisdiction-store-delete-cross-scope",
    })).rejects.toThrow("ADMIN_STEP_UP_SCOPE_INVALID");
  });

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

  it("unbans once and replays after the mutable target is removed", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
          update: { banned: true },
        },
      }),
    );
    const request = {
      userId: target._id,
      reason: "Appeal was approved",
      idempotencyKey: crypto.randomUUID(),
    };

    const first = await admin.client.mutation(unbanUser, request);
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
        },
      }),
    );
    const replay = await admin.client.mutation(unbanUser, request);

    expect(first).toMatchObject({ status: "succeeded" });
    expect(replay).toEqual(first);
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

  it("collapses concurrent identical requests into one audited operation", async () => {
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

    const [first, second] = await Promise.all([
      admin.client.mutation(banUser, request),
      admin.client.mutation(banUser, request),
    ]);

    expect(second).toEqual(first);
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(5),
    );
    expect(events.map((event) => event.action)).toEqual([
      "admin.user_ban.attempt",
      "admin.user_ban.success",
    ]);
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

    const request = {
      sessionId: targetSession._id,
      userId: target._id,
      reason: "User reported an unknown device",
      confirmation: `REVOKE ${targetSession._id}`,
      idempotencyKey: crypto.randomUUID(),
    };
    const result = await admin.client.mutation(revokeSession, request);
    const replay = await admin.client.mutation(revokeSession, request);

    expect(JSON.stringify(result)).not.toContain("do-not-expose");
    expect(replay).toEqual(result);
    const deleted = await t.run(async (ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", operator: "eq", value: targetSession._id }],
      }),
    );
    expect(deleted).toBeNull();
  });

  it("revokes all target sessions and replays after target removal", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 3; index += 1) {
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "session",
            data: {
              token: `revoke-all-${index}-${crypto.randomUUID()}`,
              userId: target._id,
              expiresAt: now + 60_000,
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
    });
    const request = {
      userId: target._id,
      reason: "Account takeover was confirmed",
      confirmation: `REVOKE ALL ${target._id}`,
      idempotencyKey: crypto.randomUUID(),
    };

    const first = await admin.client.mutation(revokeAllSessions, request);
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
        },
      }),
    );
    const replay = await admin.client.mutation(revokeAllSessions, request);

    expect(first).toMatchObject({ status: "succeeded" });
    expect(replay).toEqual(first);
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

  it("denies support agents before queueing deletion or consuming step-up proof", async () => {
    const t = createBackend();
    await enablePanel(t);
    const support = await asAdmin(t, "support_agent");
    const target = await createUser(t);
    const idempotencyKey = crypto.randomUUID();
    const proofId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("adminStepUpProofs", {
        actorId: support.user._id,
        sessionId: support.session._id,
        action: "user_deletion_queue",
        targetId: target._id,
        idempotencyKey,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
    });

    await expect(
      support.client.mutation(queueUserDeletion, {
        userId: target._id,
        reason: "Validated privacy request",
        confirmation: `DELETE ${target._id}`,
        idempotencyKey,
      }),
    ).rejects.toThrow("Admin permission required");

    const proof = await t.run((ctx) => ctx.db.get(proofId));
    expect(proof).not.toHaveProperty("consumedAt");
    await expect(
      t.run((ctx) => ctx.db.query("userDeletionRequests").take(1)),
    ).resolves.toEqual([]);
    await expect(
      t.run((ctx) => ctx.db.query("adminOperations").take(1)),
    ).resolves.toEqual([]);
    await expect(
      t.run((ctx) => ctx.db.query("auditEvents").take(1)),
    ).resolves.toEqual([]);
  });

  it("replays a queued deletion after the finalized request removed its user", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("adminStepUpProofs", {
        actorId: admin.user._id,
        sessionId: admin.session._id,
        action: "user_deletion_queue",
        targetId: target._id,
        idempotencyKey,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
    });
    const request = {
      userId: target._id,
      reason: "Validated privacy request",
      confirmation: `DELETE ${target._id}`,
      idempotencyKey,
    };

    const first = await admin.client.mutation(queueUserDeletion, request);
    const requestId = await t.run(async (ctx) => {
      const queued = await ctx.db
        .query("userDeletionRequests")
        .withIndex("by_targetUserId_and_status", (q) =>
          q.eq("targetUserId", target._id).eq("status", "queued"),
        )
        .unique();
      if (!queued) throw new Error("Expected queued deletion request");
      await ctx.db.patch(queued._id, { executeAfter: 0 });
      return queued._id;
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const queued = await t.run((ctx) => ctx.db.get(requestId));
      if (queued?.status === "completed") break;
      await t.mutation(executeQueuedUserDeletion, { requestId });
    }

    const replay = await admin.client.mutation(queueUserDeletion, request);
    expect(replay).toEqual(first);
    await expect(
      t.run((ctx) =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
        }),
      ),
    ).resolves.toBeNull();
  });

  it("deletes dependent auth records in bounded resumable batches", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const dependentCount = 30;
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < dependentCount; index += 1) {
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "session",
            data: {
              token: `delete-session-${index}-${crypto.randomUUID()}`,
              userId: target._id,
              expiresAt: now + 60_000,
              createdAt: now,
              updatedAt: now,
            },
          },
        });
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "account",
            data: {
              accountId: `delete-account-${index}-${crypto.randomUUID()}`,
              providerId: "credential",
              userId: target._id,
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
    });
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("adminStepUpProofs", {
        actorId: admin.user._id,
        sessionId: admin.session._id,
        action: "user_deletion_queue",
        targetId: target._id,
        idempotencyKey,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
    });
    await admin.client.mutation(queueUserDeletion, {
      userId: target._id,
      reason: "Validated privacy request",
      confirmation: `DELETE ${target._id}`,
      idempotencyKey,
    });
    const requestId = await t.run(async (ctx) => {
      const request = await ctx.db
        .query("userDeletionRequests")
        .withIndex("by_targetUserId_and_status", (q) =>
          q.eq("targetUserId", target._id).eq("status", "queued"),
        )
        .unique();
      if (!request) throw new Error("Expected queued deletion request");
      await ctx.db.patch(request._id, { executeAfter: 0 });
      return request._id;
    });

    await t.mutation(executeQueuedUserDeletion, { requestId });
    await expect(t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({
      status: "executing",
    });
    const firstRemaining = await t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session",
        where: [{ field: "userId", operator: "eq", value: target._id }],
        paginationOpts: { numItems: 100, cursor: null },
      }),
    );
    expect(firstRemaining.page.length).toBeGreaterThan(0);
    expect(firstRemaining.page.length).toBeLessThan(dependentCount);
    await expect(
      t.run((ctx) =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
        }),
      ),
    ).resolves.not.toBeNull();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const request = await t.run((ctx) => ctx.db.get(requestId));
      if (request?.status === "completed") break;
      await t.mutation(executeQueuedUserDeletion, { requestId });
    }
    await expect(t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({
      status: "completed",
    });
    await t.mutation(executeQueuedUserDeletion, { requestId });
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(10),
    );
    expect(
      events.filter(
        (event) => event.action === "admin.user_deletion_execute.success",
      ),
    ).toHaveLength(1);
  });

  it("terminalizes deletion failure once when the target becomes an administrator", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t);
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("adminStepUpProofs", {
        actorId: admin.user._id,
        sessionId: admin.session._id,
        action: "user_deletion_queue",
        targetId: target._id,
        idempotencyKey,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
    });
    await admin.client.mutation(queueUserDeletion, {
      userId: target._id,
      reason: "Validated privacy request",
      confirmation: `DELETE ${target._id}`,
      idempotencyKey,
    });
    const requestId = await t.run(async (ctx) => {
      const request = await ctx.db
        .query("userDeletionRequests")
        .withIndex("by_targetUserId_and_status", (q) =>
          q.eq("targetUserId", target._id).eq("status", "queued"),
        )
        .unique();
      if (!request) throw new Error("Expected queued deletion request");
      await ctx.db.patch(request._id, { executeAfter: 0 });
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
          update: { role: "auditor", twoFactorEnabled: true },
        },
      });
      return request._id;
    });

    await t.mutation(executeQueuedUserDeletion, { requestId });
    await t.mutation(executeQueuedUserDeletion, { requestId });

    await expect(t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({
      status: "failed",
    });
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(10),
    );
    expect(
      events.filter(
        (event) => event.action === "admin.user_deletion_execute.failure",
      ),
    ).toHaveLength(1);
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

  it.each(["missing", "expired", "consumed"] as const)(
    "records a durable terminal denial for a %s role step-up proof",
    async (proofState) => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { twoFactorEnabled: true });
    const idempotencyKey = crypto.randomUUID();
    if (proofState !== "missing") {
      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.insert("adminStepUpProofs", {
          actorId: admin.user._id,
          sessionId: admin.session._id,
          action: "roles_assign",
          targetId: target._id,
          idempotencyKey,
          issuedAt: proofState === "expired" ? now - 6 * 60_000 : now,
          expiresAt: proofState === "expired" ? now - 1 : now + 60_000,
          ...(proofState === "consumed" ? { consumedAt: now } : {}),
        });
      });
    }
    const request = {
      userId: target._id,
      roles: ["content_manager" as const],
      reason: "Approved staffing change",
      idempotencyKey,
    };

    const first = await admin.client.mutation(assignRoles, request);
    const replay = await admin.client.mutation(assignRoles, request);

    expect(first).toMatchObject({ status: "failed", action: "roles_assign" });
    expect(replay).toEqual(first);
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(5),
    );
    expect(events.map((event) => event.action)).toEqual([
      "admin.roles_assign.attempt",
      "admin.roles_assign.failure",
    ]);
    expect(new Set(events.map((event) => event.correlationId))).toEqual(
      new Set([first.correlationId]),
    );
  },
  );

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

  it("preserves the last active super administrator through the audited wrapper", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, {
      role: "super_admin",
      twoFactorEnabled: true,
    });
    const idempotencyKey = crypto.randomUUID();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: admin.user._id }],
          update: { banned: true },
        },
      });
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

    const result = await admin.client.mutation(assignRoles, {
      userId: target._id,
      roles: ["auditor"],
      reason: "Reviewed authority reduction",
      idempotencyKey,
    });

    expect(result).toMatchObject({ status: "failed" });
    await expect(
      t.run((ctx) =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", operator: "eq", value: target._id }],
        }),
      ),
    ).resolves.toMatchObject({ role: "super_admin" });
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

  it.each([
    [true, "completed", "success"],
    [false, "failed", "failure"],
  ] as const)(
    "reconciles an expired in-flight verification %s exactly once",
    async (succeeded, expectedStatus, expectedOutcome) => {
      const t = createBackend();
      await enablePanel(t);
      const admin = await asAdmin(t, "super_admin");
      const target = await createUser(t, { emailVerified: false });
      await admin.client.mutation(resendVerification, {
        userId: target._id,
        reason: "User requested another verification message",
        idempotencyKey: crypto.randomUUID(),
      });
      const requestId = await t.run(async (ctx) => {
        const request = await ctx.db
          .query("verificationEmailRequests")
          .withIndex("by_targetUserId_and_createdAt", (q) =>
            q.eq("targetUserId", target._id),
          )
          .unique();
        if (!request) throw new Error("Expected verification request");
        return request._id;
      });

      await expect(
        t.mutation(claimVerificationEmail, { requestId }),
      ).resolves.toMatchObject({ targetEmail: target.email });
      await expect(
        t.mutation(claimVerificationEmail, { requestId }),
      ).resolves.toBeNull();
      await t.mutation(expireVerificationEmailRequest, { requestId });
      await expect(
        t.run((ctx) => ctx.db.get(requestId)),
      ).resolves.toMatchObject({ status: "executing" });
      await t.run((ctx) =>
        ctx.db.patch(requestId, { leaseExpiresAt: 0 } as never),
      );
      await t.mutation(expireVerificationEmailRequest, { requestId });
      await t.mutation(expireVerificationEmailRequest, { requestId });

      await expect(
        t.run((ctx) => ctx.db.get(requestId)),
      ).resolves.toMatchObject({ status: "unknown" });
      await expect(
        t.mutation(claimVerificationEmail, { requestId }),
      ).resolves.toBeNull();
      await t.mutation(finalizeVerificationEmail, { requestId, succeeded });
      await t.mutation(finalizeVerificationEmail, {
        requestId,
        succeeded: !succeeded,
      });
      await t.mutation(expireVerificationEmailRequest, { requestId });

      await expect(
        t.run((ctx) => ctx.db.get(requestId)),
      ).resolves.toMatchObject({ status: expectedStatus });
      const events = await t.run((ctx) =>
        ctx.db
          .query("auditEvents")
          .withIndex("by_targetType_and_targetId", (q) =>
            q.eq("targetType", "user").eq("targetId", target._id),
          )
          .take(5),
      );
      expect(events.map((event) => event.action)).toEqual([
        "admin.verification_resend.attempt",
        `admin.verification_resend.${expectedOutcome}`,
      ]);
      expect(events[0].correlationId).toBe(events[1].correlationId);
    },
  );

  it("records an honest verification failure when delivery is unconfigured", async () => {
    const t = createBackend();
    await enablePanel(t);
    delete process.env.RESEND_API_KEY;
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { emailVerified: false });
    const idempotencyKey = crypto.randomUUID();
    const queuedResult = await admin.client.mutation(resendVerification, {
      userId: target._id,
      reason: "User requested another verification message",
      idempotencyKey,
    });
    const requestId = await t.run(async (ctx) => {
      const request = await ctx.db
        .query("verificationEmailRequests")
        .withIndex("by_targetUserId_and_createdAt", (q) =>
          q.eq("targetUserId", target._id),
        )
        .unique();
      if (!request) throw new Error("Expected verification request");
      return request._id;
    });

    await t.action(sendQueuedVerificationEmail, { requestId });

    await expect(t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      t.run(async (ctx) => {
        const operation = await ctx.db
          .query("adminOperations")
          .withIndex("by_actorId_and_idempotencyKey", (q) =>
            q
              .eq("actorId", admin.user._id)
              .eq("idempotencyKey", idempotencyKey),
          )
          .unique();
        return operation?.result;
      }),
    ).resolves.toEqual(queuedResult);
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(5),
    );
    expect(events.map((event) => event.action)).toEqual([
      "admin.verification_resend.attempt",
      "admin.verification_resend.failure",
    ]);
  });

  it("claims and completes an isolated stub verification without constructing Better Auth email transport", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "super_admin");
    const target = await createUser(t, { emailVerified: false });
    const queued = await admin.client.mutation(resendVerification, {
      userId: target._id,
      reason: "Exercise isolated verification delivery",
      idempotencyKey: crypto.randomUUID(),
    });
    const requestId = await t.run(async (ctx) => (await ctx.db.query("verificationEmailRequests").withIndex("by_targetUserId_and_createdAt", (q) => q.eq("targetUserId", target._id)).unique())!._id);
    Object.assign(process.env, {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "test",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    });
    delete process.env.RESEND_API_KEY;
    try {
      await t.action(sendQueuedVerificationEmail, { requestId });
      await expect(t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({ status: "completed" });
      expect(queued).toMatchObject({ status: "queued", action: "verification_resend" });
    } finally {
      for (const key of ["ADMIN_E2E_FIXTURE_MODE", "ADMIN_E2E_TARGET_ENV", "ADMIN_E2E_ISOLATED_TARGET_MARKER", "ADMIN_E2E_PROVIDER_STUB_MODE"]) delete process.env[key];
    }
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
    const fresh = await insertPreparedImpersonation(t, {
      actorId: admin.user._id,
      targetId: target._id,
      idempotencyKey: crypto.randomUUID(),
    });
    const stale = await insertPreparedImpersonation(t, {
      actorId: admin.user._id,
      targetId: target._id,
      idempotencyKey,
      updatedAt: Date.now() - 6 * 60_000,
    });
    const abandoned = await insertPreparedImpersonation(t, {
      actorId: admin.user._id,
      targetId: target._id,
      idempotencyKey: crypto.randomUUID(),
      updatedAt: Date.now() - 6 * 60_000,
    });
    await t.run((ctx) =>
      ctx.db.patch(abandoned.operationId, { status: "pending" }),
    );

    await t.mutation(expirePreparedImpersonation, {
      operationId: fresh.operationId,
    });
    await t.mutation(expirePreparedImpersonation, {
      operationId: stale.operationId,
    });
    await t.mutation(expirePreparedImpersonation, {
      operationId: abandoned.operationId,
    });
    await t.mutation(expirePreparedImpersonation, {
      operationId: abandoned.operationId,
    });
    await t.mutation(expirePreparedImpersonation, {
      operationId: stale.operationId,
    });

    await expect(t.run((ctx) => ctx.db.get(fresh.operationId))).resolves.toMatchObject(
      { status: "authorized" },
    );
    await expect(t.run((ctx) => ctx.db.get(stale.operationId))).resolves.toMatchObject(
      { status: "failed" },
    );
    await expect(
      t.run((ctx) => ctx.db.get(abandoned.operationId)),
    ).resolves.toMatchObject({ status: "failed" });
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "user").eq("targetId", target._id),
        )
        .take(5),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "admin.impersonation_start.failure",
          correlationId: stale.correlationId,
        }),
        expect.objectContaining({
          action: "admin.impersonation_start.failure",
          correlationId: abandoned.correlationId,
        }),
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it.each([
    "demoted actor",
    "disabled feature",
    "invalidated session",
    "impersonated session",
  ] as const)(
    "invalidates prepared impersonation for a %s",
    async (authorityChange) => {
      const t = createBackend();
      await enablePanel(t);
      const admin = await asAdmin(t, "super_admin");
      const target = await createUser(t);
      const idempotencyKey = crypto.randomUUID();
      const prepared = await insertPreparedImpersonation(t, {
        actorId: admin.user._id,
        targetId: target._id,
        idempotencyKey,
      });

      if (authorityChange === "disabled feature") {
        process.env.ADMIN_PANEL_ENABLED = "false";
      } else if (authorityChange === "demoted actor") {
        await t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "user",
              where: [{ field: "_id", operator: "eq", value: admin.user._id }],
              update: { role: "user" },
            },
          }),
        );
      } else if (authorityChange === "invalidated session") {
        await t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.deleteOne, {
            input: {
              model: "session",
              where: [
                { field: "_id", operator: "eq", value: admin.session._id },
              ],
            },
          }),
        );
      } else {
        await t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "session",
              where: [
                { field: "_id", operator: "eq", value: admin.session._id },
              ],
              update: { impersonatedBy: "original-admin" },
            },
          }),
        );
      }

      await expect(
        admin.client.mutation(consumePreparedImpersonation, {
          actorId: admin.user._id,
          sessionId: admin.session._id,
          targetId: target._id,
          idempotencyKey,
        }),
      ).resolves.toBe(false);
      await expect(
        t.run((ctx) => ctx.db.get(prepared.operationId)),
      ).resolves.toMatchObject({ status: "failed" });
      const events = await t.run((ctx) =>
        ctx.db
          .query("auditEvents")
          .withIndex("by_targetType_and_targetId", (q) =>
            q.eq("targetType", "user").eq("targetId", target._id),
          )
          .take(5),
      );
      expect(events).toEqual([
        expect.objectContaining({
          action: "admin.impersonation_start.failure",
          correlationId: prepared.correlationId,
          outcome: "failure",
        }),
      ]);
    },
  );

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
