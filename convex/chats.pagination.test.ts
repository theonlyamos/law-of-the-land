/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { normalizePageSize } from "./chats";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.ts")).map(([path, load]) => [path, load]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);

function createTestBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function createUser(t: TestConvex<typeof schema>, email: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Chat pagination test",
          email,
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
          token: crypto.randomUUID(),
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
}

describe("chat pagination", () => {
  it("normalizes every caller page size to a finite positive integer within the cap", () => {
    expect(normalizePageSize(Number.NaN, 30)).toBe(1);
    expect(normalizePageSize(Number.POSITIVE_INFINITY, 30)).toBe(1);
    expect(normalizePageSize(-2, 30)).toBe(1);
    expect(normalizePageSize(0, 30)).toBe(1);
    expect(normalizePageSize(7.9, 30)).toBe(7);
    expect(normalizePageSize(10_000, 30)).toBe(30);
  });

  it("uses cursor pages, clamps session page size, and keeps newest sessions first", async () => {
    const t = createTestBackend();
    const user = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      for (let index = 0; index < 31; index += 1) {
        await ctx.db.insert("chatSessions", {
          userId: user.userId,
          externalId: `chat-${index}`,
          title: `Chat ${index}`,
          lastMessage: "",
          messageCount: 0,
          updatedAt: index,
        });
      }
    });

    const first = await t
      .withIdentity({ subject: user.userId, sessionId: user.sessionId })
      .query(api.chats.list, { paginationOpts: { numItems: 1_000, cursor: null } });

    expect(first.page).toHaveLength(30);
    expect(first.isDone).toBe(false);
    expect(first.page.map((session) => session.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `chat-${30 - index}`),
    );

    const second = await t
      .withIdentity({ subject: user.userId, sessionId: user.sessionId })
      .query(api.chats.list, {
        paginationOpts: { numItems: 30, cursor: first.continueCursor },
      });
    expect(second.page.map((session) => session.id)).toEqual(["chat-0"]);
    expect(second.isDone).toBe(true);
  }, 30_000);

  it("returns chronological message pages, clamps message page size, and enforces ownership", async () => {
    const t = createTestBackend();
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
    const otherUser = await createUser(t, `chat-other-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", {
        userId: owner.userId,
        externalId: "chat-1",
        title: "Chat 1",
        lastMessage: "",
        messageCount: 51,
        updatedAt: 51,
      });
      for (let index = 0; index < 51; index += 1) {
        await ctx.db.insert("messages", {
          sessionId: chatId,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}`,
          clientId: `message-${index}`,
          createdAt: index,
        });
      }
    });

    const first = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "chat-1",
        paginationOpts: { numItems: 1_000, cursor: null },
      });

    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    expect(first.page.map((message) => message.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `Message ${index + 1}`),
    );
    expect(first.page[0]).toMatchObject({
      storageId: expect.any(String),
      clientId: "message-1",
      creationTime: expect.any(Number),
    });

    const second = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "chat-1",
        paginationOpts: { numItems: 50, cursor: first.continueCursor },
      });
    expect(second.page.map((message) => message.content)).toEqual(["Message 0"]);
    expect(second.isDone).toBe(true);

    await expect(
      t
        .withIdentity({ subject: otherUser.userId, sessionId: otherUser.sessionId })
        .query(api.chats.listMessages, {
          externalId: "chat-1",
          paginationOpts: { numItems: 50, cursor: null },
        }),
    ).resolves.toMatchObject({ page: [], isDone: true });
  }, 30_000);

  it("keeps duplicate client IDs as distinct storage rows with a server-controlled equal-time order", async () => {
    const t = createTestBackend();
    const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);

    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chatSessions", {
        userId: owner.userId,
        externalId: "duplicate-client-id",
        title: "Duplicate client IDs",
        lastMessage: "",
        messageCount: 2,
        updatedAt: 1,
      });
      await ctx.db.insert("messages", {
        sessionId: chatId,
        role: "user",
        content: "First stored row",
        clientId: "duplicate",
        createdAt: 100,
      });
      await ctx.db.insert("messages", {
        sessionId: chatId,
        role: "user",
        content: "Second stored row",
        clientId: "duplicate",
        createdAt: 100,
      });
    });

    const page = await t
      .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
      .query(api.chats.listMessages, {
        externalId: "duplicate-client-id",
        paginationOpts: { numItems: 50, cursor: null },
      });

    expect(page.page).toHaveLength(2);
    expect(page.page.map((message) => message.storageId)).toHaveLength(2);
    expect(new Set(page.page.map((message) => message.storageId)).size).toBe(2);
    expect(page.page.map((message) => message.clientId)).toEqual(["duplicate", "duplicate"]);
    expect(page.page.map((message) => message.creationTime)).toEqual(
      [...page.page.map((message) => message.creationTime)].sort((a, b) => a - b),
    );
  });

  it("deletes messages through a bounded internal continuation after hiding the owned session", async () => {
    vi.useFakeTimers();
    try {
      const t = createTestBackend();
      const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
      const sessionId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("chatSessions", {
          userId: owner.userId,
          externalId: "delete-batches",
          title: "Delete batches",
          lastMessage: "",
          messageCount: 101,
          updatedAt: 1,
        });
        for (let index = 0; index < 101; index += 1) {
          await ctx.db.insert("messages", {
            sessionId: id,
            role: "user",
            content: `Delete ${index}`,
            createdAt: index,
          });
        }
        return id;
      });

      const firstBatch = await t.mutation(internal.chats.deleteMessageBatch, { sessionId });
      expect(firstBatch).toEqual({ deletedCount: 100, hasMore: true });

      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const remaining = await t.run((ctx) =>
        ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(102),
      );
      expect(remaining).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("lets only the owner hide a session and schedules its cleanup", async () => {
    vi.useFakeTimers();
    try {
      const t = createTestBackend();
      const owner = await createUser(t, `chat-owner-${crypto.randomUUID()}@example.com`);
      const otherUser = await createUser(t, `chat-other-${crypto.randomUUID()}@example.com`);
      const sessionId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("chatSessions", {
          userId: owner.userId,
          externalId: "owner-delete",
          title: "Owner delete",
          lastMessage: "",
          messageCount: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("messages", {
          sessionId: id,
          role: "user",
          content: "Cleanup me",
          createdAt: 1,
        });
        return id;
      });

      await expect(
        t
          .withIdentity({ subject: otherUser.userId, sessionId: otherUser.sessionId })
          .mutation(api.chats.remove, { externalId: "owner-delete" }),
      ).resolves.toEqual({ deleted: false });
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .mutation(api.chats.remove, { externalId: "owner-delete" }),
      ).resolves.toEqual({ deleted: true });
      await expect(
        t
          .withIdentity({ subject: owner.userId, sessionId: owner.sessionId })
          .query(api.chats.getByExternalId, { externalId: "owner-delete" }),
      ).resolves.toBeNull();

      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const remaining = await t.run((ctx) =>
        ctx.db.query("messages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(2),
      );
      expect(remaining).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
