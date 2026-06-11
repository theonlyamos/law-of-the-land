import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { polar } from "./polar";

export const FREE_DAILY_LIMIT = 10;
export const PRO_DAILY_LIMIT = 200;

/** Limits are only enforced when BILLING_ENABLED=true on the deployment;
 * usage is counted either way so enabling billing later starts with data. */
function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function planFor(ctx: QueryCtx | MutationCtx, userId: string) {
  // Reads synced subscription data; null means free plan.
  const subscription = await polar.getCurrentSubscription(ctx, { userId });
  const isPro = subscription !== null;
  return { isPro, limit: isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT };
}

async function usedToday(ctx: QueryCtx | MutationCtx, userId: string) {
  return await ctx.db
    .query("dailyUsage")
    .withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", dayKey(Date.now())))
    .unique();
}

/**
 * Counts one question against today's quota. Throws a QUOTA_EXCEEDED
 * ConvexError when billing is enabled and the plan's daily limit is reached.
 */
export const recordQuestion = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [row, plan] = await Promise.all([usedToday(ctx, userId), planFor(ctx, userId)]);
    const used = row?.count ?? 0;

    if (billingEnabled() && used >= plan.limit) {
      throw new ConvexError({
        code: "QUOTA_EXCEEDED",
        limit: plan.limit,
        isPro: plan.isPro,
      });
    }

    if (row) {
      await ctx.db.patch(row._id, { count: used + 1 });
    } else {
      await ctx.db.insert("dailyUsage", {
        userId,
        day: dayKey(Date.now()),
        count: 1,
      });
    }

    return { used: used + 1, limit: plan.limit, isPro: plan.isPro };
  },
});

/** Non-incrementing check used by the answer endpoint (the search endpoint
 * already counted this question). */
export const checkAllowance = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { allowed: false, limit: 0, isPro: false };

    const [row, plan] = await Promise.all([usedToday(ctx, userId), planFor(ctx, userId)]);
    const used = row?.count ?? 0;

    return {
      allowed: !billingEnabled() || used <= plan.limit,
      limit: plan.limit,
      isPro: plan.isPro,
    };
  },
});

/** Plan + usage snapshot for the billing page. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;

    const [row, plan] = await Promise.all([usedToday(ctx, userId), planFor(ctx, userId)]);

    return {
      usedToday: row?.count ?? 0,
      limit: plan.limit,
      isPro: plan.isPro,
      billingEnabled: billingEnabled(),
    };
  },
});
