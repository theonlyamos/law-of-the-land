import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { getEffectiveAllowance } from "../usage";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { polar } from "../polar";

const MAX_PAGE = 50;
const MAX_LIMIT = 10_000;
const MAX_DURATION_MS = 90 * 24 * 60 * 60 * 1_000;
const LARGE_LIMIT = 1_000;
const LONG_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_START_MS = 30 * 24 * 60 * 60 * 1_000;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const overrideProjection = v.object({
  id: v.id("quotaOverrides"),
  limit: v.number(),
  startsAt: v.number(),
  expiresAt: v.number(),
  grantedBy: v.string(),
  reason: v.string(),
});

const allowanceProjection = v.object({
  userId: v.string(),
  used: v.number(),
  baseLimit: v.number(),
  effectiveLimit: v.number(),
  allowed: v.boolean(),
  isPro: v.boolean(),
  override: v.union(v.null(), overrideProjection),
});

const operationReturn = v.object({
  status: v.literal("succeeded"),
  correlationId: v.string(),
  overrideId: v.id("quotaOverrides"),
  startsAt: v.number(),
});

function validatePage(options: { numItems: number; cursor: string | null }) {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > MAX_PAGE) {
    throw new ConvexError("INVALID_BILLING_PAGE_SIZE");
  }
  return options;
}

function validateKey(value: string): string {
  if (!KEY_PATTERN.test(value)) throw new ConvexError("INVALID_IDEMPOTENCY_KEY");
  return value;
}

function fingerprint(parts: readonly (string | number)[]): string {
  return parts.map((part) => `${String(part).length}:${String(part)}`).join("|");
}

function correlationId(): string {
  return `op_${crypto.randomUUID().replaceAll("-", "")}`;
}

function projectOverride(row: Doc<"quotaOverrides"> | null) {
  return row ? { id: row._id, limit: row.limit, startsAt: row.startsAt, expiresAt: row.expiresAt, grantedBy: row.grantedBy, reason: row.reason } : null;
}

async function replay(
  ctx: MutationCtx,
  actorId: string,
  idempotencyKey: string,
  requestFingerprint: string,
  action: "quota_override_grant" | "quota_override_revoke",
) {
  const existing = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actorId).eq("idempotencyKey", idempotencyKey)).unique();
  if (!existing) return null;
  if (existing.action !== action || existing.requestFingerprint !== requestFingerprint) throw new ConvexError("IDEMPOTENCY_KEY_CONFLICT");
  const rows = action === "quota_override_grant"
    ? await ctx.db.query("quotaOverrides").withIndex("by_grantOperationId", (q) => q.eq("grantOperationId", existing._id)).take(1)
    : await ctx.db.query("quotaOverrides").withIndex("by_revokeOperationId", (q) => q.eq("revokeOperationId", existing._id)).take(1);
  if (rows.length !== 1) throw new ConvexError("IDEMPOTENT_RESULT_UNAVAILABLE");
  return { status: "succeeded" as const, correlationId: existing.correlationId, overrideId: rows[0]._id, startsAt: rows[0].startsAt };
}

export const getEffectiveAllowanceForUser = query({
  args: { userId: v.string(), now: v.optional(v.number()) },
  returns: allowanceProjection,
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "billing", "read");
    if (!args.userId || args.userId.trim() !== args.userId) throw new ConvexError("INVALID_USER_ID");
    const allowance = await getEffectiveAllowance(ctx, args.userId, args.now ?? Date.now());
    return { userId: args.userId, used: allowance.used, baseLimit: allowance.baseLimit, effectiveLimit: allowance.effectiveLimit, allowed: allowance.allowed, isPro: allowance.isPro, override: projectOverride(allowance.override) };
  },
});

export const listUsage = query({
  args: { paginationOpts: paginationOptsValidator, day: v.optional(v.string()) },
  returns: v.object({ page: v.array(allowanceProjection), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "billing", "read");
    const options = validatePage(args.paginationOpts);
    const day = args.day ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConvexError("INVALID_USAGE_DAY");
    const page = await ctx.db.query("dailyUsage").withIndex("by_day_and_userId", (q) => q.eq("day", day)).paginate(options);
    const now = Date.now();
    return { isDone: page.isDone, continueCursor: page.continueCursor, page: await Promise.all(page.page.map(async (row) => {
      const allowance = await getEffectiveAllowance(ctx, row.userId, now);
      return { userId: row.userId, used: allowance.used, baseLimit: allowance.baseLimit, effectiveLimit: allowance.effectiveLimit, allowed: allowance.allowed, isPro: allowance.isPro, override: projectOverride(allowance.override) };
    })) };
  },
});

