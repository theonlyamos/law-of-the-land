import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authComponent } from "../auth";
import { parseAdminRoles } from "../lib/adminPermissions";
import { writeAdminRoles } from "./roles";
import { appendAuditEvent } from "../lib/audit";
import type { Id } from "../_generated/dataModel";

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
const GHANA_MIGRATION_ACTOR = "migration:seed-ghana-jurisdiction-v1";
const GHANA_PRODUCTION_BUCKET_ID = "11833";

async function assertGhanaSeedConflicts(
  ctx: MutationCtx,
  existingId?: Id<"jurisdictions">,
) {
  const [draftDefaults, enabledDefaults] = await Promise.all([
    ctx.db
      .query("jurisdictions")
      .withIndex("by_isDefault_and_status", (q) =>
        q.eq("isDefault", true).eq("status", "draft"),
      )
      .take(2),
    ctx.db
      .query("jurisdictions")
      .withIndex("by_isDefault_and_status", (q) =>
        q.eq("isDefault", true).eq("status", "enabled"),
      )
      .take(2),
  ]);
  if (
    [...draftDefaults, ...enabledDefaults].some(
      (row) => row._id !== existingId && row.status !== "archived",
    )
  ) {
    throw new ConvexError("GHANA_SEED_DEFAULT_CONFLICT");
  }
}

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

/**
 * Internal-only rollout gate for public Ghana search. Operators must run this
 * successfully before deploying the route that consumes governed buckets.
 */
export const seedGhanaJurisdiction = internalMutation({
  args: {},
  returns: v.object({
    jurisdictionId: v.id("jurisdictions"),
    changed: v.boolean(),
    created: v.boolean(),
  }),
  handler: async (ctx) => {
    const existingRows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", "GH"))
      .take(2);
    if (existingRows.length > 1) {
      throw new ConvexError("GHANA_SEED_CODE_CONFLICT");
    }
    const existing = existingRows[0];
    await assertGhanaSeedConflicts(ctx, existing?._id);

    if (!existing) {
      const slugRows = await ctx.db
        .query("jurisdictions")
        .withIndex("by_slug", (q) => q.eq("slug", "ghana"))
        .take(2);
      if (slugRows.length > 0) {
        throw new ConvexError("GHANA_SEED_SLUG_CONFLICT");
      }
    }

    const alreadyGoverned =
      existing?.status === "enabled" &&
      existing.isDefault === true &&
      existing.productionBucketId === GHANA_PRODUCTION_BUCKET_ID &&
      existing.providerSyncState === "synced";
    if (existing && alreadyGoverned) {
      return {
        jurisdictionId: existing._id,
        changed: false,
        created: false,
      };
    }

    const now = Date.now();
    const jurisdictionId = existing
      ? existing._id
      : await ctx.db.insert("jurisdictions", {
          code: "GH",
          name: "Ghana",
          slug: "ghana",
          status: "enabled",
          isDefault: true,
          productionBucketId: GHANA_PRODUCTION_BUCKET_ID,
          providerSyncState: "synced",
          createdBy: GHANA_MIGRATION_ACTOR,
          updatedBy: GHANA_MIGRATION_ACTOR,
          createdAt: now,
          updatedAt: now,
        });

    if (existing) {
      await ctx.db.patch("jurisdictions", existing._id, {
        status: "enabled",
        isDefault: true,
        productionBucketId: GHANA_PRODUCTION_BUCKET_ID,
        providerSyncState: "synced",
        updatedBy: GHANA_MIGRATION_ACTOR,
        updatedAt: now,
      });
    }

    await appendAuditEvent(ctx, {
      actorType: "system",
      action: "migration.seed_ghana_jurisdiction",
      targetType: "jurisdiction",
      targetId: jurisdictionId,
      metadata: {
        migration: "seed-ghana-jurisdiction-v1",
        result: existing ? "updated" : "created",
      },
    });

    return {
      jurisdictionId,
      changed: true,
      created: existing === undefined,
    };
  },
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
