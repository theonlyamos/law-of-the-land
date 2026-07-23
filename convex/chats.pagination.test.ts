/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, components } from "./_generated/api";
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
});
