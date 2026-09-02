import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
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
