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
import { isLegacyCountryCode } from "./lib/jurisdictionDomain";
import { assertJurisdictionAccess } from "./lib/jurisdictionAccess";
import {
  effectiveJurisdictionContract,
  hasCoherentJurisdictionContractIdentity,
  resolveLegacyJurisdictionSnapshot,
} from "./lib/legacyJurisdictionCompatibility";
import { readUnifiedJurisdictionsEnabled } from "./admin/featureFlags";
import {
  readMigrationEnvironment,
  recordLegacyJurisdictionDependency,
} from "./lib/unifiedJurisdictionRollout";

const CORRELATION_TTL_MS = 5 * 60_000;
const CHAT_LEASE_MS = 2 * 60_000;
const MAX_PROVIDER_LATENCY_MS = 10 * 60_000;
const MAX_RESULT_COUNT = 10_000;
const MAX_SCOPE_SIZE = 9;
const MAX_PLAN_SIZE = 4;
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
const jurisdictionCoverage = v.array(v.object({
  ordinal: v.number(),
  relation: v.union(v.literal("selected"), v.literal("geographic_ancestor"), v.literal("organizational_geography")),
  coverage: v.union(v.literal("evidence"), v.literal("no_evidence"), v.literal("unavailable")),
}));
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

function normalizeLegacySnapshot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeJurisdiction(value);
}

function validateDigest(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ConvexError("TELEMETRY_CONTEXT_INVALID");
  }
  return value;
}

function boundedCount(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ConvexError("TELEMETRY_COUNT_INVALID");
  }
  return value;
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
  if (!hasCoherentJurisdictionContractIdentity(rows[0])) {
    throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
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
  if (!hasCoherentJurisdictionContractIdentity(row)) {
    throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
  }
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
    ...(row.jurisdictionCode ? { jurisdictionCode: row.jurisdictionCode } : {}),
    ...(row.jurisdictionId ? { jurisdictionId: row.jurisdictionId } : {}),
    ...(row.jurisdictionName ? { jurisdictionName: row.jurisdictionName } : {}),
    ...(row.jurisdictionKind ? { jurisdictionKind: row.jurisdictionKind } : {}),
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
    ...(row.scopeSize !== undefined ? { scopeSize: row.scopeSize } : {}),
    ...(row.retrievalPlanSize !== undefined ? { retrievalPlanSize: row.retrievalPlanSize } : {}),
    ...(row.providerCallCount !== undefined ? { providerCallCount: row.providerCallCount } : {}),
    ...(row.fileSearchCallCount !== undefined ? { fileSearchCallCount: row.fileSearchCallCount } : {}),
    ...(row.fileSearchStoreCount !== undefined ? { fileSearchStoreCount: row.fileSearchStoreCount } : {}),
    ...(row.fileSearchLatencyMs !== undefined ? { fileSearchLatencyMs: row.fileSearchLatencyMs } : {}),
    ...(row.evidenceBytes !== undefined ? { evidenceBytes: row.evidenceBytes } : {}),
    ...(row.citationCount !== undefined ? { citationCount: row.citationCount } : {}),
    ...(row.jurisdictionCoverage !== undefined ? { jurisdictionCoverage: row.jurisdictionCoverage } : {}),
    ...(row.plannerStatus ? { plannerStatus: row.plannerStatus } : {}),
    ...(row.plannerLatencyMs !== undefined ? { plannerLatencyMs: row.plannerLatencyMs } : {}),
    ...(row.contextDigest ? { contextDigest: row.contextDigest } : {}),
    ...(row.partialCoverage !== undefined ? { partialCoverage: row.partialCoverage } : {}),
    ...(row.configurationUnavailableCount !== undefined
      ? { configurationUnavailableCount: row.configurationUnavailableCount }
      : {}),
    ...(row.supplementaryProviderFailureCount !== undefined
      ? { supplementaryProviderFailureCount: row.supplementaryProviderFailureCount }
      : {}),
    completedAt,
    rollupStatus: "pending",
  });
  await ctx.db.patch(row._id, { status: "finalized" });
  return (await ctx.db.get(id))!;
}

