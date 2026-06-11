import { ConvexError } from "convex/values";
import { authComponent } from "../auth";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new ConvexError("You must be signed in to perform this action.");
  }
  return user._id;
}

/**
 * For queries: returns null instead of throwing so that subscriptions racing
 * an auth change (e.g. sign-out) degrade to empty data instead of crashing
 * the client into an error boundary.
 */
export async function optionalUserId(ctx: QueryCtx | MutationCtx): Promise<string | null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  return user?._id ?? null;
}
