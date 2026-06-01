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
