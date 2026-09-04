/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const rollupDailyMetrics = makeFunctionReference<"mutation">(
  "telemetry:rollupDailyMetrics",
);

describe("unified interaction telemetry", () => {
  it("rolls up the small terminal record by stable jurisdiction and safe outcome", async () => {
    const t = convexTest(schema, modules);
    const jurisdictionId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("jurisdictions", {
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        isDefault: true,
        providerSyncState: "synced",
        kind: "geographic",
        visibility: "public",
        createdBy: "fixture",
        updatedBy: "fixture",
        createdAt: now,
        updatedAt: now,
      });
      const chatSessionId = await ctx.db.insert("chatSessions", {
        userId: "telemetry-owner",
        externalId: "telemetry-chat",
        title: "Telemetry chat",
        lastMessage: "",
        messageCount: 0,
        updatedAt: now,
        jurisdictionId: id,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        jurisdictionContract: "unified",
      });
      const base = {
        chatSessionId,
        jurisdictionId: id,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic" as const,
        assistantClientIdBinding: "a".repeat(43),
        completionBinding: "b".repeat(43),
        model: "gemini-3.5-flash-lite",
        authorizedScopeSize: 1,
        readyStoreCount: 1,
        citationCount: 0,
        partialCoverage: false,
        jurisdictionCoverage: [{ ordinal: 0, relation: "selected" as const, coverage: "no_evidence" as const }],
        day: "2026-09-03",
        completedAt: Date.parse("2026-09-03T12:00:00.000Z"),
        rollupStatus: "pending" as const,
      };
      await ctx.db.insert("queryRuns", {
        ...base,
        requestNonceHash: "1".repeat(43),
        outcome: "success",
        totalLatencyMs: 100,
      } as never);
      await ctx.db.insert("queryRuns", {
        ...base,
        requestNonceHash: "2".repeat(43),
        assistantClientIdBinding: "c".repeat(43),
        completionBinding: "d".repeat(43),
        outcome: "failure",
        failureCategory: "network",
        totalLatencyMs: 400,
      } as never);
      await ctx.db.insert("queryRuns", {
        ...base,
        requestNonceHash: "3".repeat(43),
        assistantClientIdBinding: "e".repeat(43),
        completionBinding: "f".repeat(43),
        outcome: "aborted",
        totalLatencyMs: 1_100,
      } as never);
      return id;
    });

    await t.mutation(rollupDailyMetrics, { cursor: null });

    const state = await t.run(async (ctx) => ({
      runs: await ctx.db.query("queryRuns").take(10),
      metrics: await ctx.db.query("dailyMetrics").take(10),
    }));
    expect(state.runs.every((row) => row.rollupStatus === "processed")).toBe(true);
    expect(state.metrics).toHaveLength(1);
    expect(state.metrics[0]).toMatchObject({
      day: "2026-09-03",
      jurisdictionId,
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      totalQuestions: 3,
      successCount: 1,
      failureCount: 1,
      abortedCount: 1,
      providerFailureCount: 1,
      p50UpperBoundMs: 500,
      p95UpperBoundMs: 2_500,
    });
    expect(state.metrics[0]).not.toHaveProperty("jurisdictionCode");
    expect(state.metrics[0]).not.toHaveProperty("noResultCount");
  });

  it("is idempotent when there are no pending terminal rows", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(rollupDailyMetrics, { cursor: null })).resolves.toEqual({
      processed: 0,
      done: true,
      cursor: null,
    });
    await expect(t.mutation(rollupDailyMetrics, { cursor: null })).resolves.toEqual({
      processed: 0,
      done: true,
      cursor: null,
    });
  });
});
