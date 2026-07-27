import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { isAdminRole, type AdminRole } from "../lib/adminPermissions";
import { writeAudit } from "./audit";

const MAX_PAYLOAD_BYTES = 8_192;
const MAX_PAYLOAD_DEPTH = 5;
const MAX_PAYLOAD_ENTRIES = 100;
const MAX_PAYLOAD_ARRAY = 100;
const MAX_PAYLOAD_STRING = 10_000;
const MAX_RECONCILE_BATCH = 25;
const POLL_AFTER_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 20 * 60_000] as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_TARGET_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SENSITIVE_KEY = /(?:token|secret|password|passwd|credential|auth(?:entication|orization)?|bearer|cookie|api.?key|signature|private.?key)/i;

const jobTypeValidator = v.union(
  v.literal("create_bucket"),
  v.literal("ingest_remote"),
  v.literal("copy_documents"),
  v.literal("delete_documents"),
  v.literal("poll_process"),
);
const providerStatusValidator = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("error"),
  v.literal("cancelled"),
);
const providerErrorKindValidator = v.union(
  v.literal("invalid_request"),
  v.literal("validation"),
  v.literal("authentication"),
  v.literal("not_found"),
  v.literal("rate_limit"),
  v.literal("timeout"),
  v.literal("network"),
  v.literal("invalid_response"),
  v.literal("provider"),
);
const actorValidator = v.object({ id: v.string(), roles: v.array(v.string()) });
const enqueueResultValidator = v.object({
  jobId: v.id("integrationJobs"),
  callbackToken: v.union(v.string(), v.null()),
  callbackTokenHash: v.string(),
  duplicate: v.boolean(),
});
const completionResultValidator = v.object({ accepted: v.boolean(), duplicate: v.boolean() });
const failureResultValidator = v.object({
  status: v.union(v.literal("queued"), v.literal("failed"), v.literal("manual_review")),
  nextAttemptAt: v.union(v.number(), v.null()),
});

type JobType = "create_bucket" | "ingest_remote" | "copy_documents" | "delete_documents" | "poll_process";
type ProviderStatus = "queued" | "processing" | "complete" | "error" | "cancelled";
type ProviderErrorKind = "invalid_request" | "validation" | "authentication" | "not_found" | "rate_limit" | "timeout" | "network" | "invalid_response" | "provider";
type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

const runGroundxJobRef = makeFunctionReference<"action">("admin/groundxActions:runGroundxJob");

function assertIdentifier(value: string, error: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new ConvexError(error);
  return value;
}

function sanitizeValue(value: unknown, depth: number, entries: { count: number }): SafeJson {
  if (depth > MAX_PAYLOAD_DEPTH) throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_PAYLOAD_STRING) throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ARRAY) throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
    return value.map((item) => sanitizeValue(item, depth + 1, entries));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
  }
  const output: Record<string, SafeJson> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    entries.count += 1;
    if (entries.count > MAX_PAYLOAD_ENTRIES || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || SENSITIVE_KEY.test(key)) {
      throw new ConvexError("INTEGRATION_PAYLOAD_UNSAFE");
    }
    output[key] = sanitizeValue((value as Record<string, unknown>)[key], depth + 1, entries);
  }
  return output;
}

function canonicalPayload(payload: unknown): string {
  const encoded = JSON.stringify(sanitizeValue(payload, 0, { count: 0 }));
  if (new TextEncoder().encode(encoded).byteLength > MAX_PAYLOAD_BYTES) {
    throw new ConvexError("INTEGRATION_PAYLOAD_TOO_LARGE");
  }
  return encoded;
}