export const issueCorrelation = mutation({
  args: {
    token: v.string(),
    jurisdictionCode: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    legacyCountryCode: v.optional(v.string()),
    legacyResolutionUsed: v.boolean(),
    serviceProof: v.string(),
  },
  returns: v.object({ status: v.literal("issued"), correlationId: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    if (!isOpaqueTelemetryToken(args.token)) {
      throw new ConvexError("TELEMETRY_CORRELATION_INVALID");
    }
    const unified = args.jurisdictionId !== undefined;
    if (unified === (args.jurisdictionCode !== undefined)) {
      throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
    }
    const legacyCountryCode = normalizeLegacySnapshot(args.legacyCountryCode);
    const jurisdictionCode = args.jurisdictionCode === undefined
      ? undefined
      : normalizeJurisdiction(args.jurisdictionCode);
    await requireServiceProof(
      args.serviceProof,
      unified
        ? ["issue-jurisdiction-v1", args.token, args.jurisdictionId!,
            legacyCountryCode ?? "", args.legacyResolutionUsed ? 1 : 0]
        : ["issue", args.token, jurisdictionCode!, args.legacyResolutionUsed ? 1 : 0],
    );
    if (args.legacyResolutionUsed && (!unified || legacyCountryCode === undefined)) {
      throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
    }
    const owner = await requireOwner(ctx);
    let jurisdictionId = args.jurisdictionId;
    let jurisdictionName: string | undefined;
    let jurisdictionKind: "geographic" | "organizational" | undefined;
    let jurisdictionContract: "legacy" | "unified";
    if (unified) {
      const selected = await ctx.db.get("jurisdictions", args.jurisdictionId!);
      if (!selected || selected.status !== "enabled" ||
        (selected.kind !== "geographic" && selected.kind !== "organizational")) {
        throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      }
      try {
        await assertJurisdictionAccess(ctx, selected);
      } catch {
        throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      }
      const storedLegacy = isLegacyCountryCode(selected.legacyCountryCode)
        ? selected.legacyCountryCode
        : undefined;
      if (legacyCountryCode !== storedLegacy) {
        throw new ConvexError("TELEMETRY_JURISDICTION_MISMATCH");
      }
      jurisdictionName = selected.name;
      jurisdictionKind = selected.kind;
      jurisdictionContract = "unified";
    } else {
      if (legacyCountryCode !== undefined) throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      const resolved = await resolveLegacyJurisdictionSnapshot(ctx, jurisdictionCode!);
      if (!resolved) throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      jurisdictionId = resolved.jurisdictionId;
      jurisdictionName = resolved.jurisdictionName;
      jurisdictionKind = resolved.jurisdictionKind;
      jurisdictionContract = "legacy";
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
      ...(jurisdictionCode ?? legacyCountryCode
        ? { jurisdictionCode: jurisdictionCode ?? legacyCountryCode }
        : {}),
      ...(jurisdictionId ? { jurisdictionId } : {}),
      ...(jurisdictionName ? { jurisdictionName } : {}),
      ...(jurisdictionKind ? { jurisdictionKind } : {}),
      jurisdictionContract,
      status: "issued",
      issuedAt,
      expiresAt,
    });
    if (args.legacyResolutionUsed && await readUnifiedJurisdictionsEnabled(ctx)) {
      await recordLegacyJurisdictionDependency(
        ctx,
        readMigrationEnvironment(),
        issuedAt,
      );
    }
    await ctx.scheduler.runAt(expiresAt, finalizeExpiredCorrelationRef, { tokenHash });
    return { status: "issued" as const, correlationId: tokenHash, expiresAt };
  },
});

