import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import {
  hasRolePermission,
  parseAdminRoles,
  type AdminRole,
} from "./adminPermissions";

type AdminCtx = QueryCtx | MutationCtx;

const impersonationRestrictedPermissions = new Set([
  "user:set_role",
  "user:ban",
  "user:impersonate",
  "session:revoke",
  "billing:write",
  "document:publish",
  "document:rollback",
  "conversation:export",
  "operations:write",
]);

export function isImpersonationRestrictedPermission(
  resource: string,
  action: string,
): boolean {
  return impersonationRestrictedPermissions.has(`${resource}:${action}`);
}

export async function requireAdminPermission(
  ctx: AdminCtx,
  resource: string,
  action: string,
): Promise<{ userId: string; roles: AdminRole[] }> {
  const identity = await ctx.auth.getUserIdentity();
  const user = await authComponent.safeGetAuthUser(ctx);

  if (!identity || !user) {
    throw new ConvexError("You must be signed in to perform this action.");
  }
  if (user.twoFactorEnabled !== true) {
    throw new ConvexError("Two-factor authentication required");
  }

  const roles = parseAdminRoles(user.role);
  if (!hasRolePermission(roles, resource, action)) {
    throw new ConvexError("Admin permission required");
  }

  if (isImpersonationRestrictedPermission(resource, action)) {
    const sessionId = identity.sessionId;
    if (typeof sessionId !== "string") {
      throw new ConvexError("You must be signed in to perform this action.");
    }

    const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session",
      where: [{ field: "_id", operator: "eq", value: sessionId }],
    });
    if (!session) {
      throw new ConvexError("You must be signed in to perform this action.");
    }
    if (session.impersonatedBy) {
      throw new ConvexError(
        "Impersonated sessions cannot perform this admin action",
      );
    }
  }

  return { userId: user._id, roles };
}