export const listSubscriptions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.object({ userId: v.string(), plan: v.union(v.literal("free"), v.literal("pro")), status: v.union(v.string(), v.null()), currentPeriodStart: v.union(v.string(), v.null()), currentPeriodEnd: v.union(v.string(), v.null()), used: v.number(), baseLimit: v.number(), effectiveLimit: v.number(), allowed: v.boolean(), override: v.union(v.null(), overrideProjection) })), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "billing", "read");
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, { model: "user", select: ["id"], sortBy: { field: "createdAt", direction: "desc" }, paginationOpts: validatePage(args.paginationOpts) }) as { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string };
    const now = Date.now();
    return { isDone: result.isDone, continueCursor: result.continueCursor, page: await Promise.all(result.page.map(async (user) => {
      const [subscription, allowance] = await Promise.all([polar.getCurrentSubscription(ctx, { userId: user._id }), getEffectiveAllowance(ctx, user._id, now)]);
      return { userId: user._id, plan: subscription ? "pro" as const : "free" as const, status: subscription?.status ?? null, currentPeriodStart: subscription?.currentPeriodStart ?? null, currentPeriodEnd: subscription?.currentPeriodEnd ?? null, used: allowance.used, baseLimit: allowance.baseLimit, effectiveLimit: allowance.effectiveLimit, allowed: allowance.allowed, override: projectOverride(allowance.override) };
    })) };
  },
});

export const grantQuotaOverride = mutation({
  args: { userId: v.string(), limit: v.number(), startsAt: v.number(), expiresAt: v.number(), reason: v.string(), idempotencyKey: v.string(), confirmation: v.string() },
  returns: operationReturn,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "billing", "write");
    const reason = validateAuditReason(args.reason);
    const key = validateKey(args.idempotencyKey);
    if (!args.userId || args.userId.trim() !== args.userId || args.userId.length > 256) throw new ConvexError("INVALID_USER_ID");
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) throw new ConvexError("INVALID_QUOTA_LIMIT");
    const now = Date.now();
    const startsAt = args.startsAt < now ? now : args.startsAt;
    const duration = args.expiresAt - startsAt;
    if (![args.startsAt, args.expiresAt].every(Number.isSafeInteger) || args.startsAt < now - 60_000 || startsAt > now + MAX_FUTURE_START_MS || duration < 1_000 || duration > MAX_DURATION_MS) throw new ConvexError("INVALID_QUOTA_INTERVAL");
    const expectedConfirmation = `CONFIRM_QUOTA_OVERRIDE ${args.userId}`;
    if ((args.limit > LARGE_LIMIT || duration > LONG_DURATION_MS) && args.confirmation !== expectedConfirmation) throw new ConvexError(expectedConfirmation);
    const requestFingerprint = fingerprint([args.userId, args.limit, args.startsAt, args.expiresAt, reason, args.confirmation]);
    const prior = await replay(ctx, actor.userId, key, requestFingerprint, "quota_override_grant");
    if (prior) return prior;
    const outstanding = await ctx.db.query("quotaOverrides").withIndex("by_userId_and_active_and_expiresAt", (q) => q.eq("userId", args.userId).eq("active", true).gt("expiresAt", now)).take(1);
    if (outstanding.length > 0) throw new ConvexError("OVERLAPPING_QUOTA_OVERRIDE");
    const correlation = correlationId();
    const operationId = await ctx.db.insert("adminOperations", { actorId: actor.userId, action: "quota_override_grant", targetId: args.userId, idempotencyKey: key, requestFingerprint, correlationId: correlation, status: "succeeded", result: { status: "succeeded", correlationId: correlation, action: "quota_override_grant", targetId: args.userId }, createdAt: now, updatedAt: now });
    const overrideId = await ctx.db.insert("quotaOverrides", { userId: args.userId, limit: args.limit, startsAt, expiresAt: args.expiresAt, grantedBy: actor.userId, reason, active: true, grantOperationId: operationId, createdAt: now, updatedAt: now });
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "billing.quota_override_granted", targetType: "quotaOverride", targetId: overrideId, reason, correlationId: correlation, outcome: "success", afterSummary: `limit ${args.limit}; expires ${args.expiresAt}` });
    return { status: "succeeded" as const, correlationId: correlation, overrideId, startsAt };
  },
});

export const revokeQuotaOverride = mutation({
  args: { overrideId: v.id("quotaOverrides"), reason: v.string(), idempotencyKey: v.string() },
  returns: operationReturn,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "billing", "write");
    const reason = validateAuditReason(args.reason); const key = validateKey(args.idempotencyKey);
    const requestFingerprint = fingerprint([args.overrideId, reason]);
    const prior = await replay(ctx, actor.userId, key, requestFingerprint, "quota_override_revoke");
    if (prior) return prior;
    const row = await ctx.db.get(args.overrideId); if (!row) throw new ConvexError("QUOTA_OVERRIDE_NOT_FOUND"); if (row.revokedAt !== undefined) throw new ConvexError("QUOTA_OVERRIDE_ALREADY_REVOKED");
    const now = Date.now(); const correlation = correlationId();
    const operationId = await ctx.db.insert("adminOperations", { actorId: actor.userId, action: "quota_override_revoke", targetId: args.overrideId, idempotencyKey: key, requestFingerprint, correlationId: correlation, status: "succeeded", result: { status: "succeeded", correlationId: correlation, action: "quota_override_revoke", targetId: args.overrideId }, createdAt: now, updatedAt: now });
    await ctx.db.patch(args.overrideId, { active: false, revokedAt: now, revokedBy: actor.userId, revokeReason: reason, revokeOperationId: operationId, updatedAt: now });
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "billing.quota_override_revoked", targetType: "quotaOverride", targetId: args.overrideId, reason, correlationId: correlation, outcome: "success", beforeSummary: `limit ${row.limit}; expires ${row.expiresAt}` });
    return { status: "succeeded" as const, correlationId: correlation, overrideId: args.overrideId, startsAt: row.startsAt };
  },
});
