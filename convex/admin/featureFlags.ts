import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import { requireCurrentAdmin } from "../lib/requireAdmin";

function readAdminEnvironment(): string | null {
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!environment || environment.trim() !== environment) {
    return null;
  }
  return environment;
}

/**
 * The administrative surface is enabled only when its deployment gate and
 * its explicitly selected environment row are both enabled. An absent or
 * blank selector deliberately cannot fall back to another environment.
 */
export async function readAdminEnabled(ctx: QueryCtx): Promise<boolean> {
  if (process.env.ADMIN_PANEL_ENABLED !== "true") {
    return false;
  }

  const environment = readAdminEnvironment();
  if (!environment) {
    return false;
  }

  const flags = await ctx.db
    .query("featureFlags")
    .withIndex("by_key_and_environment", (q) =>
      q.eq("key", "admin_panel").eq("environment", environment),
    )
    .take(2);

  return flags.length === 1 && flags[0].enabled === true;
}

export const isAdminEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requireCurrentAdmin(ctx);
    return await readAdminEnabled(ctx);
  },
});
