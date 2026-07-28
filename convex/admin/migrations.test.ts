/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import {
  parseInitialSuperAdminIds,
  verifyAuthMigrationSnapshot,
} from "./migrations";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);

const seedGhanaJurisdiction = makeFunctionReference<"mutation">(
  "admin/migrations:seedGhanaJurisdiction",
);

const before = {
  component: "betterAuth" as const,
  counts: {
    user: 2,
    session: 3,
    account: 2,
    verification: 1,
  },
};

describe("Better Auth migration preservation gate", () => {
  it("normalizes the bootstrap allowlist without widening it", () => {
    expect(parseInitialSuperAdminIds(" user-1, user-2, user-1, , ")).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(parseInitialSuperAdminIds(undefined)).toEqual([]);
  });

  it("accepts the same component and table counts", () => {
    expect(verifyAuthMigrationSnapshot(before, before)).toEqual(before);
  });

  it("rejects a component identity change", () => {
    expect(() =>
      verifyAuthMigrationSnapshot(before, {
        ...before,
        component: "differentComponent" as never,
      }),
    ).toThrow("Better Auth component identity changed");
  });

  it("rejects any table count change", () => {
    expect(() =>
      verifyAuthMigrationSnapshot(before, {
        ...before,
        counts: { ...before.counts, session: 0 },
      }),
    ).toThrow("Better Auth component data changed: session 3 -> 0");
  });
});

