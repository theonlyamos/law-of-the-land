/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema";
import { calculateUnifiedJurisdictionRolloutState } from "../lib/unifiedJurisdictionRollout";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);

const seedGhanaJurisdictionV2 = makeFunctionReference<"mutation">(
  "admin/migrations:seedGhanaJurisdictionV2",
);
const backfillJurisdictionReferences = makeFunctionReference<"mutation">(
  "admin/migrations:backfillJurisdictionReferences",
);

const previousEnvironment = process.env.ADMIN_ENVIRONMENT;
const place = {
  googlePlaceId: "approved-ghana-place",
  formattedAddress: "Ghana",
  latitude: 7.9465,
  longitude: -1.0232,
};

beforeEach(() => {
  process.env.ADMIN_ENVIRONMENT = "test";
});

afterEach(() => {
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

async function insertGhana(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      code: "GH",
      name: "Republic of Ghana",
      slug: "ghana-law",
      status: "enabled",
      isDefault: true,
      stagingBucketId: "ghana-staging",
      productionBucketId: "11833",
      providerSyncState: "synced",
      createdBy: "operator-1",
      updatedBy: "operator-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "constitution",
      title: "Constitution of Ghana",
      issuer: "Republic of Ghana",
      officialCitation: "1992 Constitution",
      officialCitationKey: "1992-constitution",
      sourceUrl: "https://example.test/ghana",
      topics: ["constitutional law"],
      effectiveDate: "1993-01-07",
      status: "active",
      createdBy: "operator-1",
      updatedBy: "operator-1",
      createdAt: 1,
      updatedAt: 2,
    });
    return { jurisdictionId, resourceId };
  });
}

