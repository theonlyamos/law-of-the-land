import type { ActionCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import { components } from "../_generated/api";

/** Native account and session are re-read; a valid JWT alone is insufficient. */
export async function citationSourceUserId(ctx: ActionCtx | QueryCtx): Promise<string | null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user || user.banned === true || user.emailVerified !== true) return null;
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") return null;
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "session", where: [{ field: "_id", value: identity.sessionId }],
  });
  return session && session.userId === user._id && session.expiresAt > Date.now() ? user._id : null;
}
