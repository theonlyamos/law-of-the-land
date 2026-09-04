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
      status: "draft",
      isDefault: true,
      providerSyncState: "pending",
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

async function enableGhanaSearch(
  t: ReturnType<typeof convexTest>,
  jurisdictionId: Awaited<ReturnType<typeof insertGhana>>["jurisdictionId"],
) {
  await t.run((ctx) =>
    ctx.db.patch("jurisdictions", jurisdictionId, {
      status: "enabled",
      providerSyncState: "synced",
      geminiFileSearchStoreName: "fileSearchStores/ghana-migration",
      geminiEmbeddingModel: "models/gemini-embedding-2",
    }),
  );
}

describe("safe unified-jurisdiction migration", () => {
  it("adds Ghana V2 typing without replacing the draft jurisdiction or catalog resource", async () => {
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
      status: "draft",
      providerSyncState: "pending",
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

  it("projects a legacy stored Ghana seed result during idempotent replay", async () => {
    const t = convexTest(schema, modules);
    await insertGhana(t);
    const args = {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-seed-legacy-result-replay",
    };
    const first = await t.mutation(seedGhanaJurisdictionV2, args);
    await t.run(async (ctx) => {
      const rollout = await ctx.db
        .query("unifiedJurisdictionRolloutStates")
        .withIndex("by_environment_and_migrationVersion", (q) =>
          q.eq("environment", "test").eq("migrationVersion", "jurisdiction_ids_v1"),
        )
        .unique();
      if (!rollout?.ghanaSeedLastResult) throw new Error("missing rollout fixture");
      await ctx.db.patch(rollout._id, {
        ghanaSeedLastResult: {
          ...rollout.ghanaSeedLastResult,
          preservedProductionBucket: "11833",
        },
      });
    });

    await expect(t.mutation(seedGhanaJurisdictionV2, args)).resolves.toEqual(first);
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
      })).resolves.toMatchObject({ changed: true });
    },
  );

  it("rejects duplicate Ghana rows and a Place ID owned by another jurisdiction", async () => {
    const duplicate = convexTest(schema, modules);
    await insertGhana(duplicate);
    await duplicate.run((ctx) => ctx.db.insert("jurisdictions", {
      code: "GH", name: "Duplicate Ghana", slug: "ghana-duplicate",
      status: "draft", isDefault: false,
      providerSyncState: "pending", createdBy: "fixture", updatedBy: "fixture",
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
    await enableGhanaSearch(t, jurisdictionId);
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
        target: "chatSessions",
        cursor: null,
        batchSize,
        dryRun: true,
        confirmation:
          "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
        reason: "Inspect stable jurisdiction references",
        idempotencyKey: "metrics-dry-run-1",
      }),
    ).rejects.toThrow("JURISDICTION_MIGRATION_BATCH_SIZE_INVALID");
  });

  it("requires two completed execute passes even when the target begins clean", async () => {
    const t = convexTest(schema, modules);
    const args = {
      environment: "test",
      target: "chatSessions" as const,
      cursor: null,
      batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions EXECUTE",
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
                .eq("target", "chatSessions")
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
                .eq("target", "chatSessions")
                .eq("mode", "execute"),
          )
          .unique();
        return row?.verifiedAt;
      }),
    ).resolves.toEqual(expect.any(Number));
  });

  it("fails Ghana readiness when the persisted profile drifts from the seeded projection", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test",
      place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-readiness-drift",
    });
    await enableGhanaSearch(t, jurisdictionId);
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

  it("rejects malformed checkpoint counters before idempotency replay", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("jurisdictionMigrationCheckpoints", {
        environment: "test",
        migrationVersion: "jurisdiction_ids_v1",
        target: "chatSessions",
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
        target: "chatSessions",
        cursor: null,
        batchSize: 100,
        dryRun: true,
        confirmation:
          "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
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
      target: "chatSessions", mode: "execute", runNumber: 1,
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
      environment: "test", target: "chatSessions", cursor: null, batchSize: 100,
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions EXECUTE",
      reason: "Verify stable jurisdiction references",
      idempotencyKey: "malformed-new-request",
    })).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it("maps a corrupt stored database cursor to the fixed state-invalid error", async () => {
    const t = convexTest(schema, modules);
    const token = `ujm1_${"1".repeat(32)}`;
    await t.run((ctx) => ctx.db.insert("jurisdictionMigrationCheckpoints", {
      environment: "test", migrationVersion: "jurisdiction_ids_v1",
      target: "chatSessions", mode: "dry_run", runNumber: 1,
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
      environment: "test", target: "chatSessions", cursor: token, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Inspect stable jurisdiction references",
      idempotencyKey: "cursor-corrupt-page-2",
    })).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it("keeps dry-run source rows unchanged and makes page replay audit-idempotent", async () => {
    const t = convexTest(schema, modules);
    const { jurisdictionId } = await insertGhana(t);
    await t.mutation(seedGhanaJurisdictionV2, {
      environment: "test", place,
      confirmation: "SEED_GHANA_JURISDICTION_V2 test",
      reason: "Adopt the reviewed Ghana country projection",
      idempotencyKey: "ghana-dry-run-replay",
    });
    await enableGhanaSearch(t, jurisdictionId);
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

  it("rejects continuation-token mode substitution", async () => {
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
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "chatSessions",
      dryRun: false,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions EXECUTE",
      cursor: first.continueCursor,
      batchSize: 1, reason: "Inspect stable jurisdiction references",
      idempotencyKey: "tuple-mode-substitution",
    })).rejects.toThrow("JURISDICTION_MIGRATION_CURSOR_STALE");
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
    await enableGhanaSearch(t, jurisdictionId);
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
    });
    await expect(t.mutation(backfillJurisdictionReferences, {
      environment: "test", target: "chatSessions", cursor: null, batchSize: 100,
      dryRun: true,
      confirmation: "UNIFIED_JURISDICTIONS BACKFILL test chatSessions DRY_RUN",
      reason: "Classify contract integrity", idempotencyKey: "contract-chat-classify",
    })).resolves.toMatchObject({ processed: 4, updated: 1, unresolved: 1, mismatches: 1 });
  });
});
