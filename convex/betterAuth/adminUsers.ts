import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

const MAX_ADMIN_USER_PAGE_SIZE = 100;

export const getDisplayProfiles = query({
  args: { userIds: v.array(v.string()) },
  returns: v.array(v.object({ userId: v.string(), name: v.string(), email: v.string() })),
  handler: async (ctx, { userIds }) => {
    if (userIds.length > MAX_ADMIN_USER_PAGE_SIZE) throw new Error("TOO_MANY_USERS");
    const users = await Promise.all([...new Set(userIds)].map(async (userId) => {
      const id = ctx.db.normalizeId("user", userId);
      const user = id ? await ctx.db.get("user", id) : null;
      return user ? { userId: user._id, name: user.name, email: user.email } : null;
    }));
    return users.filter((user) => user !== null);
  },
});

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