describe("Ghana governed jurisdiction migration", () => {
  it("creates an enabled default with the production bucket and migration provenance", async () => {
    const t = convexTest(schema, modules);

    await expect(t.mutation(seedGhanaJurisdiction, {})).resolves.toMatchObject({
      changed: true,
      created: true,
    });

    const snapshot = await t.run(async (ctx) => ({
      jurisdictions: await ctx.db.query("jurisdictions").take(5),
      audits: await ctx.db
        .query("auditEvents")
        .withIndex("by_action_and_createdAt", (q) =>
          q.eq("action", "migration.seed_ghana_jurisdiction"),
        )
        .take(5),
    }));
    expect(snapshot.jurisdictions).toHaveLength(1);
    expect(snapshot.jurisdictions[0]).toMatchObject({
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      isDefault: true,
      productionBucketId: "11833",
      providerSyncState: "synced",
      createdBy: "migration:seed-ghana-jurisdiction-v1",
      updatedBy: "migration:seed-ghana-jurisdiction-v1",
    });
    expect(snapshot.jurisdictions[0]).not.toHaveProperty("stagingBucketId");
    expect(snapshot.audits).toHaveLength(1);
    expect(snapshot.audits[0]).toMatchObject({
      actorType: "system",
      action: "migration.seed_ghana_jurisdiction",
      targetType: "jurisdiction",
      metadata: {
        migration: "seed-ghana-jurisdiction-v1",
        result: "created",
      },
    });
  });

  it("preserves user-managed fields while patching only required governed state", async () => {
    const t = convexTest(schema, modules);
    const createdAt = 1234;
    const id = await t.run(async (ctx) =>
      await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Republic of Ghana",
        slug: "ghana-law",
        status: "draft",
        isDefault: false,
        stagingBucketId: "user-staging-bucket",
        productionBucketId: "old-production-bucket",
        providerSyncState: "drifted",
        createdBy: "user-123",
        updatedBy: "user-456",
        createdAt,
        updatedAt: 5678,
      }),
    );

    await expect(t.mutation(seedGhanaJurisdiction, {})).resolves.toEqual({
      jurisdictionId: id,
      changed: true,
      created: false,
    });

    const row = await t.run(async (ctx) => await ctx.db.get("jurisdictions", id));
    expect(row).toMatchObject({
      code: "GH",
      name: "Republic of Ghana",
      slug: "ghana-law",
      stagingBucketId: "user-staging-bucket",
      createdBy: "user-123",
      createdAt,
      status: "enabled",
      isDefault: true,
      productionBucketId: "11833",
      providerSyncState: "synced",
      updatedBy: "migration:seed-ghana-jurisdiction-v1",
    });
  });

  it("is idempotent under retries and concurrent invocations", async () => {
    const t = convexTest(schema, modules);

    const [first, second] = await Promise.all([
      t.mutation(seedGhanaJurisdiction, {}),
      t.mutation(seedGhanaJurisdiction, {}),
    ]);
    const third = await t.mutation(seedGhanaJurisdiction, {});

    expect([first.changed, second.changed].sort()).toEqual([false, true]);
    expect(third.changed).toBe(false);
    const snapshot = await t.run(async (ctx) => ({
      jurisdictions: await ctx.db
        .query("jurisdictions")
        .withIndex("by_code", (q) => q.eq("code", "GH"))
        .take(2),
      audits: await ctx.db
        .query("auditEvents")
        .withIndex("by_action_and_createdAt", (q) =>
          q.eq("action", "migration.seed_ghana_jurisdiction"),
        )
        .take(5),
    }));
    expect(snapshot.jurisdictions).toHaveLength(1);
    expect(snapshot.audits).toHaveLength(1);
  });

  it("fails closed on a conflicting active default without changing either record", async () => {
    const t = convexTest(schema, modules);
    const before = await t.run(async (ctx) => {
      const now = Date.now();
      const otherId = await ctx.db.insert("jurisdictions", {
        code: "NG",
        name: "Nigeria",
        slug: "nigeria",
        status: "enabled",
        isDefault: true,
        productionBucketId: "ng-production",
        providerSyncState: "synced",
        createdBy: "user-1",
        updatedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });
      const ghId = await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "Custom Ghana",
        slug: "custom-ghana",
        status: "draft",
        isDefault: false,
        stagingBucketId: "custom-staging",
        providerSyncState: "pending",
        createdBy: "user-2",
        updatedBy: "user-2",
        createdAt: now,
        updatedAt: now,
      });
      return {
        otherId,
        ghId,
        other: await ctx.db.get("jurisdictions", otherId),
        gh: await ctx.db.get("jurisdictions", ghId),
      };
    });

    await expect(t.mutation(seedGhanaJurisdiction, {})).rejects.toThrow(
      "GHANA_SEED_DEFAULT_CONFLICT",
    );

    const after = await t.run(async (ctx) => ({
      other: await ctx.db.get("jurisdictions", before.otherId),
      gh: await ctx.db.get("jurisdictions", before.ghId),
      audits: await ctx.db.query("auditEvents").take(5),
    }));
    expect(after.other).toEqual(before.other);
    expect(after.gh).toEqual(before.gh);
    expect(after.audits).toHaveLength(0);
  });

  it("finds an active default even when older archived defaults fill the first bounded page", async () => {
    const t = convexTest(schema, modules);
    const before = await t.run(async (ctx) => {
      const now = Date.now();
      for (const code of ["AA", "BB"]) {
        await ctx.db.insert("jurisdictions", {
          code,
          name: `Archived ${code}`,
          slug: `archived-${code.toLowerCase()}`,
          status: "archived",
          isDefault: true,
          providerSyncState: "synced",
          createdBy: "legacy-migration",
          updatedBy: "legacy-migration",
          createdAt: now,
          updatedAt: now,
        });
      }
      const activeDefaultId = await ctx.db.insert("jurisdictions", {
        code: "NG",
        name: "Nigeria",
        slug: "nigeria",
        status: "enabled",
        isDefault: true,
        productionBucketId: "ng-production",
        providerSyncState: "synced",
        createdBy: "user-1",
        updatedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });
      const ghId = await ctx.db.insert("jurisdictions", {
        code: "GH",
        name: "User Ghana",
        slug: "user-ghana",
        status: "draft",
        isDefault: false,
        stagingBucketId: "user-staging",
        providerSyncState: "pending",
        createdBy: "user-2",
        updatedBy: "user-2",
        createdAt: now,
        updatedAt: now,
      });
      return {
        ghId,
        activeDefaultId,
        gh: await ctx.db.get("jurisdictions", ghId),
        activeDefault: await ctx.db.get("jurisdictions", activeDefaultId),
      };
    });

    await expect(t.mutation(seedGhanaJurisdiction, {})).rejects.toThrow(
      "GHANA_SEED_DEFAULT_CONFLICT",
    );

    const after = await t.run(async (ctx) => ({
      gh: await ctx.db.get("jurisdictions", before.ghId),
      activeDefault: await ctx.db.get(
        "jurisdictions",
        before.activeDefaultId,
      ),
      audits: await ctx.db.query("auditEvents").take(5),
    }));
    expect(after.gh).toEqual(before.gh);
    expect(after.activeDefault).toEqual(before.activeDefault);
    expect(after.audits).toHaveLength(0);
  });

  it("fails closed when duplicate Ghana codes make the migration target ambiguous", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const slug of ["ghana-one", "ghana-two"]) {
        await ctx.db.insert("jurisdictions", {
          code: "GH",
          name: slug,
          slug,
          status: "draft",
          isDefault: false,
          providerSyncState: "pending",
          createdBy: slug,
          updatedBy: slug,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const before = await t.run(async (ctx) =>
      await ctx.db.query("jurisdictions").take(5),
    );

    await expect(t.mutation(seedGhanaJurisdiction, {})).rejects.toThrow(
      "GHANA_SEED_CODE_CONFLICT",
    );

    await expect(
      t.run(async (ctx) => await ctx.db.query("jurisdictions").take(5)),
    ).resolves.toEqual(before);
  });

  it("fails closed when the canonical Ghana slug belongs to another code", async () => {
    const t = convexTest(schema, modules);
    const existingId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jurisdictions", {
        code: "NG",
        name: "User jurisdiction",
        slug: "ghana",
        status: "draft",
        isDefault: false,
        stagingBucketId: "user-staging",
        providerSyncState: "pending",
        createdBy: "user-1",
        updatedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });
    });
    const before = await t.run(async (ctx) =>
      await ctx.db.get("jurisdictions", existingId),
    );

    await expect(t.mutation(seedGhanaJurisdiction, {})).rejects.toThrow(
      "GHANA_SEED_SLUG_CONFLICT",
    );

    const after = await t.run(async (ctx) => ({
      existing: await ctx.db.get("jurisdictions", existingId),
      all: await ctx.db.query("jurisdictions").take(5),
    }));
    expect(after.existing).toEqual(before);
    expect(after.all).toHaveLength(1);
  });
});
