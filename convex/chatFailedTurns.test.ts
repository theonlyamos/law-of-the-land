/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import { MAX_FAILED_TURNS_PER_CHAT } from "./chatFailedTurns";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
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

async function createJurisdiction(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: "Ghana", slug: "ghana", status: "enabled", isDefault: true, providerSyncState: "synced",
      kind: "geographic", visibility: "public", legacyCountryCode: "GH",
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: id, googlePlaceId: "place-ghana", level: "country", countryCode: "GH",
      latitude: 7.9465, longitude: -1.0232, formattedAddress: "Ghana", createdAt: now, updatedAt: now,
    });
    return id;
  });
}

async function createClient(t: TestConvex<typeof schema>) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        name: "Failed turn test", email: `failed-${crypto.randomUUID()}@example.com`, emailVerified: true,
        createdAt: now, updatedAt: now, role: "user", banned: false, twoFactorEnabled: false,
      } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: {
        token: crypto.randomUUID(), userId: user._id, expiresAt: now + 86_400_000, createdAt: now, updatedAt: now,
      } },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return t.withIdentity({ subject: userId, sessionId });
}

async function setup() {
  const t = createTestBackend();
  const jurisdictionId = await createJurisdiction(t);
  const client = await createClient(t);
  await client.mutation(api.chats.ensure, { externalId: "chat-1", jurisdictionId });
  return { t, client, jurisdictionId };
}

describe("failed chat turns", () => {
  it("keeps a failed question across reloads without adding it to the transcript", async () => {
    const { t, client } = await setup();
    await client.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-1", question: "  Is a weekend counted?  ",
      failureKind: "timeout", createdAt: 1_000,
    });
    // Recording again is idempotent and only updates the failure kind.
    await client.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-1", question: "Is a weekend counted?",
      failureKind: "failed", createdAt: 2_000,
    });

    await expect(client.query(api.chatFailedTurns.list, { externalId: "chat-1" })).resolves.toMatchObject([
      { userClientId: "user-1", question: "Is a weekend counted?", failureKind: "failed", createdAt: 1_000 },
    ]);
    await expect(client.query(api.chats.listMessages, {
      externalId: "chat-1", paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({ page: [] });
    await expect(t.run(ctx => ctx.db.query("messages").take(1))).resolves.toEqual([]);
  });

  it("does not expose failed questions to another user", async () => {
    const { t, client } = await setup();
    await client.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-1", question: "Private question", failureKind: "failed", createdAt: 1,
    });
    const other = await createClient(t);
    await expect(other.query(api.chatFailedTurns.list, { externalId: "chat-1" })).resolves.toEqual([]);
    await expect(other.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-2", question: "Injected", failureKind: "failed", createdAt: 1,
    })).rejects.toThrow("CHAT_UNAVAILABLE");
  });

  it("rejects empty or oversized questions", async () => {
    const { client } = await setup();
    for (const question of ["   ", "x".repeat(4_001)]) {
      await expect(client.mutation(api.chatFailedTurns.record, {
        externalId: "chat-1", userClientId: "user-1", question, failureKind: "failed", createdAt: 1,
      })).rejects.toThrow("INVALID_FAILED_TURN");
    }
  });

  it("clears a failed question once the same turn is saved as a message", async () => {
    const { client, jurisdictionId } = await setup();
    await client.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-1", question: "Question", failureKind: "failed", createdAt: 1,
    });
    await client.mutation(api.chats.appendMessages, {
      externalId: "chat-1", lastMessage: "Question", jurisdictionId,
      messages: [{ role: "user", content: "Question", clientId: "user-1", createdAt: 1 }],
    });
    await expect(client.query(api.chatFailedTurns.list, { externalId: "chat-1" })).resolves.toEqual([]);
    // A late failure report for an already saved turn is ignored.
    await client.mutation(api.chatFailedTurns.record, {
      externalId: "chat-1", userClientId: "user-1", question: "Question", failureKind: "timeout", createdAt: 1,
    });
    await expect(client.query(api.chatFailedTurns.list, { externalId: "chat-1" })).resolves.toEqual([]);
  });

  it("keeps only the most recent failures for a chat", async () => {
    const { client } = await setup();
    for (let index = 0; index < MAX_FAILED_TURNS_PER_CHAT + 3; index++) {
      await client.mutation(api.chatFailedTurns.record, {
        externalId: "chat-1", userClientId: `user-${index}`, question: `Question ${index}`, failureKind: "failed", createdAt: index + 1,
      });
    }
    const turns = await client.query(api.chatFailedTurns.list, { externalId: "chat-1" });
    expect(turns).toHaveLength(MAX_FAILED_TURNS_PER_CHAT);
    expect(turns[0].question).toBe("Question 3");
    expect(turns[turns.length - 1].question).toBe(`Question ${MAX_FAILED_TURNS_PER_CHAT + 2}`);
  });

  it("deletes failed questions with the chat", async () => {
    vi.useFakeTimers();
    try {
      const { t, client } = await setup();
      await client.mutation(api.chatFailedTurns.record, {
        externalId: "chat-1", userClientId: "user-1", question: "Question", failureKind: "failed", createdAt: 1,
      });
      await client.mutation(api.chats.remove, { externalId: "chat-1" });
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      await expect(t.run(ctx => ctx.db.query("failedChatTurns").take(1))).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
