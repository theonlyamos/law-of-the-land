import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalQuery, type QueryCtx } from "../_generated/server";

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
