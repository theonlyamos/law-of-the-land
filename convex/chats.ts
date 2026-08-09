import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { chatCitationValidator } from "./lib/jurisdictionDomain";

const messageValidator = v.union(
  v.object({
    role: v.literal("user"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),
  v.object({
    role: v.literal("assistant"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    citations: v.optional(v.array(chatCitationValidator)),
  }),
);

const MAX_SESSION_PAGE_SIZE = 30;
const MAX_MESSAGE_PAGE_SIZE = 50;
const DELETE_BATCH_SIZE = 100;

export function normalizePageSize(numItems: number, maxPageSize: number): number {
  if (!Number.isFinite(numItems) || numItems <= 0) return 1;
  return Math.min(maxPageSize, Math.max(1, Math.floor(numItems)));
}

const chatSessionSummaryValidator = v.object({
  id: v.string(),
  title: v.string(),
  lastMessage: v.string(),
  timestamp: v.number(),
  messageCount: v.number(),
});

const chatSessionMetadataValidator = v.object({
  id: v.string(),
  title: v.string(),
  lastMessage: v.string(),
  timestamp: v.number(),
  messageCount: v.number(),
  country: v.union(v.string(), v.null()),
});

const chatMessageValidator = v.object({
  storageId: v.id("messages"),
  clientId: v.union(v.string(), v.null()),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  createdAt: v.number(),
  creationTime: v.number(),
  citations: v.optional(v.array(chatCitationValidator)),
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(chatSessionSummaryValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };

    const result = await ctx.db
      .query("chatSessions")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: normalizePageSize(args.paginationOpts.numItems, MAX_SESSION_PAGE_SIZE),
      });

    return {
      page: result.page.map((session) => ({
        id: session.externalId,
        title: session.title,
        lastMessage: session.lastMessage,
        timestamp: session.updatedAt,
        messageCount: session.messageCount,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getByExternalId = query({
  args: {
    externalId: v.string(),
  },
  returns: v.union(chatSessionMetadataValidator, v.null()),
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

    return {
      id: session.externalId,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: session.updatedAt,
      messageCount: session.messageCount,
      country: session.country ?? null,
    };
  },
});

export const listMessages = query({
  args: {
    externalId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(chatMessageValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId),
      )
      .unique();
    if (!session) return { page: [], isDone: true, continueCursor: "" };

    const result = await ctx.db
      .query("messages")
      .withIndex("by_session_and_createdAt", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: normalizePageSize(args.paginationOpts.numItems, MAX_MESSAGE_PAGE_SIZE),
      });

    return {
      // The database query reads newest-first so the cursor continues into
      // older history; each page itself remains chronological for consumers.
      page: result.page.reverse().map((message) => ({
        storageId: message._id,
        clientId: message.clientId ?? null,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        creationTime: message._creationTime,
        citations: message.citations,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const ensure = mutation({
  args: {
    externalId: v.string(),
    country: v.optional(v.string()),
  },
  returns: v.object({ id: v.string() }),
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
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) throw new ConvexError("Chat session not found.");

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
        citations: message.role === "assistant" ? message.citations : undefined,
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
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) return { deleted: false };

    await ctx.db.delete(session._id);
    await ctx.scheduler.runAfter(0, internal.chats.deleteMessageBatch, {
      sessionId: session._id,
    });
    return { deleted: true };
  },
});

export const deleteMessageBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.object({ deletedCount: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(DELETE_BATCH_SIZE);
    for (const message of messages) await ctx.db.delete(message._id);

    const hasMore = messages.length === DELETE_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.chats.deleteMessageBatch, {
        sessionId: args.sessionId,
      });
    }
    return { deletedCount: messages.length, hasMore };
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
  returns: v.object({ migratedCount: v.number() }),
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
          citations: message.role === "assistant" ? message.citations : undefined,
          createdAt: message.createdAt ?? localSession.updatedAt,
        });
      }

      migratedCount += 1;
    }

    return { migratedCount };
  },
});
