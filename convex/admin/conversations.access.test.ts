/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

const createAccessGrant = makeFunctionReference<"mutation">(
  "admin/conversations:createAccessGrant",
);
const listMessages = makeFunctionReference<"query">(
  "admin/conversations:listMessages",
);
const listConversations = makeFunctionReference<"query">(
  "admin/conversations:list",
);
const queueConversationExport = makeFunctionReference<"mutation">(
  "admin/exports:queueConversationExport",
);
const recordAdminStepUpProof = makeFunctionReference<"mutation">(
  "admin/users:recordAdminStepUpProof",
);

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  vi.useRealTimers();
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

async function asAdmin(t: Backend, role: string) {
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
          twoFactorEnabled: true,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `secret-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60 * 60 * 1_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return {
    ...identity,
    client: t.withIdentity({
      subject: identity.userId,
      sessionId: identity.sessionId,
    }),
  };
}

async function seedConversation(t: Backend, messageCount = 3) {
  return await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chatSessions", {
      userId: "reader_42",
      externalId: `browser-${crypto.randomUUID()}`,
      title: "Private legal question",
      lastMessage: "Sensitive preview",
      messageCount,
      updatedAt: Date.now(),
      country: "GH",
    });
    for (let index = 0; index < messageCount; index += 1) {
      await ctx.db.insert("messages", {
        sessionId: chatId,
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          index === 0
            ? "# Matter\npassword: hunter2\nAuthorization: Bearer abc123\n{\"apiKey\":\"json-secret-42\"}\n[unsafe](javascript:alert(1))"
            : `Message ${index}`,
        createdAt: 1_900_000_000_000 + index,
      });
    }
    return chatId;
  });
}

async function issueExportStepUp(
  t: Backend,
  input: {
    actorId: string;
    sessionId: string;
    chatId: Id<"chatSessions">;
    grantId: Id<"adminAccessGrants">;
    idempotencyKey: string;
  },
) {
  const targetId = `${input.chatId}:${input.grantId}`;
  await t.mutation(recordAdminStepUpProof, {
    actorId: input.actorId,
    sessionId: input.sessionId,
    action: "conversation_export",
    targetId,
    idempotencyKey: input.idempotencyKey,
  });
  return await t.run(async (ctx) => {
    const proofs = await ctx.db
      .query("adminStepUpProofs")
      .withIndex(
        "by_actorId_sessionId_action_targetId_idempotencyKey",
        (q) =>
          q
            .eq("actorId", input.actorId)
            .eq("sessionId", input.sessionId)
            .eq("action", "conversation_export")
            .eq("targetId", targetId)
            .eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2);
    expect(proofs).toHaveLength(1);
    return proofs[0]._id;
  });
}

const firstPage = { paginationOpts: { numItems: 50, cursor: null } };

describe("audited conversation access grants", () => {
  it("projects stable unified jurisdiction metadata without using country", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const jurisdictionId = await ctx.db.insert("jurisdictions", {
        name: "Ghana",
        slug: `ghana-${crypto.randomUUID().slice(0, 8)}`,
        status: "enabled",
        isDefault: false,
        providerSyncState: "synced",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const chatId = await ctx.db.insert("chatSessions", {
        userId: "reader_42",
        externalId: `browser-${crypto.randomUUID()}`,
        title: "Unified legal question",
        lastMessage: "Answer",
        messageCount: 2,
        updatedAt: now,
        country: "NG",
        jurisdictionId,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        jurisdictionContract: "unified",
      });
      return { chatId, jurisdictionId };
    });

    const result = await admin.client.query(listConversations, {
      paginationOpts: { numItems: 30, cursor: null },
    });

    expect(result.page).toEqual([expect.objectContaining({
      id: seeded.chatId,
      jurisdiction: {
        id: seeded.jurisdictionId,
        name: "Ghana",
        kind: "geographic",
      },
    })]);
    expect(result.page[0]).not.toHaveProperty("country");
  });

  it("issues one 15-minute audit grant and reads masked messages without refresh writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t, 51);

    const grant = await admin.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Ticket 42 investigation",
    });
    expect(grant.expiresAt).toBe(Date.now() + 15 * 60 * 1_000);

    const first = await admin.client.query(listMessages, {
      chatId,
      grantId: grant.grantId,
      ...firstPage,
    });
    const second = await admin.client.query(listMessages, {
      chatId,
      grantId: grant.grantId,
      paginationOpts: { numItems: 50, cursor: first.continueCursor },
    });

    expect(first.page).toHaveLength(50);
    expect(second.page).toHaveLength(1);
    expect(first.page[0].content).toContain("password: [REDACTED]");
    expect(first.page[0].content).not.toContain("hunter2");
    expect(first.page[0].content).not.toContain("abc123");
    expect(first.page[0].content).not.toContain("json-secret-42");
    const auditEvents = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "chatSession").eq("targetId", chatId),
        )
        .take(10),
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actorId: admin.userId,
      action: "conversation.access_granted",
      reason: "Ticket 42 investigation",
      outcome: "success",
    });
  });

  it("rejects expired, cross-admin, cross-chat, and revoked grants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const t = createBackend();
    await enablePanel(t);
    const issuer = await asAdmin(t, "support_agent");
    const other = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t);
    const otherChatId = await seedConversation(t);
    const grant = await issuer.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Customer escalation",
    });

    await expect(
      other.client.query(listMessages, { chatId, grantId: grant.grantId, ...firstPage }),
    ).rejects.toThrow("grant does not belong");
    await expect(
      issuer.client.query(listMessages, {
        chatId: otherChatId,
        grantId: grant.grantId,
        ...firstPage,
      }),
    ).rejects.toThrow("grant does not match");

    await t.run(async (ctx) => {
      await ctx.db.patch(grant.grantId as Id<"adminAccessGrants">, {
        revokedAt: Date.now(),
      });
    });
    await expect(
      issuer.client.query(listMessages, { chatId, grantId: grant.grantId, ...firstPage }),
    ).rejects.toThrow("revoked");

    const fresh = await issuer.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Follow-up escalation",
    });
    vi.advanceTimersByTime(15 * 60 * 1_000);
    await expect(
      issuer.client.query(listMessages, { chatId, grantId: fresh.grantId, ...firstPage }),
    ).rejects.toThrow("expired");
  });

  it("enforces assured permissions and the site-wide gate", async () => {
    const t = createBackend();
    await enablePanel(t);
    const auditor = await asAdmin(t, "auditor");
    const chatId = await seedConversation(t);

    await expect(
      auditor.client.mutation(createAccessGrant, {
        chatId,
        purpose: "Audit curiosity",
      }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");

    const support = await asAdmin(t, "support_agent");
    process.env.ADMIN_PANEL_ENABLED = "false";
    await expect(
      support.client.mutation(createAccessGrant, {
        chatId,
        purpose: "Ticket review",
      }),
    ).rejects.toThrow("ADMIN_DISABLED");
  });

  it.each([
    "demoted actor",
    "disabled feature",
    "invalidated assurance",
    "impersonated session",
  ] as const)("revalidates post-grant authority for a %s", async (change) => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t);
    const grant = await admin.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Ticket 91 investigation",
    });
    const exportArgs = {
      chatId,
      grantId: grant.grantId,
      reason: "Attach transcript to ticket 91",
      idempotencyKey: `authority-${change.replaceAll(" ", "-")}`,
      confirmation: `EXPORT ${chatId}`,
    };

    if (change === "demoted actor") {
      await t.run((ctx) =>
        ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: "user",
            where: [{ field: "_id", operator: "eq", value: admin.userId }],
            update: { role: "user" },
          },
        }),
      );
    } else if (change === "disabled feature") {
      process.env.ADMIN_PANEL_ENABLED = "false";
    } else if (change === "invalidated assurance") {
      await t.run((ctx) =>
        ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: "session",
            where: [{ field: "_id", operator: "eq", value: admin.sessionId }],
            update: { adminTwoFactorVerifiedAt: null },
          },
        }),
      );
    } else {
      await t.run((ctx) =>
        ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: "session",
            where: [{ field: "_id", operator: "eq", value: admin.sessionId }],
            update: { impersonatedBy: "original-admin" },
          },
        }),
      );
    }

    await expect(
      admin.client.query(listMessages, {
        chatId,
        grantId: grant.grantId,
        ...firstPage,
      }),
    ).rejects.toThrow();
    await expect(
      admin.client.mutation(queueConversationExport, exportArgs),
    ).rejects.toThrow();
  });
});

describe("conversation exports", () => {
  it("requires and consumes one fresh grant-bound step-up while allowing exact replay", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t);
    const grant = await admin.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Ticket 68 investigation",
    });
    const input = {
      chatId,
      grantId: grant.grantId,
      reason: "Attach transcript to ticket 68",
      idempotencyKey: "export-ticket-68",
      confirmation: `EXPORT ${chatId}`,
    };

    await expect(
      admin.client.mutation(queueConversationExport, input),
    ).rejects.toThrow("ADMIN_STEP_UP_REQUIRED");
    const proofId = await issueExportStepUp(t, {
      actorId: admin.userId,
      sessionId: admin.sessionId,
      chatId,
      grantId: grant.grantId,
      idempotencyKey: input.idempotencyKey,
    });
    const first = await admin.client.mutation(queueConversationExport, input);
    const replay = await admin.client.mutation(queueConversationExport, input);

    expect(first).toEqual(replay);
    await expect(t.run((ctx) => ctx.db.get(proofId))).resolves.toMatchObject({
      consumedAt: expect.any(Number),
    });
  });

  it("requires typed confirmation and queues one idempotent audited export", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t);
    const grant = await admin.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Ticket 73 investigation",
    });
    const input = {
      chatId,
      grantId: grant.grantId,
      reason: "Attach transcript to ticket 73",
      idempotencyKey: "export-ticket-73",
      confirmation: `EXPORT ${chatId}`,
    };

    await expect(
      admin.client.mutation(queueConversationExport, {
        ...input,
        confirmation: "EXPORT wrong-chat",
      }),
    ).rejects.toThrow("ADMIN_CONFIRMATION_MISMATCH");
    await issueExportStepUp(t, {
      actorId: admin.userId,
      sessionId: admin.sessionId,
      chatId,
      grantId: grant.grantId,
      idempotencyKey: input.idempotencyKey,
    });
    const first = await admin.client.mutation(queueConversationExport, input);
    const replay = await admin.client.mutation(queueConversationExport, input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "queued",
      action: "conversation_export",
      targetId: chatId,
    });
    const operations = await t.run(async (ctx) =>
      ctx.db
        .query("adminOperations")
        .withIndex("by_actorId_and_idempotencyKey", (q) =>
          q.eq("actorId", admin.userId).eq("idempotencyKey", input.idempotencyKey),
        )
        .take(2),
    );
    expect(operations).toHaveLength(1);
    const exportEvents = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "chatSession").eq("targetId", chatId),
        )
        .take(10),
    );
    expect(exportEvents.map((event) => event.action)).toEqual([
      "conversation.access_granted",
      "admin.conversation_export.attempt",
      "admin.conversation_export.success",
    ]);
  });

  it("rejects idempotency conflicts and revalidates the grant on replay", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t, "support_agent");
    const chatId = await seedConversation(t);
    const grant = await admin.client.mutation(createAccessGrant, {
      chatId,
      purpose: "Case export review",
    });
    const base = {
      chatId,
      grantId: grant.grantId,
      reason: "Approved case export",
      idempotencyKey: "approved-export-11",
      confirmation: `EXPORT ${chatId}`,
    };
    await issueExportStepUp(t, {
      actorId: admin.userId,
      sessionId: admin.sessionId,
      chatId,
      grantId: grant.grantId,
      idempotencyKey: base.idempotencyKey,
    });
    await admin.client.mutation(queueConversationExport, base);
    await expect(
      admin.client.mutation(queueConversationExport, {
        ...base,
        reason: "Different export purpose",
      }),
    ).rejects.toThrow("ADMIN_IDEMPOTENCY_CONFLICT");
    await t.run(async (ctx) => {
      await ctx.db.patch(grant.grantId as Id<"adminAccessGrants">, {
        revokedAt: Date.now(),
      });
    });
    await expect(
      admin.client.mutation(queueConversationExport, base),
    ).rejects.toThrow("revoked");
  });
});
