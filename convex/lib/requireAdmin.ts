import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import {
  getPermissionAccess,
  hasRolePermission,
  parseAdminRoles,
  type AdminRole,
} from "./adminPermissions";

type AdminCtx = QueryCtx | MutationCtx;

export function isImpersonationRestrictedPermission(
  resource: string,
  action: string,
): boolean {
  return getPermissionAccess(resource, action) !== "read";
}

export async function requireAdminPermission(
  ctx: AdminCtx,
  resource: string,
  action: string,
): Promise<{ userId: string; roles: AdminRole[] }> {
  const admin = await requireCurrentAdmin(ctx);

  if (
    admin.impersonatedBy &&
    isImpersonationRestrictedPermission(resource, action)
  ) {
    throw new ConvexError(
      "Impersonated sessions cannot perform this admin action",
    );
  }
  if (!hasRolePermission(admin.roles, resource, action)) {
    throw new ConvexError("Admin permission required");
  }

  return { userId: admin.userId, roles: admin.roles };
}

/**
 * Resolves an assured administrative session from Better Auth. This is the
 * identity gate for admin pages whose contents are permission-filtered later.
 */
export async function requireCurrentAdmin(
  ctx: AdminCtx,
): Promise<{
  userId: string;
  roles: AdminRole[];
  impersonatedBy?: string;
}> {
  const identity = await ctx.auth.getUserIdentity();
  const user = await authComponent.safeGetAuthUser(ctx);

  if (!identity || !user) {
    throw new ConvexError("You must be signed in to perform this action.");
  }
  if (user.twoFactorEnabled !== true) {
    throw new ConvexError("Two-factor authentication required");
  }

  const sessionId = identity.sessionId;
  if (typeof sessionId !== "string") {
    throw new ConvexError("You must be signed in to perform this action.");
  }
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [{ field: "_id", operator: "eq", value: sessionId }],
  });
  if (!session || session.userId !== user._id) {
    throw new ConvexError("You must be signed in to perform this action.");
  }
  if (
    typeof session.adminTwoFactorVerifiedAt !== "number" ||
    !Number.isFinite(session.adminTwoFactorVerifiedAt)
  ) {
    throw new ConvexError("Two-factor verification required for this session");
  }

  const roles = parseAdminRoles(user.role);
  if (roles.length === 0) {
    throw new ConvexError("Admin permission required");
  }

  return {
    userId: user._id,
    roles,
    ...(typeof session.impersonatedBy === "string"
      ? { impersonatedBy: session.impersonatedBy }
      : {}),
  };
}
