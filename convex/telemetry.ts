import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import { components } from "./_generated/api";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import {
  createOpaqueTelemetryToken,
  createTelemetryPrincipalBinding,
  hashOpaqueTelemetryValue,
  isOpaqueTelemetryToken,
  verifyTelemetryServiceProof,
} from "./lib/telemetryProof";

const CORRELATION_TTL_MS = 5 * 60_000;
const CHAT_LEASE_MS = 2 * 60_000;
const MAX_PROVIDER_LATENCY_MS = 10 * 60_000;
const MAX_RESULT_COUNT = 10_000;
const ROLLUP_BATCH = 500;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LATENCY_THRESHOLDS = [
  250, 500, 1_000, 2_500, 5_000, 6_000,
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;
const finalizeExpiredCorrelationRef = makeFunctionReference<"mutation">("telemetry:finalizeExpiredCorrelation");
const rollupDailyMetricsRef = makeFunctionReference<"mutation">("telemetry:rollupDailyMetrics");

const providerStatus = v.union(
  v.literal("success"),
  v.literal("no_result"),
  v.literal("failure"),
);
const generationStatus = v.union(v.literal("success"), v.literal("failure"));
const phaseReturn = v.object({ status: v.union(v.literal("search_complete"), v.literal("finalized")), correlationId: v.string() });
const terminalReturn = v.object({ status: v.literal("finalized"), correlationId: v.string() });

function validateLatency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PROVIDER_LATENCY_MS) {
    throw new ConvexError("TELEMETRY_LATENCY_INVALID");
  }
  return value;
}

function validateResultCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RESULT_COUNT) {
    throw new ConvexError("TELEMETRY_RESULT_COUNT_INVALID");
  }
  return value;
}

function normalizeJurisdiction(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
  }
  return normalized;
}

async function requireServiceProof(
  proof: string,
  parts: readonly (string | number)[],
) {
  if (!(await verifyTelemetryServiceProof(proof, parts))) {
    throw new ConvexError("TELEMETRY_SERVICE_PROOF_INVALID");
  }
}

async function requireOwner(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") {
    throw new ConvexError("TELEMETRY_AUTH_REQUIRED");
  }
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [{ field: "_id", operator: "eq", value: identity.sessionId }],
  });
  if (!session || session.userId !== identity.subject) {
    throw new ConvexError("TELEMETRY_AUTH_REQUIRED");
  }
  return {
    ownerBinding: await createTelemetryPrincipalBinding("owner", identity.tokenIdentifier),
    sessionBinding: await createTelemetryPrincipalBinding("session", identity.sessionId),
  };
}

async function correlationByToken(ctx: MutationCtx, token: string) {
  if (!isOpaqueTelemetryToken(token)) {
    throw new ConvexError("TELEMETRY_CORRELATION_INVALID");
  }
  const tokenHash = await hashOpaqueTelemetryValue(token);
  const rows = await ctx.db
    .query("telemetryCorrelations")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .take(2);
  if (rows.length !== 1) {
    throw new ConvexError("TELEMETRY_CORRELATION_INVALID");
  }
  return rows[0];
}

function requireCorrelationOwner(
  row: Doc<"telemetryCorrelations">,
  owner: { ownerBinding: string; sessionBinding: string },
) {
  if (row.ownerBinding !== owner.ownerBinding || row.sessionBinding !== owner.sessionBinding) {
    throw new ConvexError("TELEMETRY_CORRELATION_FORBIDDEN");
  }
}

