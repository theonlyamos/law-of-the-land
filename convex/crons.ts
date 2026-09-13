import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
crons.interval("initialize review stage counts", { minutes: 1 }, makeFunctionReference<"mutation">("admin/reviewCounts:backfill"), {});
for (const table of ["sessions", "turns", "rates", "usage"] as const) {
  crons.interval(`expire widget ${table}`, { minutes: 15 }, makeFunctionReference<"mutation">("widgetRuntime:cleanup"), { table });
}
const reconcileStaleJobs = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);
const rollupDailyMetrics = makeFunctionReference<"mutation">(
  "telemetry:rollupDailyMetrics",
);
const runRetentionBatch = makeFunctionReference<"mutation">(
  "admin/operations:runRetentionBatch",
);

crons.interval(
  "reconcile stale provider jobs",
  { minutes: 15 },
  reconcileStaleJobs,
  {},
);

crons.interval(
  "enforce bounded retention policy",
  { hours: 1 },
  runRetentionBatch,
  { cursor: null },
);

crons.interval(
  "roll up privacy-bounded query telemetry",
  { minutes: 10 },
  rollupDailyMetrics,
  { cursor: null },
);

export default crons;
