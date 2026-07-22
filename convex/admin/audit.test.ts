/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import { appendAuditEvent } from "../lib/audit";
import schema from "../schema";
import { writeAudit } from "./audit";

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

function createAdminBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function createAuditor(t: ReturnType<typeof createAdminBackend>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Auditor",
          email: `auditor-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "auditor",
          banned: false,
          twoFactorEnabled: true,
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
            adminTwoFactorVerifiedAt: now,
          },
        },
      },
    );
    return { userId: user._id, sessionId: session._id };
  });
}

async function withAdminEnvironment(
  values: { enabled?: string; environment?: string },
  callback: () => Promise<void>,
): Promise<void> {
  const previousEnabled = process.env.ADMIN_PANEL_ENABLED;
  const previousEnvironment = process.env.ADMIN_ENVIRONMENT;
  try {
    if (values.enabled === undefined) {
      delete process.env.ADMIN_PANEL_ENABLED;
    } else {
      process.env.ADMIN_PANEL_ENABLED = values.enabled;
    }
    if (values.environment === undefined) {
      delete process.env.ADMIN_ENVIRONMENT;
    } else {
      process.env.ADMIN_ENVIRONMENT = values.environment;
    }
    await callback();
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.ADMIN_PANEL_ENABLED;
    } else {
      process.env.ADMIN_PANEL_ENABLED = previousEnabled;
    }
    if (previousEnvironment === undefined) {
      delete process.env.ADMIN_ENVIRONMENT;
    } else {
      process.env.ADMIN_ENVIRONMENT = previousEnvironment;
    }
  }
}

describe("audit writer", () => {
  it("appends an immutable governance audit event", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run((ctx) =>
      writeAudit(ctx, {
        actorId: "user_1",
        actorRoles: ["support_agent"],
        action: "conversation.access_granted",
        targetType: "chatSession",
        targetId: "chat_1",
        reason: "Ticket 42",
        outcome: "success",
      }),
    );

    await expect(t.run((ctx) => ctx.db.get(id))).resolves.toMatchObject({
      reason: "Ticket 42",
      outcome: "success",
    });
  });

  it("rejects oversized or signed-url audit text", async () => {
    const t = convexTest(schema, modules);
    const baseEvent = {
      actorId: "user_1",
      actorRoles: ["support_agent"],
      action: "conversation.access_granted",
      targetType: "chatSession",
      targetId: "chat_1",
      outcome: "success" as const,
    };

    await expect(
      t.run((ctx) =>
        writeAudit(ctx, { ...baseEvent, reason: "x".repeat(501) }),
      ),
    ).rejects.toThrow("reason");
    await expect(
      t.run((ctx) =>
        writeAudit(ctx, {
          ...baseEvent,
          beforeSummary: "x".repeat(2_001),
        }),
      ),
    ).rejects.toThrow("summary");
    await expect(
      t.run((ctx) =>
        writeAudit(ctx, {
          ...baseEvent,
          reason:
            "https://storage.example.test/file?X-Amz-Signature=not-for-audit",
        }),
      ),
    ).rejects.toThrow("signed URLs");

    await expect(
      t.run((ctx) =>
        appendAuditEvent(ctx, {
          actorType: "system",
          action: "admin.bootstrap_super_admin",
          targetType: "user",
          targetId: "user_1",
          metadata: {
            previousRoles: "user",
            nextRoles: "super_admin",
            revokedSessions: 1,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects signed URLs from the legacy audit metadata adapter", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.run((ctx) =>
        appendAuditEvent(ctx, {
          actorType: "system",
          action: "admin.bootstrap_super_admin",
          targetType: "user",
          targetId: "user_1",
          metadata: {
            callback:
              "https://storage.example.test/file?X-Amz-Signature=not-for-audit",
          },
        }),
      ),
    ).rejects.toThrow("signed URLs");
  });

  it("returns a bounded, masked list to an authorized auditor", async () => {
    const t = createAdminBackend();
    const auditor = await createAuditor(t);
    await t.run(async (ctx) => {
      await writeAudit(ctx, {
        actorId: "user_sensitive_abcdef",
        actorRoles: ["support_agent"],
        action: "conversation.access_granted",
        targetType: "chatSession",
        targetId: "chat_sensitive_abcdef",
        reason: "Ticket 42",
        outcome: "success",
      });
      await writeAudit(ctx, {
        actorId: "user_sensitive_ghijkl",
        actorRoles: ["support_agent"],
        action: "conversation.access_granted",
        targetType: "chatSession",
        targetId: "chat_sensitive_ghijkl",
        outcome: "success",
      });
    });

    const events = await t
      .withIdentity({ subject: auditor.userId, sessionId: auditor.sessionId })
      .query(api.admin.audit.listAudit, { limit: 1 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "use…jkl",
      targetId: "cha…jkl",
      action: "conversation.access_granted",
    });
    expect(events[0]).not.toHaveProperty("reason");
  });
});

describe("admin panel feature gate", () => {
  it("fails closed when the server environment selector is missing", async () => {
    await withAdminEnvironment({ enabled: "true" }, async () => {
      const t = convexTest(schema, modules);
      await expect(t.query(api.admin.featureFlags.isAdminEnabled, {})).resolves.toBe(
        false,
      );
    });
  });

  it("fails closed when the environment gate is not exactly true", async () => {
    await withAdminEnvironment(
      { enabled: "false", environment: "staging" },
      async () => {
        const t = convexTest(schema, modules);
        await t.run(async (ctx) => {
          await ctx.db.insert("featureFlags", {
            key: "admin_panel",
            environment: "staging",
            enabled: true,
            updatedAt: Date.now(),
          });
        });
        await expect(
          t.query(api.admin.featureFlags.isAdminEnabled, {}),
        ).resolves.toBe(false);
      },
    );
  });

  it("fails closed for a missing or mismatched environment row", async () => {
    await withAdminEnvironment(
      { enabled: "true", environment: "staging" },
      async () => {
        const missing = convexTest(schema, modules);
        await expect(
          missing.query(api.admin.featureFlags.isAdminEnabled, {}),
        ).resolves.toBe(false);

        const mismatched = convexTest(schema, modules);
        await mismatched.run(async (ctx) => {
          await ctx.db.insert("featureFlags", {
            key: "admin_panel",
            environment: "production",
            enabled: true,
            updatedAt: Date.now(),
          });
        });
        await expect(
          mismatched.query(api.admin.featureFlags.isAdminEnabled, {}),
        ).resolves.toBe(false);
      },
    );
  });

  it("enables the panel only when both gates match", async () => {
    await withAdminEnvironment(
      { enabled: "true", environment: "staging" },
      async () => {
        const t = convexTest(schema, modules);
        await t.run(async (ctx) => {
          await ctx.db.insert("featureFlags", {
            key: "admin_panel",
            environment: "staging",
            enabled: true,
            updatedAt: Date.now(),
          });
        });
        await expect(
          t.query(api.admin.featureFlags.isAdminEnabled, {}),
        ).resolves.toBe(true);
      },
    );
  });
});
