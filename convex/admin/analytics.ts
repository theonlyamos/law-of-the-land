import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE = 50;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const metricProjection = v.object({
  id: v.id("dailyMetrics"),
  day: v.string(),
  jurisdictionCode: v.string(),
  totalQuestions: v.number(),
  successCount: v.number(),
  failureCount: v.number(),
  abortedCount: v.number(),
  providerFailureCount: v.number(),
  noResultCount: v.number(),
  p50UpperBoundMs: v.number(),
  p95UpperBoundMs: v.number(),
  updatedAt: v.number(),
});

function validateDay(value: string): string {
  if (!DAY_PATTERN.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new ConvexError("INVALID_ANALYTICS_DAY");
  }
  return value;
}

function validatePage(options: { numItems: number; cursor: string | null }) {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > MAX_PAGE) {
    throw new ConvexError("INVALID_ANALYTICS_PAGE_SIZE");
  }
  return options;
}

function project(row: Doc<"dailyMetrics">) {
  return {
    id: row._id,
    day: row.day,
    jurisdictionCode: row.jurisdictionCode,
    totalQuestions: row.totalQuestions,
    successCount: row.successCount,
    failureCount: row.failureCount,
    abortedCount: row.abortedCount,
    providerFailureCount: row.providerFailureCount,
    noResultCount: row.noResultCount,
    p50UpperBoundMs: row.p50UpperBoundMs,
    p95UpperBoundMs: row.p95UpperBoundMs,
    updatedAt: row.updatedAt,
  };
}

export const listDailyMetrics = query({
  args: {
    paginationOpts: paginationOptsValidator,
    jurisdictionCode: v.union(v.string(), v.null()),
    fromDay: v.string(),
    toDay: v.string(),
  },
  returns: v.object({
    page: v.array(metricProjection),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "analytics", "read");
    const fromDay = validateDay(args.fromDay);
    const toDay = validateDay(args.toDay);
    if (fromDay > toDay || Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`) > 366 * 86_400_000) {
      throw new ConvexError("INVALID_ANALYTICS_RANGE");
    }
    const paginationOpts = validatePage(args.paginationOpts);
    const code = args.jurisdictionCode?.trim().toUpperCase() ?? null;
    if (code !== null && !/^[A-Z]{2}$/.test(code)) throw new ConvexError("INVALID_ANALYTICS_JURISDICTION");
    const result = code
      ? await ctx.db.query("dailyMetrics").withIndex("by_jurisdictionCode_and_day", (q) => q.eq("jurisdictionCode", code).gte("day", fromDay).lte("day", toDay)).order("desc").paginate(paginationOpts)
      : await ctx.db.query("dailyMetrics").withIndex("by_day", (q) => q.gte("day", fromDay).lte("day", toDay)).order("desc").paginate(paginationOpts);
    return {
      page: result.page.map(project),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