describe("safe unified-jurisdiction migration", () => {
  it("adds Ghana V2 typing without replacing the jurisdiction, resource, or production bucket", async () => {
    const t = convexTest(schema, modules);
    const before = await insertGhana(t);

    await expect(
      t.mutation(seedGhanaJurisdictionV2, {
        environment: "test",
        place,
        confirmation: "SEED_GHANA_JURISDICTION_V2 test",
        reason: "Adopt the reviewed Ghana country projection",
        idempotencyKey: "ghana-v2-seed-1",
      }),
    ).resolves.toEqual({
      jurisdictionId: before.jurisdictionId,
      changed: true,
      preservedProductionBucket: "11833",
    });

    const after = await t.run(async (ctx) => ({
      jurisdiction: await ctx.db.get("jurisdictions", before.jurisdictionId),
      resource: await ctx.db.get("legalResources", before.resourceId),
      profiles: await ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) =>
          q.eq("jurisdictionId", before.jurisdictionId),
        )
        .take(2),
    }));
    expect(after.jurisdiction).toMatchObject({
      _id: before.jurisdictionId,
      name: "Republic of Ghana",
      slug: "ghana-law",
      kind: "geographic",
      visibility: "public",
      legacyCountryCode: "GH",
      stagingBucketId: "ghana-staging",
      productionBucketId: "11833",
      createdBy: "operator-1",
      createdAt: 1,
    });
    expect(after.resource?._id).toBe(before.resourceId);
    expect(after.profiles).toHaveLength(1);
    expect(after.profiles[0]).toMatchObject({
      jurisdictionId: before.jurisdictionId,
      googlePlaceId: place.googlePlaceId,
      formattedAddress: place.formattedAddress,
      level: "country",
      countryCode: "GH",
      latitude: place.latitude,
      longitude: place.longitude,
    });
    expect(after.profiles[0]).not.toHaveProperty("parentJurisdictionId");
  });

  it.each([
    ["empty Place ID", { ...place, googlePlaceId: " " }],
    ["oversized Place ID", { ...place, googlePlaceId: "x".repeat(256) }],
    ["empty address", { ...place, formattedAddress: " " }],
    ["oversized address", { ...place, formattedAddress: "x".repeat(501) }],
    ["controlled address", { ...place, formattedAddress: "Ghana\u0000" }],
    ["latitude below range", { ...place, latitude: -90.0001 }],
    ["latitude above range", { ...place, latitude: 90.0001 }],
    ["longitude below range", { ...place, longitude: -180.0001 }],
    ["longitude above range", { ...place, longitude: 180.0001 }],
  ])("rejects invalid Ghana projection input: %s", async (_name, invalidPlace) => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await expect(t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place: invalidPlace,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Validate the reviewed Ghana country projection",
      idempotencyKey: "ghana-invalid-projection",
    })).rejects.toThrow("GHANA_SEED_V2_PROJECTION_INVALID");
  });

  it("replays Ghana seeding without provider access and rejects key reuse drift", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const args = {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-seed-replay",
    };
    const first = await t.mutation(seedGhanaJurisdictionV2, args);
    const replay = await t.mutation(seedGhanaJurisdictionV2, args);
    expect(replay).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(t.mutation(seedGhanaJurisdictionV2, {
      ...args, place: { ...place, longitude: place.longitude + 0.001 },
    })).rejects.toThrow("JURISDICTION_MIGRATION_IDEMPOTENCY_CONFLICT");
    await expect(t.run(async (ctx) => ({
      profiles: await ctx.db.query("geographicJurisdictions").take(2),
      audits: await ctx.db.query("auditEvents")
        .withIndex("by_action_and_createdAt", (q) =>
          q.eq("action", "migration.seed_ghana_jurisdiction_v2"))
        .take(2),
    }))).resolves.toMatchObject({ profiles: [expect.any(Object)], audits: [expect.any(Object)] });
    fetchSpy.mockRestore();
  });

  it.each([[-90, -180], [90, 180]])(
    "accepts inclusive Ghana coordinate boundary %s,%s",
    async (latitude, longitude) => {
      const t = convexTest(schema, modules);
      await insertGhana(t);
      await expect(t.mutation(seedGhanaJurisdictionV2, {
        environment: "test", place: { ...place, latitude, longitude },
        confirmation: "SEED_GHANA_JURISDICTION_V2 test",
        reason: "Validate inclusive Ghana projection boundaries",
        idempotencyKey: `ghana-boundary-${latitude}-${longitude}`,
      })).resolves.toMatchObject({ preservedProductionBucket: "11833" });
    },
  );

  it("rejects duplicate Ghana rows and a Place ID owned by another jurisdiction", async () => {
    const duplicate = convexTest(schema, modules);
    await insertGhana(duplicate);
    await duplicate.run((ctx) => ctx.db.insert("jurisdictions", {
      code: "GH", name: "Duplicate Ghana", slug: "ghana-duplicate",
      status: "enabled", isDefault: false, productionBucketId: "11833",
      providerSyncState: "synced", createdBy: "fixture", updatedBy: "fixture",
      createdAt: 1, updatedAt: 1,
    }));
    await expect(duplicate.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Reject ambiguous Ghana code state", idempotencyKey: "ghana-duplicate",
    })).rejects.toThrow("GHANA_SEED_V2_CODE_CONFLICT");

    const placeCollision = convexTest(schema, modules);
    await insertGhana(placeCollision);
    await placeCollision.run(async (ctx) => {
      const otherId = await ctx.db.insert("jurisdictions", {
        code: "NG", name: "Nigeria", slug: "nigeria", kind: "geographic",
        visibility: "public", status: "enabled", isDefault: false,
        providerSyncState: "pending", createdBy: "fixture", updatedBy: "fixture",
        createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("geographicJurisdictions", {
        jurisdictionId: otherId, googlePlaceId: place.googlePlaceId,
        level: "country", countryCode: "NG", latitude: 9.082,
        longitude: 8.6753, formattedAddress: "Nigeria", createdAt: 1, updatedAt: 1,
      });
    });
    await expect(placeCollision.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Reject cross-linked Place identity", idempotencyKey: "ghana-place-collision",
    })).rejects.toThrow("GHANA_SEED_V2_PLACE_ID_CONFLICT");
  });

  it("resumes a 150-row execute backfill and requires a following clean verification run", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-v2-before-backfill",
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert("chatSessions", {
          userId: `user-${index}`,
          externalId: `chat-${index}`,
          title: "Legacy chat",
          lastMessage: "Question",
          messageCount: 1,
          updatedAt: index,
          country: "GH",
        });
      }
    });

    const args = {
      environment: "test",
      target: "chatSessions" as const,
      batchSize: 100,
      dryRun: false,
      confirmation:
        "UNIFIED_JURISDICTIONS BACKFILL test chatSessions EXECUTE",
      reason: "Backfill stable jurisdiction references",
    };
    const first = await t.mutation(backfillJurisdictionReferences, {
      ...args,
      cursor: null,
      idempotencyKey: "chat-backfill-page-1",
    });
    expect(first).toMatchObject({
      processed: 100,
      updated: 100,
      unresolved: 0,
      mismatches: 0,
      isDone: false,
    });
    expect(first.continueCursor).toMatch(/^ujm1_/);

    const second = await t.mutation(backfillJurisdictionReferences, {
      ...args,
      cursor: first.continueCursor,
      idempotencyKey: "chat-backfill-page-2",
    });
    expect(second).toMatchObject({
      processed: 50,
      updated: 50,
      unresolved: 0,
      mismatches: 0,
      continueCursor: null,
      isDone: true,
    });

    const rows = await t.run((ctx) => ctx.db.query("chatSessions").take(151));
    expect(rows).toHaveLength(150);
    expect(rows.every((row) => row.jurisdictionId === jurisdictionId)).toBe(true);
    expect(rows.every((row) => row.jurisdictionContract === "legacy")).toBe(true);

    const verifyFirst = await t.mutation(backfillJurisdictionReferences, {
      ...args,
      cursor: null,
      idempotencyKey: "chat-verify-page-1",
    });
    const verifySecond = await t.mutation(backfillJurisdictionReferences, {
      ...args,
      cursor: verifyFirst.continueCursor,
      idempotencyKey: "chat-verify-page-2",
    });
    expect(verifyFirst.updated + verifySecond.updated).toBe(0);
    expect({ verifyFirst, verifySecond }).toMatchObject({
      verifyFirst: { unresolved: 0, mismatches: 0, isDone: false },
      verifySecond: { unresolved: 0, mismatches: 0, isDone: true },
    });
    await expect(
      t.run(async (ctx) => {
        const checkpoints = await ctx.db
          .query("jurisdictionMigrationCheckpoints")
          .withIndex(
            "by_environment_and_migrationVersion_and_target_and_mode",
            (q) =>
              q
                .eq("environment", "test")
                .eq("migrationVersion", "jurisdiction_ids_v1")
                .eq("target", "chatSessions")
                .eq("mode", "execute"),
          )
          .take(2);
        return checkpoints[0]?.verifiedAt;
      }),
    ).resolves.toEqual(expect.any(Number));
  });

  it.each([0, 1.5, 101])("rejects invalid batch size %s before scanning", async (batchSize) => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(backfillJurisdictionReferences, {
        environment: "test",
        target: "dailyMetrics",
        cursor: null,
        batchSize,
        dryRun: true,
        confirmation:
          "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics DRY_RUN",
        reason: "Inspect stable jurisdiction references",
        idempotencyKey: "metrics-dry-run-1",
      }),
    ).rejects.toThrow("JURISDICTION_MIGRATION_BATCH_SIZE_INVALID");
  });

  it("requires two completed execute passes even when the target begins clean", async () => {
    const t = convexTest(schema, modules);
    const args = {
      environment: "test",
      target: "queryRuns" as const,
      cursor: null,
      batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test queryRuns EXECUTE",
      reason: "Verify stable jurisdiction references",
    };
    await t.mutation(backfillJurisdictionReferences, {
      ...args,
      idempotencyKey: "query-clean-pass-1",
    });
    await expect(
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("jurisdictionMigrationCheckpoints")
          .withIndex(
            "by_environment_and_migrationVersion_and_target_and_mode",
            (q) =>
              q
                .eq("environment", "test")
                .eq("migrationVersion", "jurisdiction_ids_v1")
                .eq("target", "queryRuns")
                .eq("mode", "execute"),
          )
          .unique();
        return row?.verifiedAt;
      }),
    ).resolves.toBeNull();

    await t.mutation(backfillJurisdictionReferences, {
      ...args,
      idempotencyKey: "query-clean-pass-2",
    });
    await expect(
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("jurisdictionMigrationCheckpoints")
          .withIndex(
            "by_environment_and_migrationVersion_and_target_and_mode",
            (q) =>
              q
                .eq("environment", "test")
                .eq("migrationVersion", "jurisdiction_ids_v1")
                .eq("target", "queryRuns")
                .eq("mode", "execute"),
          )
          .unique();
        return row?.verifiedAt;
      }),
    ).resolves.toEqual(expect.any(Number));
  });

  it("fails Ghana readiness when the persisted profile drifts from the seeded projection", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-readiness-drift",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_googlePlaceId", (q) =>
          q.eq("googlePlaceId", place.googlePlaceId),
        )
        .unique();
      if (!profile) throw new Error("Ghana profile fixture missing");
      await ctx.db.patch(profile._id, { latitude: profile.latitude + 1 });
    });

    await expect(
      t.run((ctx) =>
        calculateUnifiedJurisdictionRolloutState(ctx, "test", Date.now()),
      ),
    ).resolves.toMatchObject({
      ghana: { ready: false, reasons: ["GHANA_PROFILE_INVALID"] },
      blockers: expect.arrayContaining(["GHANA_NOT_READY"]),
    });
  });

  it.each([
    "organizationId",
    "organizationalProfile",
    "otherActiveDefault",
  ] as const)("fails Ghana readiness after %s drift", async (drift) => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: `ghana-readiness-${drift}`,
    });
    await t.run(async (ctx) => {
      if (drift === "organizationId") {
        const organizationId = await ctx.db.insert("organizations", {
          name: "Ghana Authority", slug: "ghana-authority", class: "government",
          status: "active", createdBy: "fixture", updatedBy: "fixture",
          createdAt: 1, updatedAt: 1,
        });
        await ctx.db.patch(jurisdictionId, { organizationId });
      } else if (drift === "organizationalProfile") {
        await ctx.db.insert("organizationalJurisdictions", {
          jurisdictionId, scopeMode: "global", createdAt: 1, updatedAt: 1,
        });
      } else {
        await ctx.db.insert("jurisdictions", {
          code: "NG", name: "Nigeria", slug: "nigeria-readiness-drift",
          kind: "geographic", visibility: "public", status: "enabled",
          isDefault: true, providerSyncState: "pending", createdBy: "fixture",
          updatedBy: "fixture", createdAt: 1, updatedAt: 1,
        });
      }
    });
    await expect(t.run((ctx) =>
      calculateUnifiedJurisdictionRolloutState(ctx, "test", Date.now()),
    )).resolves.toMatchObject({
      ghana: { ready: false },
      blockers: expect.arrayContaining(["GHANA_NOT_READY"]),
      canEnable: false,
    });
  });

  it("rejects non-canonical stored legacy codes instead of normalizing migration data", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.run((ctx) =>
      ctx.db.insert("chatSessions", {
        userId: "legacy-owner",
        externalId: "legacy-chat",
        title: "Legacy chat",
        lastMessage: "Question",
        messageCount: 1,
        updatedAt: 1,
        country: " gh ",
      }),
    );

    await expect(
      t.mutation(backfillJurisdictionReferences, {
        environment: "test",
        target: "chatSessions",
        cursor: null,
        batchSize: 100,
        dryRun: true,
        confirmation:
          "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
        reason: "Inspect stable jurisdiction references",
        idempotencyKey: "invalid-code-dry-run",
      }),
    ).resolves.toMatchObject({ updated: 0, unresolved: 1, mismatches: 0 });
  });

  it("fills a blank required name snapshot without rewriting a nonblank historical name", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-before-name-fill",
    });
    const runId = await t.run((ctx) =>
      ctx.db.insert("queryRuns", {
        correlationId: "blank-name-run",
        day: "2026-08-15",
        jurisdictionCode: "GH",
        jurisdictionId,
        jurisdictionName: "   ",
        jurisdictionKind: "geographic",
        outcome: "success",
        searchProviderStatus: "success",
        generationProviderStatus: "success",
        searchLatencyMs: 1,
        generationLatencyMs: 1,
        totalLatencyMs: 2,
        resultCount: 1,
        completedAt: 1,
        rollupStatus: "processed",
      }),
    );
    await t.mutation(backfillJurisdictionReferences, {
      environment: "test",
      target: "queryRuns",
      cursor: null,
      batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test queryRuns EXECUTE",
      reason: "Backfill stable jurisdiction references",
      idempotencyKey: "blank-name-execute",
    });
    await expect(t.run((ctx) => ctx.db.get("queryRuns", runId))).resolves.toMatchObject({
      jurisdictionName: "Republic of Ghana",
    });
  });

  it("rejects malformed checkpoint counters before idempotency replay", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("jurisdictionMigrationCheckpoints", {
        environment: "test",
        migrationVersion: "jurisdiction_ids_v1",
        target: "dailyMetrics",
        mode: "dry_run",
        runNumber: 1,
        status: "completed",
        processed: -1,
        updated: 0,
        unresolved: 0,
        mismatches: 0,
        startedAt: 1,
        completedAt: 1,
        lastIdempotencyKey: "malformed-checkpoint",
        lastRequestFingerprint: "bad",
        lastResult: {
          processed: -1,
          updated: 0,
          unresolved: 0,
          mismatches: 0,
          continueCursor: null,
          isDone: true,
        },
        updatedAt: 1,
      }),
    );
    await expect(
      t.mutation(backfillJurisdictionReferences, {
        environment: "test",
        target: "dailyMetrics",
        cursor: null,
        batchSize: 100,
        dryRun: true,
        confirmation:
          "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics DRY_RUN",
        reason: "Inspect stable jurisdiction references",
        idempotencyKey: "malformed-checkpoint",
      }),
    ).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it.each([
    ["page exceeds cumulative", { processed: 0 }],
    ["completed precedes start", { startedAt: 2, completedAt: 1, updatedAt: 2 }],
    ["completed result is running", {
      status: "completed" as const,
      completedAt: 2,
      lastResult: { processed: 1, updated: 0, unresolved: 0, mismatches: 0,
        continueCursor: `ujm1_${"1".repeat(32)}`, isDone: false },
    }],
  ])("rejects malformed checkpoint invariant: %s", async (_name, override) => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("jurisdictionMigrationCheckpoints", {
      environment: "test", migrationVersion: "jurisdiction_ids_v1",
      target: "dailyMetrics", mode: "execute", runNumber: 1,
      status: "completed", processed: 1, updated: 0, unresolved: 0,
      mismatches: 0, startedAt: 1, completedAt: 2,
      lastIdempotencyKey: "malformed-invariant",
      lastRequestFingerprint: "a".repeat(64),
      lastResult: { processed: 1, updated: 0, unresolved: 0, mismatches: 0,
        continueCursor: null, isDone: true },
      updatedAt: 2,
      ...override,
    }));
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "dailyMetrics", cursor: null, batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics EXECUTE",
      reason: "Verify stable jurisdiction references",
      idempotencyKey: "malformed-new-request",
    })).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it("maps a corrupt stored database cursor to the fixed state-invalid error", async () => {
    const t = convexTest(schema, modules);
    const token = `ujm1_${"1".repeat(32)}`;
    await t.run((ctx) => ctx.db.insert("jurisdictionMigrationCheckpoints", {
      environment: "test", migrationVersion: "jurisdiction_ids_v1",
      target: "dailyMetrics", mode: "dry_run", runNumber: 1,
      status: "running", databaseCursor: "corrupt-database-cursor",
      continuationToken: token, processed: 1, updated: 0, unresolved: 0,
      mismatches: 0, startedAt: 1,
      lastIdempotencyKey: "cursor-corrupt-page-1",
      lastRequestFingerprint: "a".repeat(64),
      lastResult: { processed: 1, updated: 0, unresolved: 0, mismatches: 0,
        continueCursor: token, isDone: false },
      updatedAt: 1,
    }));
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "dailyMetrics", cursor: token, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics DRY_RUN",
      reason: "Inspect stable jurisdiction references",
      idempotencyKey: "cursor-corrupt-page-2",
    })).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it("blocks a legacy daily aggregate when an ID aggregate already owns the day", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-daily-collision",
    });
    const legacyId = await t.run(async (ctx) => {
      const base = {
        day: "2026-08-15", totalQuestions: 1, successCount: 1,
        failureCount: 0, abortedCount: 0, providerFailureCount: 0,
        noResultCount: 0, latencyLe250: 1, latencyLe500: 0,
        latencyLe1000: 0, latencyLe2500: 0, latencyLe5000: 0,
        latencyGt5000: 0, p50UpperBoundMs: 250, p95UpperBoundMs: 250,
        updatedAt: 1,
      };
      await ctx.db.insert("dailyMetrics", {
        ...base, jurisdictionId, jurisdictionCode: "GH",
        jurisdictionName: "Republic of Ghana", jurisdictionKind: "geographic",
      });
      return ctx.db.insert("dailyMetrics", { ...base, jurisdictionCode: "GH" });
    });
    const result = await t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "dailyMetrics", cursor: null, batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics EXECUTE",
      reason: "Backfill stable jurisdiction references",
      idempotencyKey: "daily-legacy-id-collision",
    });
    expect(result).toMatchObject({ processed: 2, updated: 0, mismatches: 2 });
    await expect(t.run((ctx) => ctx.db.get("dailyMetrics", legacyId)))
      .resolves.not.toHaveProperty("jurisdictionId");
  });

  it("classifies every already-ID daily aggregate duplicate as a mismatch", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-id-duplicate",
    });
    await t.run(async (ctx) => {
      for (const updatedAt of [1, 2]) {
        await ctx.db.insert("dailyMetrics", {
          day: "2026-08-16", jurisdictionId, jurisdictionCode: "GH",
          jurisdictionName: "Republic of Ghana", jurisdictionKind: "geographic",
          totalQuestions: 1, successCount: 1, failureCount: 0, abortedCount: 0,
          providerFailureCount: 0, noResultCount: 0, latencyLe250: 1,
          latencyLe500: 0, latencyLe1000: 0, latencyLe2500: 0,
          latencyLe5000: 0, latencyGt5000: 0, p50UpperBoundMs: 250,
          p95UpperBoundMs: 250, updatedAt,
        });
      }
    });
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "dailyMetrics", cursor: null, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics DRY_RUN",
      reason: "Inspect stable jurisdiction references",
      idempotencyKey: "daily-id-duplicate",
    })).resolves.toMatchObject({ processed: 2, updated: 0, mismatches: 2 });
  });

  it("keeps cross-page duplicate daily candidates mismatched in dry-run and execute", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-cross-page-daily",
    });
    await t.run(async (ctx) => {
      for (const updatedAt of [1, 2]) {
        await ctx.db.insert("dailyMetrics", {
          day: "2026-08-17", jurisdictionCode: "GH", totalQuestions: 1,
          successCount: 1, failureCount: 0, abortedCount: 0,
          providerFailureCount: 0, noResultCount: 0, latencyLe250: 1,
          latencyLe500: 0, latencyLe1000: 0, latencyLe2500: 0,
          latencyLe5000: 0, latencyGt5000: 0, p50UpperBoundMs: 250,
          p95UpperBoundMs: 250, updatedAt,
        });
      }
    });
    for (const dryRun of [true, false]) {
      const args = {
        environment: "test", target: "dailyMetrics" as const, batchSize: 1, dryRun,
        confirmation: `UNIFIED_JURISDICTIONS BACKFILL test dailyMetrics ${dryRun ? "DRY_RUN" : "EXECUTE"}`,
        reason: "Reject duplicate daily aggregate candidates",
      };
      const first = await t.mutation(backfillJurisdictionReferences, {
        ...args, cursor: null, idempotencyKey: `daily-cross-page-${dryRun}-1`,
      });
      const second = await t.mutation(backfillJurisdictionReferences, {
        ...args, cursor: first.continueCursor,
        idempotencyKey: `daily-cross-page-${dryRun}-2`,
      });
      expect([first, second]).toMatchObject([
        { processed: 1, updated: 0, mismatches: 1 },
        { processed: 1, updated: 0, mismatches: 1 },
      ]);
    }
  });

  it("keeps dry-run source rows unchanged and makes page replay audit-idempotent", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.run(async (ctx) => {
      for (const externalId of ["dry-one", "dry-two"]) {
        await ctx.db.insert("chatSessions", {
          userId: "dry-run-owner",
          externalId,
          title: "Legacy chat",
          lastMessage: "Question",
          messageCount: 1,
          updatedAt: 1,
          country: "GH",
        });
      }
    });
    const args = {
      environment: "test",
      target: "chatSessions" as const,
      cursor: null,
      batchSize: 1,
      dryRun: true,
      confirmation:
        "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Inspect stable jurisdiction references",
      idempotencyKey: "dry-run-replay-1",
    };
    const first = await t.mutation(backfillJurisdictionReferences, args);
    const replay = await t.mutation(backfillJurisdictionReferences, args);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ updated: 1, isDone: false });
    await expect(
      t.run(async (ctx) => ({
        rows: await ctx.db.query("chatSessions").take(3),
        audits: await ctx.db
          .query("auditEvents")
          .withIndex("by_action_and_createdAt", (q) =>
            q.eq("action", "migration.jurisdiction_references_dry_run_page"),
          )
          .take(3),
      })),
    ).resolves.toMatchObject({
      rows: [
        expect.not.objectContaining({ jurisdictionId: expect.any(String) }),
        expect.not.objectContaining({ jurisdictionId: expect.any(String) }),
      ],
      audits: [expect.any(Object)],
    });
    await t.mutation(backfillJurisdictionReferences, {
      ...args,
      cursor: first.continueCursor,
      idempotencyKey: "dry-run-replay-2",
    });
    await expect(
      t.mutation(backfillJurisdictionReferences, {
        ...args,
        cursor: first.continueCursor,
        idempotencyKey: "dry-run-stale-3",
      }),
    ).rejects.toThrow("JURISDICTION_MIGRATION_CURSOR_STALE");
  });

  it("rejects continuation-token target and mode substitution", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.run(async (ctx) => {
      for (const externalId of ["token-one", "token-two"]) {
        await ctx.db.insert("chatSessions", {
          userId: "token-owner", externalId, title: "Legacy chat",
          lastMessage: "Question", messageCount: 1, updatedAt: 1, country: "GH",
        });
      }
    });
    const first = await t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "chatSessions", cursor: null, batchSize: 1,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Inspect stable jurisdiction references", idempotencyKey: "tuple-page-one",
    });
    for (const attempt of [
      { target: "queryRuns" as const, dryRun: true,
        confirmation: "UNIFIED_JURISDICTIONS BACKFILL test queryRuns DRY_RUN" },
      { target: "chatSessions" as const, dryRun: false,
        confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions EXECUTE" },
    ]) {
      await expect(t.mutation(backfillJurisdictionReferences, {
        environment: "test", ...attempt, cursor: first.continueCursor,
        batchSize: 1, reason: "Inspect stable jurisdiction references",
        idempotencyKey: `tuple-substitution-${attempt.target}-${attempt.dryRun}`,
      })).rejects.toThrow("JURISDICTION_MIGRATION_CURSOR_STALE");
    }
  });

  it("serializes concurrent continuation replay and conflicting keys", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    await t.run(async (ctx) => {
      for (const externalId of ["concurrent-one", "concurrent-two", "concurrent-three"]) {
        await ctx.db.insert("chatSessions", {
          userId: "concurrent-owner", externalId, title: "Legacy chat",
          lastMessage: "Question", messageCount: 1, updatedAt: 1, country: "GH",
        });
      }
    });
    const base = {
      environment: "test", target: "chatSessions" as const, batchSize: 1,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Inspect stable jurisdiction references",
    };
    const first = await t.mutation(backfillJurisdictionReferences, {
      ...base, cursor: null, idempotencyKey: "concurrent-page-one",
    });
    const sameArgs = { ...base, cursor: first.continueCursor,
      idempotencyKey: "concurrent-page-two" };
    const same = await Promise.all([
      t.mutation(backfillJurisdictionReferences, sameArgs),
      t.mutation(backfillJurisdictionReferences, sameArgs),
    ]);
    expect(same[1]).toEqual(same[0]);
    const conflicts = await Promise.allSettled([
      t.mutation(backfillJurisdictionReferences, { ...base,
        cursor: same[0].continueCursor, idempotencyKey: "concurrent-page-three-a" }),
      t.mutation(backfillJurisdictionReferences, { ...base,
        cursor: same[0].continueCursor, idempotencyKey: "concurrent-page-three-b" }),
    ]);
    expect(conflicts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(conflicts.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("classifies legacy, unified, unresolved, and mismatched contract rows once", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-contract-classification",
    });
    await t.run(async (ctx) => {
      const base = { userId: "contract-owner", title: "Chat", lastMessage: "Question",
        messageCount: 1, updatedAt: 1 };
      await ctx.db.insert("chatSessions", { ...base, externalId: "clean", country: "GH",
        jurisdictionId, jurisdictionName: "Historical Ghana",
        jurisdictionKind: "geographic", jurisdictionContract: "legacy" });
      await ctx.db.insert("chatSessions", { ...base, externalId: "update", country: "GH" });
      await ctx.db.insert("chatSessions", { ...base, externalId: "unresolved" });
      await ctx.db.insert("chatSessions", { ...base, externalId: "mismatch", country: "GH",
        jurisdictionContract: "unified" });
      await ctx.db.insert("telemetryCorrelations", {
        tokenHash: "contract-mismatch", ownerBinding: "owner", sessionBinding: "session",
        jurisdictionId, jurisdictionContract: "legacy", status: "issued",
        issuedAt: 1, expiresAt: 2,
      });
    });
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "chatSessions", cursor: null, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Classify contract integrity", idempotencyKey: "contract-chat-classify",
    })).resolves.toMatchObject({ processed: 4, updated: 1, unresolved: 1, mismatches: 1 });
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "telemetryCorrelations", cursor: null, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test telemetryCorrelations DRY_RUN",
      reason: "Classify contract integrity", idempotencyKey: "contract-telemetry-classify",
    })).resolves.toMatchObject({ processed: 1, updated: 0, unresolved: 0, mismatches: 1 });
  });

  it("patches identity snapshots in every persisted target without changing payload fields", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-all-targets",
    });
    const ids = await t.run(async (ctx) => ({
      correlation: await ctx.db.insert("telemetryCorrelations", {
        tokenHash: "opaque-correlation",
        ownerBinding: "opaque-owner",
        sessionBinding: "opaque-session",
        jurisdictionCode: "GH",
        status: "issued",
        issuedAt: 10,
        expiresAt: 20,
      }),
      run: await ctx.db.insert("queryRuns", {
        correlationId: "opaque-run",
        day: "2026-08-15",
        jurisdictionCode: "GH",
        outcome: "success",
        searchProviderStatus: "success",
        generationProviderStatus: "success",
        searchLatencyMs: 10,
        generationLatencyMs: 20,
        totalLatencyMs: 30,
        resultCount: 2,
        completedAt: 40,
        rollupStatus: "processed",
      }),
      metric: await ctx.db.insert("dailyMetrics", {
        day: "2026-08-15",
        jurisdictionCode: "GH",
        totalQuestions: 9,
        successCount: 7,
        failureCount: 1,
        abortedCount: 1,
        providerFailureCount: 1,
        noResultCount: 2,
        latencyLe250: 1,
        latencyLe500: 2,
        latencyLe1000: 3,
        latencyLe2500: 1,
        latencyLe5000: 1,
        latencyGt5000: 1,
        p50UpperBoundMs: 1_000,
        p95UpperBoundMs: 6_000,
        updatedAt: 50,
      }),
    }));
    for (const target of [
      "telemetryCorrelations",
      "queryRuns",
      "dailyMetrics",
    ] as const) {
      await t.mutation(backfillJurisdictionReferences, {
        environment: "test",
        target,
        cursor: null,
        batchSize: 100,
        dryRun: false,
        confirmation: `UNIFIED_JURISDICTIONS BACKFILL test ${target} EXECUTE`,
        reason: "Backfill stable jurisdiction references",
        idempotencyKey: `all-targets-${target}`,
      });
    }
    await expect(
      t.run(async (ctx) => ({
        correlation: await ctx.db.get("telemetryCorrelations", ids.correlation),
        run: await ctx.db.get("queryRuns", ids.run),
        metric: await ctx.db.get("dailyMetrics", ids.metric),
      })),
    ).resolves.toMatchObject({
      correlation: {
        jurisdictionId,
        jurisdictionName: "Republic of Ghana",
        jurisdictionKind: "geographic",
        jurisdictionContract: "legacy",
        tokenHash: "opaque-correlation",
      },
      run: {
        jurisdictionId,
        jurisdictionName: "Republic of Ghana",
        jurisdictionKind: "geographic",
        resultCount: 2,
        totalLatencyMs: 30,
      },
      metric: {
        jurisdictionId,
        jurisdictionName: "Republic of Ghana",
        jurisdictionKind: "geographic",
        totalQuestions: 9,
        successCount: 7,
      },
    });
  });
});
