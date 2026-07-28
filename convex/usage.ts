import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { polar } from "./polar";

export const FREE_DAILY_LIMIT = 10;
export const PRO_DAILY_LIMIT = 200;

/** Limits are only enforced when BILLING_ENABLED=true on the deployment;
 * usage is counted either way so enabling billing later starts with data. */
export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function planFor(ctx: QueryCtx | MutationCtx, userId: string) {
  // Reads synced subscription data; null means free plan.
  const subscription = await polar.getCurrentSubscription(ctx, { userId });
  const isPro = subscription !== null;
  return { isPro, limit: isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT };
}

async function usedToday(ctx: QueryCtx | MutationCtx, userId: string, now: number) {
  return await ctx.db
    .query("dailyUsage")
    .withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", dayKey(now)))
    .unique();
}

export type EffectiveAllowance = {
  used: number;
  baseLimit: number;
  isPro: boolean;
  override: Doc<"quotaOverrides"> | null;
  effectiveLimit: number;
  allowed: boolean;
};

/**
 * Canonical quota calculation. Usage windows are fixed UTC calendar days
 * [00:00, next 00:00). Overrides are half-open [startsAt, expiresAt). If
 * legacy data overlaps, the most recently created active row wins.
 */
export async function getEffectiveAllowance(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  now: number,
): Promise<EffectiveAllowance> {
  const [row, plan, candidates] = await Promise.all([
    usedToday(ctx, userId, now),
    planFor(ctx, userId),
    ctx.db
      .query("quotaOverrides")
      .withIndex("by_userId_and_startsAt", (q) =>
        q.eq("userId", userId).lte("startsAt", now),
      )
      .order("desc")
      .take(20),
  ]);
  const active = candidates
    .filter((candidate) => candidate.revokedAt === undefined && now < candidate.expiresAt)
    .sort((left, right) => right.createdAt - left.createdAt || right._creationTime - left._creationTime)[0] ?? null;
  const used = row?.count ?? 0;
  const effectiveLimit = active?.limit ?? plan.limit;
  return {
    used,
    baseLimit: plan.limit,
    isPro: plan.isPro,
    override: active,
    effectiveLimit,
    allowed: !billingEnabled() || used <= effectiveLimit,
  };
}

/**
 * Counts one question against today's quota. Throws a QUOTA_EXCEEDED
 * ConvexError when billing is enabled and the plan's daily limit is reached.
 */
export const recordQuestion = mutation({
  args: {},
  returns: v.object({ used: v.number(), limit: v.number(), isPro: v.boolean() }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const allowance = await getEffectiveAllowance(ctx, userId, now);
    const row = await usedToday(ctx, userId, now);
    const used = allowance.used;

    if (billingEnabled() && used >= allowance.effectiveLimit) {
      throw new ConvexError({
        code: "QUOTA_EXCEEDED",
        limit: allowance.effectiveLimit,
        isPro: allowance.isPro,
      });
    }

    if (row) {
      await ctx.db.patch(row._id, { count: used + 1 });
    } else {
      await ctx.db.insert("dailyUsage", {
        userId,
        day: dayKey(now),
        count: 1,
      });
    }

    return { used: used + 1, limit: allowance.effectiveLimit, isPro: allowance.isPro };
  },
});

/** Non-incrementing check used by the answer endpoint (the search endpoint
 * already counted this question). */
export const checkAllowance = query({
  args: {},
  returns: v.object({ allowed: v.boolean(), limit: v.number(), isPro: v.boolean() }),
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { allowed: false, limit: 0, isPro: false };

    const allowance = await getEffectiveAllowance(ctx, userId, Date.now());
    return { allowed: allowance.allowed, limit: allowance.effectiveLimit, isPro: allowance.isPro };
  },
});

/** Plan + usage snapshot for the billing page. */
export const summary = query({
  args: {},
  returns: v.union(v.null(), v.object({ usedToday: v.number(), limit: v.number(), isPro: v.boolean(), billingEnabled: v.boolean() })),
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;

    const allowance = await getEffectiveAllowance(ctx, userId, Date.now());
    return {
      usedToday: allowance.used,
      limit: allowance.effectiveLimit,
      isPro: allowance.isPro,
      billingEnabled: billingEnabled(),
    };
  },
});
