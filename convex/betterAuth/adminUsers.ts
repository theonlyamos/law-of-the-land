import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

const MAX_ADMIN_USER_PAGE_SIZE = 100;

const adminUserCandidateValidator = v.object({
  userId: v.id("user"),
  role: v.union(v.string(), v.null()),
  twoFactorEnabled: v.union(v.boolean(), v.null()),
  banned: v.union(v.boolean(), v.null()),
  banExpires: v.union(v.number(), v.null()),
});

export const listPage = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(adminUserCandidateValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("user")
      .order("asc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(
          args.paginationOpts.numItems,
          MAX_ADMIN_USER_PAGE_SIZE,
        ),
      });

    return {
      page: result.page.map((user) => ({
        userId: user._id,
        role: user.role ?? null,
        twoFactorEnabled: user.twoFactorEnabled ?? null,
        banned: user.banned ?? null,
        banExpires: user.banExpires ?? null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
