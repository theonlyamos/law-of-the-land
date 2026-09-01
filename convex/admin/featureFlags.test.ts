/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { readUnifiedJurisdictionsEnabled } from "./featureFlags";
import schema from "../schema";
import { calculateUnifiedJurisdictionRolloutState } from "../lib/unifiedJurisdictionRollout";

const modules = import.meta.glob("../**/*.ts");
const previousEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

describe("unified jurisdictions feature flag", () => {
  it("fails closed when the unified-jurisdictions flag is absent or duplicated", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("featureFlags", {
        key: "unified_jurisdictions",
        environment: "test",
        enabled: true,
        updatedAt: 1,
      });
      await ctx.db.insert("featureFlags", {
        key: "unified_jurisdictions",
        environment: "test",
        enabled: true,
        updatedAt: 2,
      });
    });

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);
  });

  it("fails closed when the selected unified-jurisdictions flag is disabled", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("featureFlags", {
      key: "unified_jurisdictions",
      environment: "test",
      enabled: false,
      updatedAt: 1,
    }));

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);
  });

  it("returns every readiness blocker in the fixed safety order without scanning targets", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);

    await expect(
      t.run((ctx) =>
        calculateUnifiedJurisdictionRolloutState(ctx, "test", 10_000),
      ),
    ).resolves.toMatchObject({
      canEnable: false,
      blockers: [
        "GHANA_NOT_READY",
        "CHAT_SESSIONS_NOT_VERIFIED",
        "TELEMETRY_CORRELATIONS_NOT_VERIFIED",
        "QUERY_RUNS_NOT_VERIFIED",
        "DAILY_METRICS_NOT_VERIFIED",
      ],
      targets: [
        { target: "chatSessions", status: "missing" },
        { target: "telemetryCorrelations", status: "missing" },
        { target: "queryRuns", status: "missing" },
        { target: "dailyMetrics", status: "missing" },
      ],
    });
  });

  it("measures legacy silence from the later accepted dependency timestamp", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("unifiedJurisdictionRolloutStates", {
        environment: "test",
        migrationVersion: "jurisdiction_ids_v1",
        legacyObservationGeneration: 3,
        legacyObservationStartedAt: 1_000,
        legacyLastAcceptedAt: 4_000,
        legacyAcceptedSinceStart: 2,
        updatedAt: 4_000,
      }),
    );

    await expect(
      t.run((ctx) =>
        calculateUnifiedJurisdictionRolloutState(ctx, "test", 10_000),
      ),
    ).resolves.toMatchObject({
      legacyObservation: {
        active: true,
        generation: 3,
        acceptedSinceStart: 2,
        zeroForMs: 6_000,
      },
    });
  });

  it("fails closed on malformed bounded observation counters", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("unifiedJurisdictionRolloutStates", {
        environment: "test",
        migrationVersion: "jurisdiction_ids_v1",
        legacyObservationGeneration: -1,
        legacyAcceptedSinceStart: -1,
        updatedAt: 1,
      }),
    );

    await expect(
      t.run((ctx) =>
        calculateUnifiedJurisdictionRolloutState(ctx, "test", 10_000),
      ),
    ).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it.each([
    {
      name: "partial Ghana seed bundle",
      state: { ghanaProjectionFingerprint: "a".repeat(64) },
    },
    {
      name: "observation after updated timestamp",
      state: { legacyObservationStartedAt: 2 },
    },
    {
      name: "accepted timestamp before observation",
      state: { legacyObservationStartedAt: 2, legacyLastAcceptedAt: 1 },
    },
  ])("rejects malformed rollout state: $name", async ({ state }) => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("unifiedJurisdictionRolloutStates", {
      environment: "test",
      migrationVersion: "jurisdiction_ids_v1",
      legacyObservationGeneration: 1,
      legacyAcceptedSinceStart: 0,
      updatedAt: 1,
      ...state,
    }));
    await expect(t.run((ctx) =>
      calculateUnifiedJurisdictionRolloutState(ctx, "test", 10),
    )).rejects.toThrow("JURISDICTION_MIGRATION_STATE_INVALID");
  });

  it("reports running, blocked, verified, and missing target readiness states", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const base = {
        environment: "test" as const,
        migrationVersion: "jurisdiction_ids_v1" as const,
        mode: "execute" as const,
        runNumber: 2,
        processed: 1,
        unresolved: 0,
        mismatches: 0,
        startedAt: 1,
        lastIdempotencyKey: "readiness-state-key",
        lastRequestFingerprint: "a".repeat(64),
        updatedAt: 2,
      };
      await ctx.db.insert("jurisdictionMigrationCheckpoints", {
        ...base,
        target: "chatSessions",
        status: "running",
        databaseCursor: "opaque-db-cursor",
        continuationToken: `ujm1_${"1".repeat(32)}`,
        updated: 0,
        lastResult: { processed: 1, updated: 0, unresolved: 0, mismatches: 0,
          continueCursor: `ujm1_${"1".repeat(32)}`, isDone: false },
      });
      await ctx.db.insert("jurisdictionMigrationCheckpoints", {
        ...base,
        target: "telemetryCorrelations",
        status: "completed",
        updated: 1,
        completedAt: 2,
        lastResult: { processed: 1, updated: 1, unresolved: 0, mismatches: 0,
          continueCursor: null, isDone: true },
      });
      await ctx.db.insert("jurisdictionMigrationCheckpoints", {
        ...base,
        target: "queryRuns",
        status: "completed",
        updated: 0,
        completedAt: 2,
        verifiedAt: 2,
        lastResult: { processed: 1, updated: 0, unresolved: 0, mismatches: 0,
          continueCursor: null, isDone: true },
      });
    });
    await expect(t.run((ctx) =>
      calculateUnifiedJurisdictionRolloutState(ctx, "test", 10),
    )).resolves.toMatchObject({
      targets: [
        { target: "chatSessions", status: "running" },
        { target: "telemetryCorrelations", status: "blocked" },
        { target: "queryRuns", status: "verified" },
        { target: "dailyMetrics", status: "missing" },
      ],
    });
  });
});
