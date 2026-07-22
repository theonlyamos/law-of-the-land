import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireAdminPermission } from "../lib/requireAdmin";

const adminRoleValidator = v.union(
  v.literal("super_admin"),
  v.literal("content_manager"),
  v.literal("content_reviewer"),
  v.literal("support_agent"),
  v.literal("billing_manager"),
  v.literal("auditor"),
);

export const get = query({
  args: {},
  returns: v.object({
    userId: v.string(),
    roles: v.array(adminRoleValidator),
  }),
  handler: async (ctx) =>
    await requireAdminPermission(ctx, "operations", "read"),
});
