import { v } from "convex/values";
import { query } from "../_generated/server";

function readAdminEnvironment(): string | null {
  const environment = process.env.ADMIN_ENVIRONMENT?.trim();
  return environment ? environment : null;
}

/**
 * The administrative surface is enabled only when its deployment gate and
 * its explicitly selected environment row are both enabled. An absent or
 * blank selector deliberately cannot fall back to another environment.
 */
export const isAdminEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    if (process.env.ADMIN_PANEL_ENABLED !== "true") {
      return false;
    }

    const environment = readAdminEnvironment();
    if (!environment) {
      return false;
    }

    const flag = await ctx.db
      .query("featureFlags")
      .withIndex("by_key_and_environment", (q) =>
        q.eq("key", "admin_panel").eq("environment", environment),
      )
      .unique();

    return flag?.enabled === true;
  },
});