async function recordTerminal(
  ctx: MutationCtx,
  row: Doc<"telemetryCorrelations">,
  input: {
    outcome: "success" | "failure" | "aborted";
    generationProviderStatus: "success" | "failure" | "skipped";
    generationLatencyMs: number;
  },
) {
  const existing = await ctx.db
    .query("queryRuns")
    .withIndex("by_correlationId", (q) => q.eq("correlationId", row.tokenHash))
    .take(2);
  if (existing.length > 0) return existing[0];

  const completedAt = Date.now();
  const searchLatencyMs = row.searchLatencyMs ?? 0;
  const resultCount = row.resultCount ?? 0;
  const searchProviderStatus = row.searchProviderStatus ?? "skipped";
  const id = await ctx.db.insert("queryRuns", {
    correlationId: row.tokenHash,
    day: new Date(completedAt).toISOString().slice(0, 10),
    jurisdictionCode: row.jurisdictionCode,
    outcome: input.outcome,
    searchProviderStatus,
    generationProviderStatus: input.generationProviderStatus,
    searchLatencyMs,
    generationLatencyMs: input.generationLatencyMs,
    totalLatencyMs: Math.min(
      MAX_PROVIDER_LATENCY_MS,
      searchLatencyMs + input.generationLatencyMs,
    ),
    resultCount,
    completedAt,
    rollupStatus: "pending",
  });
  await ctx.db.patch(row._id, { status: "finalized" });
  return (await ctx.db.get(id))!;
}

