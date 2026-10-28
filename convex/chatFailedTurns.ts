import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { canAccessSession } from "./chats";

// Failed questions are kept so a reload still shows what was asked and why no
// answer was saved. They never enter `messages`, so they cannot become
// research context, transcript history, or an admin/exported answer.
export const MAX_FAILED_TURNS_PER_CHAT = 20;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_CLIENT_ID_LENGTH = 200;
const DELETE_BATCH_SIZE = 100;

export const failedTurnKindValidator = v.union(v.literal("timeout"), v.literal("search_limit"), v.literal("failed"));

const failedTurnValidator = v.object({
  id: v.id("failedChatTurns"),
  userClientId: v.string(),
  question: v.string(),
  failureKind: failedTurnKindValidator,
  createdAt: v.number(),
});

const deleteBatchRef = makeFunctionReference<"mutation">("chatFailedTurns:deleteSessionBatch");

export async function clearFailedTurn(ctx: MutationCtx, sessionId: Id<"chatSessions">, userClientId: string): Promise<void> {
  const rows = await ctx.db.query("failedChatTurns")
    .withIndex("by_sessionId_and_userClientId", q => q.eq("sessionId", sessionId).eq("userClientId", userClientId))
    .take(2);
  for (const row of rows) await ctx.db.delete(row._id);
}

export async function scheduleFailedTurnDeletion(ctx: MutationCtx, sessionId: Id<"chatSessions">): Promise<void> {
  await ctx.scheduler.runAfter(0, deleteBatchRef, { sessionId });
}

export const record = mutation({
  args: {
    externalId: v.string(),
    userClientId: v.string(),
    question: v.string(),
    failureKind: failedTurnKindValidator,
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const question = args.question.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH || !args.userClientId
      || args.userClientId.length > MAX_CLIENT_ID_LENGTH || !Number.isFinite(args.createdAt)) {
      throw new ConvexError("INVALID_FAILED_TURN");
    }
    const userId = await requireUserId(ctx);
    const session = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", q => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session || !(await canAccessSession(ctx, session))) throw new ConvexError("CHAT_UNAVAILABLE");
    // A saved message with this id means the turn was answered after all.
    const saved = await ctx.db.query("messages")
      .withIndex("by_session_clientId", q => q.eq("sessionId", session._id).eq("clientId", args.userClientId))
      .first();
    if (saved) return null;
    const existing = await ctx.db.query("failedChatTurns")
      .withIndex("by_sessionId_and_userClientId", q => q.eq("sessionId", session._id).eq("userClientId", args.userClientId))
      .unique();
    // Never trust a client clock beyond now; ordering only needs to be stable.
    const createdAt = Math.min(args.createdAt, Date.now());
    if (existing) {
      await ctx.db.patch(existing._id, { failureKind: args.failureKind });
      return null;
    }
    await ctx.db.insert("failedChatTurns", {
      sessionId: session._id,
      userClientId: args.userClientId,
      question,
      failureKind: args.failureKind,
      createdAt,
    });
    // Keep only the most recent failures for each chat.
    const overflow = await ctx.db.query("failedChatTurns")
      .withIndex("by_sessionId_and_createdAt", q => q.eq("sessionId", session._id))
      .order("desc")
      .take(MAX_FAILED_TURNS_PER_CHAT + 5);
    for (const row of overflow.slice(MAX_FAILED_TURNS_PER_CHAT)) await ctx.db.delete(row._id);
    return null;
  },
});

export const list = query({
  args: { externalId: v.string() },
  returns: v.array(failedTurnValidator),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return [];
    const session = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", q => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session || !(await canAccessSession(ctx, session))) return [];
    const rows: Doc<"failedChatTurns">[] = await ctx.db.query("failedChatTurns")
      .withIndex("by_sessionId_and_createdAt", q => q.eq("sessionId", session._id))
      .order("desc")
      .take(MAX_FAILED_TURNS_PER_CHAT);
    return rows.reverse().map(row => ({
      id: row._id,
      userClientId: row.userClientId,
      question: row.question,
      failureKind: row.failureKind,
      createdAt: row.createdAt,
    }));
  },
});

export const deleteSessionBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const rows = await ctx.db.query("failedChatTurns")
      .withIndex("by_sessionId_and_createdAt", q => q.eq("sessionId", sessionId))
      .take(DELETE_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === DELETE_BATCH_SIZE) await ctx.scheduler.runAfter(0, deleteBatchRef, { sessionId });
    return null;
  },
});
