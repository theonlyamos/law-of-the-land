import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/requireUser";

function parseUserAgent(userAgent?: string) {
  if (!userAgent) return "Unknown device";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "Apple mobile device";
  if (/Android/i.test(userAgent)) return "Android device";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Linux/i.test(userAgent)) return "Linux device";
  return "Web browser";
}

export const touchSession = mutation({
  args: {
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const authSessionId = await getAuthSessionId(ctx);
    if (!authSessionId) return;

    const now = Date.now();
    const existing = await ctx.db
      .query("sessionMetadata")
      .withIndex("by_auth_session", (q) => q.eq("authSessionId", authSessionId))
      .unique();

    if (existing) {
      if (existing.revokedAt) return;
      await ctx.db.patch(existing._id, {
        lastActiveAt: now,
        userAgent: args.userAgent ?? existing.userAgent,
        ipAddress: args.ipAddress ?? existing.ipAddress,
      });
      return;
    }

    await ctx.db.insert("sessionMetadata", {
      userId,
      authSessionId,
      deviceLabel: parseUserAgent(args.userAgent),
      userAgent: args.userAgent,
      ipAddress: args.ipAddress,
      lastActiveAt: now,
    });
  },
});

export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const currentSessionId = await getAuthSessionId(ctx);

    const sessions = await ctx.db
      .query("sessionMetadata")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return sessions
      .filter((session) => !session.revokedAt)
      .map((session) => ({
        _id: session._id,
        authSessionId: session.authSessionId,
        deviceLabel: session.deviceLabel ?? parseUserAgent(session.userAgent),
        userAgent: session.userAgent ?? null,
        ipAddress: session.ipAddress ?? null,
        lastActiveAt: session.lastActiveAt,
        isCurrent: session.authSessionId === currentSessionId,
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  },
});

export const revokeSession = mutation({
  args: {
    authSessionId: v.id("authSessions"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const currentSessionId = await getAuthSessionId(ctx);

    const authSession = await ctx.db.get(args.authSessionId);
    if (!authSession || authSession.userId !== userId) {
      throw new Error("Session not found.");
    }

    const metadata = await ctx.db
      .query("sessionMetadata")
      .withIndex("by_auth_session", (q) => q.eq("authSessionId", args.authSessionId))
      .unique();

    if (metadata) {
      await ctx.db.patch(metadata._id, { revokedAt: Date.now() });
    }

    await ctx.db.delete(args.authSessionId);

    return {
      signedOutCurrent: currentSessionId === args.authSessionId,
    };
  },
});

export const revokeOtherSessions = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const currentSessionId = await getAuthSessionId(ctx);
    if (!currentSessionId) return { revokedCount: 0 };

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();

    let revokedCount = 0;
    for (const session of sessions) {
      if (session._id === currentSessionId) continue;

      const metadata = await ctx.db
        .query("sessionMetadata")
        .withIndex("by_auth_session", (q) => q.eq("authSessionId", session._id))
        .unique();

      if (metadata) {
        await ctx.db.patch(metadata._id, { revokedAt: Date.now() });
      }

      await ctx.db.delete(session._id);
      revokedCount += 1;
    }

    return { revokedCount };
  },
});