export const issueCorrelation = mutation({
  args: { token: v.string(), jurisdictionCode: v.string(), serviceProof: v.string() },
  returns: v.object({ status: v.literal("issued"), correlationId: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    if (!isOpaqueTelemetryToken(args.token)) {
      throw new ConvexError("TELEMETRY_CORRELATION_INVALID");
    }
    const jurisdictionCode = normalizeJurisdiction(args.jurisdictionCode);
    await requireServiceProof(args.serviceProof, ["issue", args.token, jurisdictionCode]);
    const owner = await requireOwner(ctx);
    const jurisdictions = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", jurisdictionCode))
      .take(2);
    if (jurisdictions.length !== 1 || jurisdictions[0].status !== "enabled") {
      throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
    }
    const tokenHash = await hashOpaqueTelemetryValue(args.token);
    const prior = await ctx.db
      .query("telemetryCorrelations")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .take(1);
    if (prior.length > 0) throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CORRELATION_TTL_MS;
    await ctx.db.insert("telemetryCorrelations", {
      tokenHash,
      ...owner,
      jurisdictionCode,
      status: "issued",
      issuedAt,
      expiresAt,
    });
    await ctx.scheduler.runAt(expiresAt, finalizeExpiredCorrelationRef, { tokenHash });
    return { status: "issued" as const, correlationId: tokenHash, expiresAt };
  },
});

export const recordSearchPhase = mutation({
  args: { token: v.string(), providerStatus, latencyMs: v.number(), resultCount: v.number(), serviceProof: v.string() },
  returns: phaseReturn,
  handler: async (ctx, args) => {
    const latencyMs = validateLatency(args.latencyMs);
    const resultCount = validateResultCount(args.resultCount);
    await requireServiceProof(args.serviceProof, ["search", args.token, args.providerStatus, latencyMs, resultCount]);
    const owner = await requireOwner(ctx);
    const row = await correlationByToken(ctx, args.token);
    requireCorrelationOwner(row, owner);
    if (row.status !== "issued") throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    if (Date.now() >= row.expiresAt) throw new ConvexError("TELEMETRY_CORRELATION_EXPIRED");
    await ctx.db.patch(row._id, {
      status: args.providerStatus === "failure" ? "finalized" : "search_complete",
      searchProviderStatus: args.providerStatus,
      searchLatencyMs: latencyMs,
      resultCount,
    });
    const updated = (await ctx.db.get(row._id))!;
    if (args.providerStatus === "failure") {
      await recordTerminal(ctx, updated, { outcome: "failure", generationProviderStatus: "skipped", generationLatencyMs: 0 });
      return { status: "finalized" as const, correlationId: row.tokenHash };
    }
    return { status: "search_complete" as const, correlationId: row.tokenHash };
  },
});

export const claimChatPhase = mutation({
  args: { token: v.string(), jurisdictionCode: v.string(), serviceProof: v.string() },
  returns: v.object({ status: v.literal("chat_claimed"), correlationId: v.string(), claimNonce: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const jurisdictionCode = normalizeJurisdiction(args.jurisdictionCode);
    await requireServiceProof(args.serviceProof, ["claim", args.token, jurisdictionCode]);
    const owner = await requireOwner(ctx);
    const row = await correlationByToken(ctx, args.token);
    requireCorrelationOwner(row, owner);
    if (row.jurisdictionCode !== jurisdictionCode) throw new ConvexError("TELEMETRY_JURISDICTION_MISMATCH");
    if (row.status !== "search_complete") throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    if (Date.now() >= row.expiresAt) throw new ConvexError("TELEMETRY_CORRELATION_EXPIRED");
    const claimNonce = createOpaqueTelemetryToken();
    const expiresAt = Date.now() + CHAT_LEASE_MS;
    await ctx.db.patch(row._id, { status: "chat_claimed", claimNonceHash: await hashOpaqueTelemetryValue(claimNonce), expiresAt });
    await ctx.scheduler.runAt(expiresAt, finalizeExpiredCorrelationRef, { tokenHash: row.tokenHash });
    return { status: "chat_claimed" as const, correlationId: row.tokenHash, claimNonce, expiresAt };
  },
});

export const finalizeChatPhase = mutation({
  args: { token: v.string(), claimNonce: v.string(), providerStatus: generationStatus, latencyMs: v.number(), serviceProof: v.string() },
  returns: terminalReturn,
  handler: async (ctx, args) => {
    const latencyMs = validateLatency(args.latencyMs);
    await requireServiceProof(args.serviceProof, ["finalize", args.token, args.claimNonce, args.providerStatus, latencyMs]);
    const owner = await requireOwner(ctx);
    const row = await correlationByToken(ctx, args.token);
    requireCorrelationOwner(row, owner);
    if (!isOpaqueTelemetryToken(args.claimNonce) || await hashOpaqueTelemetryValue(args.claimNonce) !== row.claimNonceHash) {
      throw new ConvexError("TELEMETRY_CLAIM_INVALID");
    }
    if (row.status === "finalized") {
      const existing = await ctx.db.query("queryRuns").withIndex("by_correlationId", (q) => q.eq("correlationId", row.tokenHash)).take(2);
      if (existing.length === 1 && existing[0].outcome === "aborted" && Date.now() >= row.expiresAt) {
        throw new ConvexError("TELEMETRY_CORRELATION_EXPIRED");
      }
      if (
        existing.length === 1 &&
        existing[0].generationProviderStatus === args.providerStatus &&
        existing[0].generationLatencyMs === latencyMs &&
        existing[0].outcome === (args.providerStatus === "success" ? "success" : "failure")
      ) {
        return { status: "finalized" as const, correlationId: row.tokenHash };
      }
      throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    }
    if (row.status !== "chat_claimed") throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    if (Date.now() >= row.expiresAt) throw new ConvexError("TELEMETRY_CORRELATION_EXPIRED");
    await recordTerminal(ctx, row, {
      outcome: args.providerStatus === "success" ? "success" : "failure",
      generationProviderStatus: args.providerStatus,
      generationLatencyMs: latencyMs,
    });
    return { status: "finalized" as const, correlationId: row.tokenHash };
  },
});

export const finalizeExpiredCorrelation = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.object({ finalized: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("telemetryCorrelations").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).take(2);
    if (rows.length !== 1 || rows[0].status === "finalized") return { finalized: false };
    if (Date.now() < rows[0].expiresAt) {
      await ctx.scheduler.runAt(rows[0].expiresAt, finalizeExpiredCorrelationRef, { tokenHash: args.tokenHash });
      return { finalized: false };
    }
    await recordTerminal(ctx, rows[0], { outcome: "aborted", generationProviderStatus: "skipped", generationLatencyMs: 0 });
    return { finalized: true };
  },
});

function bucketFor(latencyMs: number): number {
  const index = LATENCY_THRESHOLDS.findIndex((threshold) => latencyMs <= threshold);
  return index < 0 ? LATENCY_THRESHOLDS.length - 1 : index;
}

function percentile(histogram: readonly number[], total: number, fraction: number): number {
  if (total === 0) return 0;
  const target = Math.ceil(total * fraction);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= target) return LATENCY_THRESHOLDS[index] ?? MAX_PROVIDER_LATENCY_MS;
  }
  return MAX_PROVIDER_LATENCY_MS;
}

