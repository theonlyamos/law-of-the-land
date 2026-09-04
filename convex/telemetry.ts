import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

const ROLLUP_BATCH = 500;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_PROVIDER_LATENCY_MS = 10 * 60_000;
const LATENCY_THRESHOLDS = [
  250,
  500,
  1_000,
  2_500,
  5_000,
  6_000,
  10_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
] as const;
const rollupDailyMetricsRef = makeFunctionReference<"mutation">(
  "telemetry:rollupDailyMetrics",
);

function bucketFor(latencyMs: number): number {
  const index = LATENCY_THRESHOLDS.findIndex((threshold) => latencyMs <= threshold);
  return index < 0 ? LATENCY_THRESHOLDS.length - 1 : index;
}

function percentile(histogram: readonly number[], total: number, fraction: number): number {
  if (total === 0) return 0;
  const target = Math.ceil(total * fraction);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= target) {
      return LATENCY_THRESHOLDS[index] ?? MAX_PROVIDER_LATENCY_MS;
    }
  }
  return MAX_PROVIDER_LATENCY_MS;
}

function histogramFromMetric(metric: Doc<"dailyMetrics"> | null): number[] {
  if (metric?.latencyHistogram?.length === LATENCY_THRESHOLDS.length) {
    return [...metric.latencyHistogram];
  }
  if (!metric) return Array.from({ length: LATENCY_THRESHOLDS.length }, () => 0);
  return [
    metric.latencyLe250,
    metric.latencyLe500 - metric.latencyLe250,
    metric.latencyLe1000 - metric.latencyLe500,
    metric.latencyLe2500 - metric.latencyLe1000,
    metric.latencyLe5000 - metric.latencyLe2500,
    metric.latencyGt5000,
    ...Array.from({ length: LATENCY_THRESHOLDS.length - 6 }, () => 0),
  ];
}

function isProviderFailure(row: Doc<"queryRuns">): boolean {
  return row.failureCategory === "configuration"
    || row.failureCategory === "network"
    || row.failureCategory === "timeout";
}

export const rollupDailyMetrics = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    processed: v.number(),
    done: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("queryRuns")
      .withIndex("by_rollupStatus_and_completedAt", (q) => q.eq("rollupStatus", "pending"))
      .take(ROLLUP_BATCH);
    const groups = new Map<string, Doc<"queryRuns">[]>();
    for (const row of rows) {
      if (!DAY_PATTERN.test(row.day)) throw new ConvexError("TELEMETRY_DAY_INVALID");
      const key = `${row.day}:${row.jurisdictionId}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const now = Date.now();
    for (const group of groups.values()) {
      const first = group[0];
      const existingRows = await ctx.db
        .query("dailyMetrics")
        .withIndex("by_day_and_jurisdictionId", (q) =>
          q.eq("day", first.day).eq("jurisdictionId", first.jurisdictionId))
        .take(2);
      if (existingRows.length > 1) throw new ConvexError("DUPLICATE_DAILY_METRIC");
      const existing = existingRows[0] ?? null;
      const histogram = histogramFromMetric(existing);
      for (const row of group) histogram[bucketFor(row.totalLatencyMs)] += 1;
      const totalQuestions = (existing?.totalQuestions ?? 0) + group.length;
      const latencyLe250 = histogram[0];
      const latencyLe500 = latencyLe250 + histogram[1];
      const latencyLe1000 = latencyLe500 + histogram[2];
      const latencyLe2500 = latencyLe1000 + histogram[3];
      const latencyLe5000 = latencyLe2500 + histogram[4];
      const value = {
        day: first.day,
        jurisdictionId: first.jurisdictionId,
        jurisdictionName: first.jurisdictionName,
        jurisdictionKind: first.jurisdictionKind,
        totalQuestions,
        successCount:
          (existing?.successCount ?? 0)
          + group.filter((row) => row.outcome === "success").length,
        failureCount:
          (existing?.failureCount ?? 0)
          + group.filter((row) => row.outcome === "failure").length,
        abortedCount:
          (existing?.abortedCount ?? 0)
          + group.filter((row) => row.outcome === "aborted").length,
        providerFailureCount:
          (existing?.providerFailureCount ?? 0)
          + group.filter(isProviderFailure).length,
        latencyLe250,
        latencyLe500,
        latencyLe1000,
        latencyLe2500,
        latencyLe5000,
        latencyGt5000: totalQuestions - latencyLe5000,
        latencyHistogram: histogram,
        p50UpperBoundMs: percentile(histogram, totalQuestions, 0.5),
        p95UpperBoundMs: percentile(histogram, totalQuestions, 0.95),
        updatedAt: now,
      };
      if (existing) await ctx.db.replace(existing._id, value);
      else await ctx.db.insert("dailyMetrics", value);
    }

    for (const row of rows) {
      await ctx.db.patch(row._id, { rollupStatus: "processed", rolledUpAt: now });
    }
    const done = rows.length < ROLLUP_BATCH;
    const cursor = rows[rows.length - 1]?._id ?? null;
    if (!done) await ctx.scheduler.runAfter(0, rollupDailyMetricsRef, { cursor });
    return { processed: rows.length, done, cursor };
  },
});
