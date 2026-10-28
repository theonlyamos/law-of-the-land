import { v } from "convex/values";

export const profileFactTypeValidator = v.union(
  v.literal("role"),
  v.literal("expertise"),
  v.literal("sector"),
  v.literal("topic"),
  v.literal("answer_preference"),
);
export const profileFactStatusValidator = v.union(
  v.literal("candidate"),
  v.literal("confirmed"),
  // Removed by the person. Kept (without evidence) so it is never learned again.
  v.literal("dismissed"),
);
export const profileFactSourceValidator = v.union(
  v.literal("stated"),
  v.literal("implied"),
  v.literal("user"),
);
export const profileEvidenceKindValidator = v.union(v.literal("stated"), v.literal("implied"));

export const profileObservationValidator = v.object({
  type: profileFactTypeValidator,
  value: v.string(),
  kind: profileEvidenceKindValidator,
  quote: v.string(),
});
