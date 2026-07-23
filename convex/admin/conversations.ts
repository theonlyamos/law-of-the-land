import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 50;

const conversationRowValidator = v.object({
  id: v.id("chatSessions"),
  userId: v.string(),
  externalId: v.string(),
  messageCount: v.number(),
  updatedAt: v.number(),
  country: v.union(v.string(), v.null()),
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    userId: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(conversationRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "conversation", "read_content");
    if (
      args.userId !== undefined &&
      (!args.userId || args.userId.trim() !== args.userId)
    ) {
      throw new Error("INVALID_ADMIN_FILTER");
    }
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    ) {
      throw new Error("INVALID_ADMIN_PAGINATION");
    }

    const paginationOpts = {
      numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE),
      cursor: args.paginationOpts.cursor,
      maximumRowsRead: MAX_PAGE_SIZE + 1,
    };
    const result = args.userId
      ? await ctx.db
          .query("chatSessions")
          .withIndex("by_userId_and_updatedAt", (q) =>
            q.eq("userId", args.userId!),
          )
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("chatSessions")
          .withIndex("by_updatedAt")
          .order("desc")
          .paginate(paginationOpts);

    return {
      page: result.page.map((session) => ({
        id: session._id,
        userId: session.userId,
        externalId: session.externalId,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
        country: session.country ?? null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
