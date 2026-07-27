import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
const reconcileStaleJobs = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);

crons.interval(
  "reconcile stale GroundX jobs",
  { minutes: 15 },
  reconcileStaleJobs,
  {},
);

export default crons;