export async function hashCallbackToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string): boolean {
  const width = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < width; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function validatedActor(actor: { id: string; roles: string[] }): { id: string; roles: AdminRole[] } {
  assertIdentifier(actor.id, "INTEGRATION_ACTOR_INVALID");
  const roles = [...new Set(actor.roles)];
  if (roles.length === 0 || roles.length > 6 || !roles.every(isAdminRole)) {
    throw new ConvexError("INTEGRATION_ACTOR_INVALID");
  }
  return { id: actor.id, roles: roles as AdminRole[] };
}

async function auditJob(ctx: MutationCtx, job: Doc<"integrationJobs">, outcome: "success" | "failure", action: string) {
  await writeAudit(ctx, {
    actorId: job.actorId,
    actorRoles: job.actorRoles,
    action,
    targetType: job.targetType,
    targetId: job.targetId,
    reason: "Durable provider job transition",
    correlationId: job.correlationId,
    outcome,
  });
}

export const enqueueJob = internalMutation({
  args: {
    type: jobTypeValidator,
    targetType: v.string(),
    targetId: v.string(),
    payload: v.any(),
    idempotencyKey: v.string(),
    actor: actorValidator,
  },
  returns: enqueueResultValidator,
  handler: async (ctx, args) => {
    const actor = validatedActor(args.actor);
    if (!SAFE_TARGET_TYPE.test(args.targetType)) throw new ConvexError("INTEGRATION_TARGET_INVALID");
    const targetType = args.targetType;
    const targetId = assertIdentifier(args.targetId, "INTEGRATION_TARGET_INVALID");
    const idempotencyKey = assertIdentifier(args.idempotencyKey, "INTEGRATION_IDEMPOTENCY_INVALID");
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ConvexError("INTEGRATION_IDEMPOTENCY_INVALID");
    }
    const payload = canonicalPayload(args.payload);
    const fingerprint = await hashCallbackToken(JSON.stringify({ type: args.type, targetType, targetId, payload }));
    const existing = await ctx.db
      .query("integrationJobs")
      .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.id).eq("idempotencyKey", idempotencyKey))
      .take(2);
    if (existing.length > 1) throw new ConvexError("INTEGRATION_IDEMPOTENCY_STATE_INVALID");
    if (existing.length === 1) {
      if (!safeEqual(existing[0].requestFingerprint, fingerprint)) {
        throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT");
      }
      return { jobId: existing[0]._id, callbackToken: null, callbackTokenHash: existing[0].callbackTokenHash, duplicate: true };
    }

    const callbackToken = `gx_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const callbackTokenHash = await hashCallbackToken(callbackToken);
    const now = Date.now();
    const correlationId = `job_${crypto.randomUUID().replaceAll("-", "")}`;
    const jobId = await ctx.db.insert("integrationJobs", {
      type: args.type as JobType,
      targetType,
      targetId,
      payload,
      actorId: actor.id,
      actorRoles: actor.roles,
      idempotencyKey,
      requestFingerprint: fingerprint,
      correlationId,
      callbackTokenHash,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const job = await ctx.db.get(jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    await auditJob(ctx, job, "success", "integration.job_queued");
    await ctx.scheduler.runAfter(0, runGroundxJobRef, { jobId });
    return { jobId, callbackToken, callbackTokenHash, duplicate: false };
  },
});

export const getJobForRun = internalQuery({
  args: { jobId: v.id("integrationJobs") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
});

export const claimJob = internalMutation({
  args: { jobId: v.id("integrationJobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || (job.status !== "queued" && job.status !== "waiting_callback")) return false;
    if (job.nextAttemptAt !== undefined && job.nextAttemptAt > Date.now()) return false;
    await ctx.db.patch(job._id, { status: "running", nextAttemptAt: Date.now() + POLL_AFTER_MS, updatedAt: Date.now() });
    return true;
  },
});

async function completeJob(ctx: MutationCtx, job: Doc<"integrationJobs">, processId: string, status: ProviderStatus) {
  if (job.processId !== undefined && job.processId !== processId) throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
  if (["succeeded", "failed", "cancelled"].includes(job.status)) {
    const expected = status === "complete" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
    if (job.status === expected) return { accepted: true, duplicate: true };
    throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
  }
  if (job.status !== "running" && job.status !== "waiting_callback") {
    throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
  }
  if (status === "queued" || status === "processing") {
    await ctx.db.patch(job._id, { processId, status: "waiting_callback", nextAttemptAt: Date.now() + POLL_AFTER_MS, updatedAt: Date.now() });
    return { accepted: true, duplicate: false };
  }
  const nextStatus = status === "complete" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
  await ctx.db.patch(job._id, { processId, status: nextStatus, nextAttemptAt: undefined, updatedAt: Date.now() });
  await auditJob(ctx, job, nextStatus === "succeeded" ? "success" : "failure", `integration.job_${nextStatus}`);
  return { accepted: true, duplicate: false };
}

export const applyProviderResult = internalMutation({
  args: { jobId: v.id("integrationJobs"), processId: v.string(), status: providerStatusValidator },
  returns: completionResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    if (job.status === "queued") throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
    return await completeJob(ctx, job, assertIdentifier(args.processId, "INTEGRATION_PROCESS_INVALID"), args.status as ProviderStatus);
  },
});

export const completeGroundxCallback = internalMutation({
  args: { tokenHash: v.string(), processId: v.string(), targetType: v.string(), targetId: v.string(), status: providerStatusValidator },
  returns: completionResultValidator,
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.tokenHash)) throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
    const candidates = await ctx.db.query("integrationJobs").withIndex("by_callbackTokenHash", (q) => q.eq("callbackTokenHash", args.tokenHash)).take(2);
    if (candidates.length !== 1 || !safeEqual(candidates[0].callbackTokenHash, args.tokenHash)) throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
    const job = candidates[0];
    if (job.processId === undefined) throw new ConvexError("INTEGRATION_CALLBACK_NOT_READY");
    if (job.processId !== args.processId || job.targetType !== args.targetType || job.targetId !== args.targetId) throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
    return await completeJob(ctx, job, args.processId, args.status as ProviderStatus);
  },
});

export const recordProviderFailure = internalMutation({
  args: {
    jobId: v.id("integrationJobs"),
    kind: providerErrorKindValidator,
    retryable: v.optional(v.boolean()),
  },
  returns: failureResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    if (job.status !== "running") throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
    const retryable =
      args.retryable ?? ["rate_limit", "timeout", "network"].includes(args.kind);
    const attemptCount = job.attemptCount + 1;
    if (retryable && attemptCount <= RETRY_DELAYS_MS.length) {
      const nextAttemptAt = Date.now() + RETRY_DELAYS_MS[attemptCount - 1];
      await ctx.db.patch(job._id, { status: "queued", attemptCount, nextAttemptAt, lastErrorKind: args.kind, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(RETRY_DELAYS_MS[attemptCount - 1], runGroundxJobRef, { jobId: job._id });
      return { status: "queued" as const, nextAttemptAt };
    }
    const status: "manual_review" | "failed" = retryable ? "manual_review" : "failed";
    await ctx.db.patch(job._id, { status, attemptCount, nextAttemptAt: undefined, lastErrorKind: args.kind, updatedAt: Date.now() });
    await auditJob(ctx, job, "failure", status === "manual_review" ? "integration.job_manual_review" : "integration.job_failed");
    return { status, nextAttemptAt: null };
  },
});

export const reconcileStaleJobs = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    let scheduled = 0;
    let hasMore = false;
    for (const status of ["queued", "waiting_callback", "running"] as const) {
      const remaining = MAX_RECONCILE_BATCH - scheduled;
      if (remaining === 0) {
        hasMore = true;
        break;
      }
      const due = await ctx.db
        .query("integrationJobs")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", status).lte("nextAttemptAt", now),
        )
        .take(remaining + 1);
      if (due.length > remaining) hasMore = true;
      for (const job of due.slice(0, remaining)) {
        if (job.status === "running") {
          await ctx.db.patch(job._id, { status: "queued", updatedAt: now });
        }
        await ctx.scheduler.runAfter(0, runGroundxJobRef, { jobId: job._id });
        scheduled += 1;
      }
      if (hasMore) break;
    }
    return { scheduled, hasMore };
  },
});
