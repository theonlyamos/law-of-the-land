import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";

const messageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  clientId: v.optional(v.string()),
  createdAt: v.optional(v.number()),
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return [];

    const sessions = await ctx.db
      .query("chatSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return sessions
      .map((session) => ({
        id: session.externalId,
        title: session.title,
        lastMessage: session.lastMessage,
        timestamp: session.updatedAt,
        messageCount: session.messageCount,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  },
});

export const getByExternalId = query({
  args: {
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();

    return {
      id: session.externalId,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: session.updatedAt,
      messageCount: session.messageCount,
      country: session.country ?? null,
      messages: messages
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((message) => ({
          id: message.clientId ?? message._id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        })),
    };
  },
});

export const ensure = mutation({
  args: {
    externalId: v.string(),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const existing = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (existing) return { id: existing.externalId };

    await ctx.db.insert("chatSessions", {
      userId,
      externalId: args.externalId,
      title: "New chat",
      lastMessage: "",
      messageCount: 0,
      updatedAt: Date.now(),
      country: args.country,
    });

    return { id: args.externalId };
  },
});

export const appendMessages = mutation({
  args: {
    externalId: v.string(),
    title: v.optional(v.string()),
    lastMessage: v.string(),
    country: v.optional(v.string()),
    messages: v.array(messageValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) {
      const sessionId = await ctx.db.insert("chatSessions", {
        userId,
        externalId: args.externalId,
        title: args.title ?? "New chat",
        lastMessage: args.lastMessage,
        messageCount: 0,
        updatedAt: Date.now(),
        country: args.country,
      });
      session = (await ctx.db.get(sessionId))!;
    }

    // Skip messages that were already saved (retries, double-submits).
    let inserted = 0;
    for (const message of args.messages) {
      if (message.clientId) {
        const existing = await ctx.db
          .query("messages")
          .withIndex("by_session_clientId", (q) =>
            q.eq("sessionId", session._id).eq("clientId", message.clientId)
          )
          .unique();
        if (existing) continue;
      }

      await ctx.db.insert("messages", {
        sessionId: session._id,
        role: message.role,
        content: message.content,
        clientId: message.clientId,
        createdAt: message.createdAt ?? Date.now(),
      });
      inserted += 1;
    }

    await ctx.db.patch(session._id, {
      title: args.title ?? session.title,
      lastMessage: args.lastMessage,
      messageCount: session.messageCount + inserted,
      updatedAt: Date.now(),
    });

    return { id: session.externalId };
  },
});

export const remove = mutation({
  args: {
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) return { deleted: false };

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();

    for (const message of messages) {
      await ctx.db.delete(message._id);
    }

    await ctx.db.delete(session._id);
    return { deleted: true };
  },
});

export const migrateFromLocal = mutation({
  args: {
    sessions: v.array(
      v.object({
        externalId: v.string(),
        title: v.string(),
        lastMessage: v.string(),
        messageCount: v.number(),
        updatedAt: v.number(),
        messages: v.array(messageValidator),
      })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    let migratedCount = 0;

    for (const localSession of args.sessions) {
      const existing = await ctx.db
        .query("chatSessions")
        .withIndex("by_user_externalId", (q) =>
          q.eq("userId", userId).eq("externalId", localSession.externalId)
        )
        .unique();

      if (existing) continue;

      const sessionId = await ctx.db.insert("chatSessions", {
        userId,
        externalId: localSession.externalId,
        title: localSession.title,
        lastMessage: localSession.lastMessage,
        messageCount: localSession.messageCount,
        updatedAt: localSession.updatedAt,
      });

      for (const message of localSession.messages) {
        await ctx.db.insert("messages", {
          sessionId: sessionId as Id<"chatSessions">,
          role: message.role,
          content: message.content,
          clientId: message.clientId,
          createdAt: message.createdAt ?? localSession.updatedAt,
        });
      }

      migratedCount += 1;
    }

    return { migratedCount };
  },
});
