import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { authComponent, createAuthOptions } from "../auth";
import {
  parseAdminRoles,
  type AdminRole,
} from "../lib/adminPermissions";
import { appendAuditEvent } from "../lib/audit";
import { requireAdminPermission } from "../lib/requireAdmin";

const adminRoleValidator = v.union(
  v.literal("super_admin"),
  v.literal("content_manager"),
  v.literal("content_reviewer"),
  v.literal("support_agent"),
  v.literal("billing_manager"),
  v.literal("auditor"),
);

type BetterAuthUser = NonNullable<
  Awaited<ReturnType<typeof authComponent.getAnyUserById>>
>;

function isActiveSuperAdmin(user: BetterAuthUser): boolean {
  const banHasExpired =
    user.banned === true &&
    typeof user.banExpires === "number" &&
    user.banExpires <= Date.now();
  return (
    user.twoFactorEnabled === true &&
    (user.banned !== true || banHasExpired) &&
    parseAdminRoles(user.role).includes("super_admin")
  );
}

function hasStringId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

async function hasAnotherActiveSuperAdmin(
  ctx: MutationCtx,
  excludedUserId: string,
): Promise<boolean> {
  const adapter = authComponent.adapter(ctx)(createAuthOptions(ctx));
  const commonWhere = [
    { field: "role", operator: "contains" as const, value: "super_admin" },
    { field: "twoFactorEnabled", value: true },
  ];
  const [unbanned, expiredBan] = await Promise.all([
    adapter.findMany({
      model: "user",
      where: [
        ...commonWhere,
        { field: "banned", operator: "ne", value: true },
      ],
      limit: 2,
    }),
    adapter.findMany({
      model: "user",
      where: [
        ...commonWhere,
        { field: "banned", value: true },
        { field: "banExpires", operator: "lte", value: new Date() },
      ],
      limit: 2,
    }),
  ]);

  return [...unbanned, ...expiredBan].some(
    (user) => hasStringId(user) && user.id !== excludedUserId,
  );
}

export async function writeAdminRoles(
  ctx: MutationCtx,
  input: {
    actorType: "system" | "user";
    actorUserId?: string;
    targetUserId: string;
    roles: readonly AdminRole[];
    auditAction: string;
  },
): Promise<{ changed: boolean; roles: AdminRole[] }> {
  const target = await authComponent.getAnyUserById(ctx, input.targetUserId);
  if (!target) {
    throw new ConvexError("Target user not found");
  }

  const nextRoles = [...new Set(input.roles)];
  const currentRoles = parseAdminRoles(target.role);
  if (nextRoles.length > 0 && target.twoFactorEnabled !== true) {
    throw new ConvexError("Target administrator must enroll in Two Factor");
  }

  if (
    isActiveSuperAdmin(target) &&
    currentRoles.includes("super_admin") &&
    !nextRoles.includes("super_admin") &&
    !(await hasAnotherActiveSuperAdmin(ctx, target._id))
  ) {
    throw new ConvexError("Cannot remove the last active super administrator");
  }

  if (
    currentRoles.length === nextRoles.length &&
    currentRoles.every((role) => nextRoles.includes(role))
  ) {
    return { changed: false, roles: currentRoles };
  }

  const isFirstAdminGrant = currentRoles.length === 0 && nextRoles.length > 0;
  const adapter = authComponent.adapter(ctx)(createAuthOptions(ctx));
  await adapter.update({
    model: "user",
    where: [{ field: "id", value: target._id }],
    update: { role: nextRoles.length > 0 ? nextRoles.join(",") : "user" },
  });
  const revokedSessions = isFirstAdminGrant
    ? await adapter.deleteMany({
        model: "session",
        where: [{ field: "userId", value: target._id }],
      })
    : 0;
  await appendAuditEvent(ctx, {
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    action: input.auditAction,
    targetType: "user",
    targetId: target._id,
    metadata: {
      previousRoles: currentRoles.join(",") || "user",
      nextRoles: nextRoles.join(",") || "user",
      revokedSessions,
    },
  });

  return { changed: true, roles: nextRoles };
}

export const setAdminRoles = mutation({
  args: {
    targetUserId: v.string(),
    roles: v.array(adminRoleValidator),
  },
  returns: v.object({
    changed: v.boolean(),
    roles: v.array(adminRoleValidator),
  }),
  handler: async (ctx, args) => {
    const actor = await requireAdminPermission(ctx, "user", "set_role");
    return await writeAdminRoles(ctx, {
      actorType: "user",
      actorUserId: actor.userId,
      targetUserId: args.targetUserId,
      roles: args.roles,
      auditAction: "admin.roles_changed",
    });
  },
});