function histogramFromMetric(metric: Doc<"dailyMetrics"> | null): number[] {
  if (metric?.latencyHistogram?.length === LATENCY_THRESHOLDS.length) return [...metric.latencyHistogram];
  if (!metric) return Array.from({ length: LATENCY_THRESHOLDS.length }, () => 0);
  return [
    metric.latencyLe250,
    metric.latencyLe500 - metric.latencyLe250,
    metric.latencyLe1000 - metric.latencyLe500,
    metric.latencyLe2500 - metric.latencyLe1000,
    metric.latencyLe5000 - metric.latencyLe2500,
    metric.latencyGt5000,
    ...Array.from({ length: LATENCY_THRESHOLDS.length - 6 }, () => 0),
  ];
}

export const rollupDailyMetrics = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ processed: v.number(), done: v.boolean(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, _args) => {
    const rows = await ctx.db.query("queryRuns").withIndex("by_rollupStatus_and_completedAt", (q) => q.eq("rollupStatus", "pending")).take(ROLLUP_BATCH);
    const groups = new Map<string, Doc<"queryRuns">[]>();
    for (const row of rows) {
      if (!DAY_PATTERN.test(row.day)) throw new ConvexError("TELEMETRY_DAY_INVALID");
      const key = `${row.day}:${row.jurisdictionCode}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const now = Date.now();
    for (const group of groups.values()) {
      const { day, jurisdictionCode } = group[0];
      const existingRows = await ctx.db.query("dailyMetrics").withIndex("by_day_and_jurisdictionCode", (q) => q.eq("day", day).eq("jurisdictionCode", jurisdictionCode)).take(2);
      if (existingRows.length > 1) throw new ConvexError("DUPLICATE_DAILY_METRIC");
      const existing = existingRows[0] ?? null;
      const histogram = histogramFromMetric(existing);
      for (const row of group) histogram[bucketFor(row.totalLatencyMs)] += 1;
      const totalQuestions = (existing?.totalQuestions ?? 0) + group.length;
      const latencyLe250 = histogram[0];
      const latencyLe500 = latencyLe250 + histogram[1];
      const latencyLe1000 = latencyLe500 + histogram[2];
      const latencyLe2500 = latencyLe1000 + histogram[3];
      const latencyLe5000 = latencyLe2500 + histogram[4];
      const latencyGt5000 = totalQuestions - latencyLe5000;
      const value = {
        day,
        jurisdictionCode,
        totalQuestions,
        successCount: (existing?.successCount ?? 0) + group.filter((row) => row.outcome === "success").length,
        failureCount: (existing?.failureCount ?? 0) + group.filter((row) => row.outcome === "failure").length,
        abortedCount: (existing?.abortedCount ?? 0) + group.filter((row) => row.outcome === "aborted").length,
        providerFailureCount: (existing?.providerFailureCount ?? 0) + group.filter((row) => row.searchProviderStatus === "failure" || row.generationProviderStatus === "failure").length,
        noResultCount: (existing?.noResultCount ?? 0) + group.filter((row) => row.searchProviderStatus === "no_result").length,
        latencyLe250,
        latencyLe500,
        latencyLe1000,
        latencyLe2500,
        latencyLe5000,
        latencyGt5000,
        latencyHistogram: histogram,
        p50UpperBoundMs: percentile(histogram, totalQuestions, 0.5),
        p95UpperBoundMs: percentile(histogram, totalQuestions, 0.95),
        updatedAt: now,
      };
      if (existing) await ctx.db.replace(existing._id, value);
      else await ctx.db.insert("dailyMetrics", value);
    }
    for (const row of rows) await ctx.db.patch(row._id, { rollupStatus: "processed", rolledUpAt: now });
    const done = rows.length < ROLLUP_BATCH;
    const cursor = rows.at(-1)?._id ?? null;
    if (!done) await ctx.scheduler.runAfter(0, rollupDailyMetricsRef, { cursor });
    return { processed: rows.length, done, cursor };
  },
});