export const recordSearchPhase = mutation({
  args: {
    token: v.string(), providerStatus, latencyMs: v.optional(v.number()), totalLatencyMs: v.optional(v.number()), resultCount: v.number(),
    scopeSize: v.optional(v.number()), retrievalPlanSize: v.optional(v.number()),
    fileSearchCallCount: v.optional(v.number()), fileSearchStoreCount: v.optional(v.number()),
    fileSearchLatencyMs: v.optional(v.number()), evidenceBytes: v.optional(v.number()),
    citationCount: v.optional(v.number()), jurisdictionCoverage: v.optional(jurisdictionCoverage),
    contextDigest: v.optional(v.string()),
    partialCoverage: v.optional(v.boolean()),
    serviceProof: v.string(),
  },
  returns: phaseReturn,
  handler: async (ctx, args) => {
    const resultCount = validateResultCount(args.resultCount);
    const owner = await requireOwner(ctx);
    const row = await correlationByToken(ctx, args.token);
    requireCorrelationOwner(row, owner);
    const unified = effectiveJurisdictionContract(row) === "unified";
    const latencyMs = validateLatency(unified ? args.totalLatencyMs! : args.latencyMs!);
    const scopeSize = unified ? boundedCount(args.scopeSize!, MAX_SCOPE_SIZE) : undefined;
    const retrievalPlanSize = unified ? boundedCount(args.retrievalPlanSize!, MAX_PLAN_SIZE) : undefined;
    const fileSearchCallCount = unified ? boundedCount(args.fileSearchCallCount!, 1) : undefined;
    const fileSearchStoreCount = unified ? boundedCount(args.fileSearchStoreCount!, MAX_PLAN_SIZE) : undefined;
    const fileSearchLatencyMs = unified ? validateLatency(args.fileSearchLatencyMs!) : undefined;
    const evidenceBytes = unified ? boundedCount(args.evidenceBytes!, 240_000) : undefined;
    const citationCount = unified ? boundedCount(args.citationCount!, 64) : undefined;
    const coverage = unified ? args.jurisdictionCoverage : undefined;
    const contextDigest = validateDigest(args.contextDigest, unified && args.providerStatus !== "failure");
    if (unified && (args.providerStatus === "no_result" || args.latencyMs !== undefined || args.partialCoverage === undefined || !coverage
      || coverage.length !== retrievalPlanSize || coverage.some((item, index) => item.ordinal !== index)
      || coverage[0]?.relation !== "selected" || coverage.slice(1).some((item) => item.relation === "selected")
      || (fileSearchCallCount === 0) !== (fileSearchStoreCount === 0)
      || (fileSearchCallCount === 0) !== (fileSearchLatencyMs === 0)
      || latencyMs < fileSearchLatencyMs!
      || fileSearchStoreCount! > retrievalPlanSize!
      || fileSearchStoreCount! < coverage.filter((item) => item.coverage === "evidence").length
      || resultCount > retrievalPlanSize!
      || (coverage.some((item) => item.coverage === "evidence") !== (evidenceBytes! > 0))
      || (coverage[0]?.coverage === "unavailable" && coverage.some((item) => item.coverage === "evidence"))
      || citationCount! > coverage.filter((item) => item.coverage === "evidence").length * 16
      || (fileSearchCallCount === 0 && (evidenceBytes !== 0 || citationCount !== 0))
      || (args.providerStatus === "success" && (fileSearchCallCount !== 1 || coverage[0]?.coverage !== "evidence"
        || resultCount !== coverage.filter((item) => item.coverage === "evidence").length))
      || (args.providerStatus === "failure" && (contextDigest !== undefined || resultCount !== 0
        || evidenceBytes !== 0 || citationCount !== 0 || coverage.some((item) => item.coverage === "evidence")))
      || args.partialCoverage !== coverage.slice(1).some((item) => item.coverage !== "evidence"))) {
      throw new ConvexError("TELEMETRY_COUNT_INVALID");
    }
    await requireServiceProof(
      args.serviceProof,
      unified
        ? ["search-jurisdiction-v2", args.token, args.providerStatus, latencyMs, resultCount,
            scopeSize!, retrievalPlanSize!, fileSearchCallCount!, fileSearchStoreCount!, fileSearchLatencyMs!,
            evidenceBytes!, citationCount!, contextDigest ?? "", args.partialCoverage ? 1 : 0,
            coverage!.map((item) => `${item.ordinal}:${item.relation}:${item.coverage}`).join("|")]
        : ["search", args.token, args.providerStatus, latencyMs, resultCount],
    );
    if (row.status !== "issued") throw new ConvexError("TELEMETRY_CORRELATION_REPLAYED");
    if (Date.now() >= row.expiresAt) throw new ConvexError("TELEMETRY_CORRELATION_EXPIRED");
    await ctx.db.patch(row._id, {
      status: args.providerStatus === "failure" ? "finalized" : "search_complete",
      searchProviderStatus: args.providerStatus,
      searchLatencyMs: latencyMs,
      resultCount,
      ...(unified ? {
        scopeSize,
        retrievalPlanSize,
        fileSearchCallCount,
        fileSearchStoreCount,
        fileSearchLatencyMs,
        evidenceBytes,
        citationCount,
        jurisdictionCoverage: coverage,
        ...(contextDigest ? { contextDigest } : {}),
        partialCoverage: args.partialCoverage,
      } : {}),
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
  args: {
    token: v.string(), jurisdictionCode: v.optional(v.string()),
    jurisdictionId: v.optional(v.id("jurisdictions")),
    legacyCountryCode: v.optional(v.string()), contextDigest: v.optional(v.string()),
    serviceProof: v.string(),
  },
  returns: v.object({ status: v.literal("chat_claimed"), correlationId: v.string(), claimNonce: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const row = await correlationByToken(ctx, args.token);
    requireCorrelationOwner(row, owner);
    if (effectiveJurisdictionContract(row) === "unified") {
      const contextDigest = validateDigest(args.contextDigest, true)!;
      const legacyCountryCode = normalizeLegacySnapshot(args.legacyCountryCode);
      await requireServiceProof(args.serviceProof, [
        "claim-jurisdiction-v1", args.token, args.jurisdictionId ?? "",
        legacyCountryCode ?? "", contextDigest,
      ]);
      if (args.jurisdictionId !== row.jurisdictionId || legacyCountryCode !== row.jurisdictionCode) {
        throw new ConvexError("TELEMETRY_JURISDICTION_MISMATCH");
      }
      if (contextDigest !== row.contextDigest) throw new ConvexError("TELEMETRY_CONTEXT_MISMATCH");
    } else {
      if (args.jurisdictionCode === undefined || args.jurisdictionId !== undefined ||
        args.legacyCountryCode !== undefined || args.contextDigest !== undefined) {
        throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      }
      const jurisdictionCode = normalizeJurisdiction(args.jurisdictionCode);
      await requireServiceProof(args.serviceProof, ["claim", args.token, jurisdictionCode]);
      if (row.jurisdictionCode !== jurisdictionCode) throw new ConvexError("TELEMETRY_JURISDICTION_MISMATCH");
    }
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
    const unifiedJurisdictionsEnabled = await readUnifiedJurisdictionsEnabled(ctx);
    const groups = new Map<string, Doc<"queryRuns">[]>();
    for (const row of rows) {
      if (!DAY_PATTERN.test(row.day)) throw new ConvexError("TELEMETRY_DAY_INVALID");
      if (!row.jurisdictionId && !row.jurisdictionCode) {
        throw new ConvexError("TELEMETRY_JURISDICTION_INVALID");
      }
      const key = row.jurisdictionId && (unifiedJurisdictionsEnabled || !row.jurisdictionCode)
        ? `${row.day}:id:${row.jurisdictionId}`
        : `${row.day}:code:${row.jurisdictionCode}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const now = Date.now();
    for (const group of groups.values()) {
      const { day, jurisdictionCode, jurisdictionId } = group[0];
      const existingRows = jurisdictionId && (unifiedJurisdictionsEnabled || !jurisdictionCode)
        ? await ctx.db.query("dailyMetrics").withIndex("by_day_and_jurisdictionId", (q) =>
            q.eq("day", day).eq("jurisdictionId", jurisdictionId),
          ).take(2)
        : await ctx.db.query("dailyMetrics").withIndex("by_day_and_jurisdictionCode", (q) =>
            q.eq("day", day).eq("jurisdictionCode", jurisdictionCode),
          ).take(2);
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
        ...(jurisdictionCode ? { jurisdictionCode } : {}),
        ...(jurisdictionId ? { jurisdictionId } : {}),
        ...(group[0].jurisdictionName ? { jurisdictionName: group[0].jurisdictionName } : {}),
        ...(group[0].jurisdictionKind ? { jurisdictionKind: group[0].jurisdictionKind } : {}),
        totalQuestions,
        successCount: (existing?.successCount ?? 0) + group.filter((row) => row.outcome === "success").length,
        failureCount: (existing?.failureCount ?? 0) + group.filter((row) => row.outcome === "failure").length,
        abortedCount: (existing?.abortedCount ?? 0) + group.filter((row) => row.outcome === "aborted").length,
        providerFailureCount: (existing?.providerFailureCount ?? 0) + group.filter((row) => row.searchProviderStatus === "failure" || row.generationProviderStatus === "failure").length,
        noResultCount: (existing?.noResultCount ?? 0) + group.filter((row) => row.searchProviderStatus === "no_result").length,
        configurationUnavailableCount:
          (existing?.configurationUnavailableCount ?? 0) +
          group.reduce((sum, row) => sum + (row.configurationUnavailableCount ?? 0), 0),
        supplementaryProviderFailureCount:
          (existing?.supplementaryProviderFailureCount ?? 0) +
          group.reduce((sum, row) => sum + (row.supplementaryProviderFailureCount ?? 0), 0),
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
    const cursor = rows[rows.length - 1]?._id ?? null;
    if (!done) await ctx.scheduler.runAfter(0, rollupDailyMetricsRef, { cursor });
    return { processed: rows.length, done, cursor };
  },
});
