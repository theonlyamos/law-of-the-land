import { v } from "convex/values";
import { components } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import { authComponent } from "../auth";
import { parseAdminRoles } from "../lib/adminPermissions";
import { writeAdminRoles } from "./roles";

const authTableCountsValidator = v.object({
  user: v.number(),
  session: v.number(),
  account: v.number(),
  verification: v.number(),
});

const authMigrationSnapshotValidator = v.object({
  component: v.string(),
  counts: authTableCountsValidator,
});

export type AuthTableCounts = {
  user: number;
  session: number;
  account: number;
  verification: number;
};

export type AuthMigrationSnapshot = {
  component: string;
  counts: AuthTableCounts;
};

const authTables = ["user", "session", "account", "verification"] as const;

const MAX_INITIAL_SUPER_ADMINS = 100;

export function parseInitialSuperAdminIds(value: string | undefined): string[] {
  const userIds = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((userId) => userId.trim())
        .filter(Boolean),
    ),
  ];

  if (userIds.length > MAX_INITIAL_SUPER_ADMINS) {
    throw new Error(
      `INITIAL_SUPER_ADMIN_IDS cannot contain more than ${MAX_INITIAL_SUPER_ADMINS} users`,
    );
  }

  return userIds;
}

export function verifyAuthMigrationSnapshot(
  before: AuthMigrationSnapshot,
  after: AuthMigrationSnapshot,
): AuthMigrationSnapshot {
  if (before.component !== "betterAuth" || after.component !== "betterAuth") {
    throw new Error(
      `Better Auth component identity changed: ${before.component} -> ${after.component}`,
    );
  }

  for (const table of authTables) {
    if (before.counts[table] !== after.counts[table]) {
      throw new Error(
        `Better Auth component data changed: ${table} ${before.counts[table]} -> ${after.counts[table]}`,
      );
    }
  }

  return after;
}

async function readAuthMigrationSnapshot(
  ctx: QueryCtx,
): Promise<AuthMigrationSnapshot> {
  const counts: AuthTableCounts = await ctx.runQuery(
    components.betterAuth.migrations.countAuthTables,
    {},
  );

  return { component: "betterAuth", counts };
}

export const captureAuthMigrationSnapshot = internalQuery({
  args: {},
  returns: authMigrationSnapshotValidator,
  handler: readAuthMigrationSnapshot,
});

export const assertAuthMigrationSnapshot = internalQuery({
  args: { before: authMigrationSnapshotValidator },
  returns: authMigrationSnapshotValidator,
  handler: async (ctx, args) =>
    verifyAuthMigrationSnapshot(
      args.before,
      await readAuthMigrationSnapshot(ctx),
    ),
});

export const bootstrapSuperAdmins = internalMutation({
  args: {},
  returns: v.object({
    promoted: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx) => {
    const allowlistedUserIds = parseInitialSuperAdminIds(
      process.env.INITIAL_SUPER_ADMIN_IDS,
    );
    let promoted = 0;
    let unchanged = 0;

    for (const targetUserId of allowlistedUserIds) {
      const target = await authComponent.getAnyUserById(ctx, targetUserId);
      if (!target) {
        throw new Error(`Allowlisted Better Auth user not found: ${targetUserId}`);
      }
      const currentRoles = parseAdminRoles(target.role);
      const result = await writeAdminRoles(ctx, {
        actorType: "system",
        targetUserId,
        roles: [...new Set([...currentRoles, "super_admin" as const])],
        auditAction: "admin.bootstrap_super_admin",
      });
      if (result.changed) {
        promoted += 1;
      } else {
        unchanged += 1;
      }
    }

    return { promoted, unchanged };
  },
});
