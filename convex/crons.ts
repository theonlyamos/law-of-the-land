import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
const reconcileStaleJobs = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);
const rollupDailyMetrics = makeFunctionReference<"mutation">(
  "telemetry:rollupDailyMetrics",
);

crons.interval(
  "reconcile stale GroundX jobs",
  { minutes: 15 },
  reconcileStaleJobs,
  {},
);

crons.interval(
  "roll up privacy-bounded query telemetry",
  { minutes: 10 },
  rollupDailyMetrics,
  { cursor: null },
);

export default crons;
