import { ConvexError, v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { applyPublicationJobOutcome } from "./publicationState";

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
const documentTypeValidator = v.union(
  v.literal("txt"), v.literal("docx"), v.literal("pptx"),
  v.literal("xlsx"), v.literal("pdf"), v.literal("png"),
  v.literal("jpg"), v.literal("csv"), v.literal("tsv"),
  v.literal("json"),
);
const documentEvidenceValidator = v.object({
  documentId: v.string(),
  status: providerStatusValidator,
  fileType: v.optional(documentTypeValidator),
  fileSize: v.optional(v.number()),
});
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
const actorRoleValidator = v.union(
  v.literal("super_admin"),
  v.literal("content_manager"),
  v.literal("content_reviewer"),
  v.literal("support_agent"),
  v.literal("billing_manager"),
  v.literal("auditor"),
);
const jobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting_callback"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("manual_review"),
);
const jobDocumentValidator = v.object({
  _id: v.id("integrationJobs"),
  _creationTime: v.number(),
  type: jobTypeValidator,
  targetType: v.string(),
  targetId: v.string(),
  payload: v.string(),
  actorId: v.string(),
  actorRoles: v.array(actorRoleValidator),
  idempotencyKey: v.string(),
  requestFingerprint: v.string(),
  correlationId: v.string(),
  callbackTokenHash: v.string(),
  processId: v.optional(v.string()),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  status: jobStatusValidator,
  attemptCount: v.number(),
  nextAttemptAt: v.optional(v.number()),
  lastErrorKind: v.optional(providerErrorKindValidator),
  retentionRedactedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
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
const claimResultValidator = v.union(
  v.null(),
  v.object({
    leaseToken: v.string(),
    workKind: v.union(v.literal("execute"), v.literal("poll")),
    job: jobDocumentValidator,
  }),
);

type JobType = "create_bucket" | "ingest_remote" | "copy_documents" | "delete_documents" | "poll_process";
type ProviderStatus = "queued" | "processing" | "complete" | "error" | "cancelled";
type ProviderErrorKind = "invalid_request" | "validation" | "authentication" | "not_found" | "rate_limit" | "timeout" | "network" | "invalid_response" | "provider";
type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

const runGroundxJobRef = makeFunctionReference<"action">("admin/groundxActions:runGroundxJob");
const reconcileStaleJobsRef = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);

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

async function auditJob(ctx: MutationCtx, job: Doc<"integrationJobs">, outcome: "success" | "failure", action: string) {
  await writeAudit(
    ctx,
    {
      actorId: job.actorId,
      actorRoles: job.actorRoles,
      action,
      targetType: job.targetType,
      targetId: job.targetId,
      reason: "Durable provider job transition",
      correlationId: job.correlationId,
      outcome,
    },
    job.actorId === "system"
      ? { actorType: "system", actorUserId: "system", metadata: {} }
      : { actorType: "user", actorUserId: job.actorId, metadata: {} },
  );
}

type EnqueueInput = {
  type: JobType;
  targetType: string;
  targetId: string;
  payload: unknown;
  idempotencyKey: string;
};

export async function persistJob(
  ctx: MutationCtx,
  args: EnqueueInput,
  actor: { id: string; roles: AdminRole[] },
) {
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

    // The live callback token is minted only after an action claims the job.
    // This sentinel hash is never a usable callback credential.
    const callbackTokenHash = await hashCallbackToken(
      `unarmed_${crypto.randomUUID()}${crypto.randomUUID()}`,
    );
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
    return { jobId, callbackToken: null, callbackTokenHash, duplicate: false };
}

const enqueueArgs = {
  type: jobTypeValidator,
  targetType: v.string(),
  targetId: v.string(),
  payload: v.any(),
  idempotencyKey: v.string(),
};

function permissionForJob(type: JobType): [string, string] {
  switch (type) {
    case "create_bucket":
      return ["jurisdiction", "write"];
    case "copy_documents":
      return ["document", "publish"];
    case "poll_process":
      return ["operations", "write"];
    case "ingest_remote":
    case "delete_documents":
      return ["document", "write"];
  }
}

export const enqueueJob = mutation({
  args: enqueueArgs,
  returns: enqueueResultValidator,
  handler: async (ctx, args) => {
    const [resource, action] = permissionForJob(args.type as JobType);
    const admin = await requireEnabledAdminPermission(ctx, resource, action);
    return await persistJob(ctx, args as EnqueueInput, {
      id: admin.userId,
      roles: admin.roles,
    });
  },
});

export const enqueueSystemJob = internalMutation({
  args: {
    ...enqueueArgs,
    systemActor: v.literal("groundx_orchestrator"),
  },
  returns: enqueueResultValidator,
  handler: async (ctx, args) => {
    const { systemActor: _systemActor, ...input } = args;
    return await persistJob(ctx, input as EnqueueInput, {
      id: "system",
      roles: [],
    });
  },
});

export const getJobForRun = internalQuery({
  args: { jobId: v.id("integrationJobs"), leaseToken: v.string() },
  returns: v.union(v.null(), jobDocumentValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.leaseToken === undefined ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= Date.now() ||
      !safeEqual(job.leaseToken, args.leaseToken)
    ) {
      return null;
    }
    return job;
  },
});

export const armGroundxCallback = internalMutation({
  args: {
    jobId: v.id("integrationJobs"),
    leaseToken: v.string(),
    tokenHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.tokenHash)) {
      throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
    }
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.type !== "ingest_remote" ||
      job.status !== "running" ||
      job.leaseToken !== args.leaseToken
    ) {
      throw new ConvexError("INTEGRATION_CALLBACK_NOT_READY");
    }
    await ctx.db.patch(job._id, {
      callbackTokenHash: args.tokenHash,
      updatedAt: Date.now(),
    });
    return null;
  },
});

async function claimJobDocument(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
  allowStaleRunning = false,
  allowUncertainManualReview = false,
) {
    if (
      job.status !== "queued" &&
      job.status !== "waiting_callback" &&
      !(allowStaleRunning && job.status === "running") &&
      !(allowUncertainManualReview && job.status === "manual_review")
    ) {
      return null;
    }
    if (job.nextAttemptAt !== undefined && job.nextAttemptAt > Date.now()) {
      return null;
    }
    const now = Date.now();
    const leaseToken = `lease_${crypto.randomUUID().replaceAll("-", "")}`;
    const leaseExpiresAt = now + POLL_AFTER_MS;
    const claimedJob: Doc<"integrationJobs"> = {
      ...job,
      status: "running",
      leaseToken,
      leaseExpiresAt,
      nextAttemptAt: leaseExpiresAt,
      updatedAt: now,
    };
    await ctx.db.patch(job._id, {
      status: "running",
      leaseToken,
      leaseExpiresAt,
      nextAttemptAt: leaseExpiresAt,
      updatedAt: now,
    });
    return {
      leaseToken,
      workKind: (job.processId === undefined ? "execute" : "poll") as
        | "execute"
        | "poll",
      job: claimedJob,
    };
}

export const claimJob = internalMutation({
  args: { jobId: v.id("integrationJobs") },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return await claimJobDocument(ctx, job);
  },
});

export const reconcileManualReviewJob = internalMutation({
  args: { jobId: v.id("integrationJobs") },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "manual_review" ||
      job.processId === undefined ||
      job.lastErrorKind === undefined ||
      !["rate_limit", "timeout", "network"].includes(job.lastErrorKind)
    ) {
      return null;
    }
    const claim = await claimJobDocument(ctx, job, false, true);
    if (claim) {
      await ctx.scheduler.runAfter(0, runGroundxJobRef, {
        jobId: job._id,
        leaseToken: claim.leaseToken,
      });
    }
    return claim;
  },
});

function assertCurrentLease(job: Doc<"integrationJobs">, leaseToken: string) {
  if (
    job.status !== "running" ||
    job.leaseToken === undefined ||
    job.leaseExpiresAt === undefined ||
    job.leaseExpiresAt <= Date.now() ||
    !safeEqual(job.leaseToken, leaseToken)
  ) {
    throw new ConvexError("INTEGRATION_LEASE_INVALID");
  }
}

async function completeJob(ctx: MutationCtx, job: Doc<"integrationJobs">, processId: string, status: ProviderStatus) {
  if (job.processId !== undefined && job.processId !== processId) throw new ConvexError("INTEGRATION_CALLBACK_NOT_FOUND");
  if (["succeeded", "failed", "cancelled"].includes(job.status)) {
    const expected = status === "complete" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
    if (job.status === expected) return { accepted: true, duplicate: true };
    throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
  }
  const uncertainManualReview =
    job.status === "manual_review" &&
    job.processId !== undefined &&
    job.lastErrorKind !== undefined &&
    ["rate_limit", "timeout", "network"].includes(job.lastErrorKind);
  if (
    job.status !== "running" &&
    job.status !== "waiting_callback" &&
    !uncertainManualReview
  ) {
    throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
  }
  if (status === "queued" || status === "processing") {
    if (uncertainManualReview) throw new ConvexError("INTEGRATION_TRANSITION_INVALID");
    await ctx.db.patch(job._id, {
      processId,
      status: "waiting_callback",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: Date.now() + POLL_AFTER_MS,
      updatedAt: Date.now(),
    });
    return { accepted: true, duplicate: false };
  }
  const nextStatus = status === "complete" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
  await ctx.db.patch(job._id, {
    processId,
    status: nextStatus,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    updatedAt: Date.now(),
    retentionPending: true,
  });
  if (job.targetType === "documentVersion") {
    await applyPublicationJobOutcome(ctx, job, nextStatus === "succeeded" ? "succeeded" : "failed", processId);
  }
  await auditJob(ctx, job, nextStatus === "succeeded" ? "success" : "failure", `integration.job_${nextStatus}`);
  return { accepted: true, duplicate: false };
}

export const applyProviderResult = internalMutation({
  args: {
    jobId: v.id("integrationJobs"),
    leaseToken: v.string(),
    processId: v.string(),
    status: providerStatusValidator,
    documentEvidence: v.optional(documentEvidenceValidator),
  },
  returns: completionResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    assertCurrentLease(job, args.leaseToken);
    const processId = assertIdentifier(args.processId, "INTEGRATION_PROCESS_INVALID");
    if (args.documentEvidence !== undefined) {
      if (job.targetType !== "documentVersion" || !["ingest_remote", "poll_process"].includes(job.type)) {
        throw new ConvexError("INTEGRATION_EVIDENCE_TARGET_INVALID");
      }
      const version = await ctx.db.get(job.targetId as Id<"documentVersions">);
      if (
        !version ||
        version.groundxStagingDocumentId !== args.documentEvidence.documentId ||
        args.documentEvidence.status !== args.status ||
        (args.documentEvidence.fileSize !== undefined &&
          (!Number.isSafeInteger(args.documentEvidence.fileSize) || args.documentEvidence.fileSize < 0))
      ) {
        throw new ConvexError("INTEGRATION_EVIDENCE_INVALID");
      }
      await ctx.db.patch(version._id, {
        xrayEvidence: {
          ...args.documentEvidence,
          processId,
          observedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
    }
    return await completeJob(ctx, job, processId, args.status as ProviderStatus);
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
    leaseToken: v.string(),
    kind: providerErrorKindValidator,
  },
  returns: failureResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    assertCurrentLease(job, args.leaseToken);
    const retryable = ["rate_limit", "timeout", "network"].includes(args.kind);
    const attemptCount = job.attemptCount + 1;
    if (retryable && attemptCount <= RETRY_DELAYS_MS.length) {
      const nextAttemptAt = Date.now() + RETRY_DELAYS_MS[attemptCount - 1];
      await ctx.db.patch(job._id, {
        status: "queued",
        attemptCount,
        nextAttemptAt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastErrorKind: args.kind,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(RETRY_DELAYS_MS[attemptCount - 1], runGroundxJobRef, { jobId: job._id });
      return { status: "queued" as const, nextAttemptAt };
    }
    const status: "manual_review" | "failed" = retryable ? "manual_review" : "failed";
    await ctx.db.patch(job._id, {
      status,
      attemptCount,
      nextAttemptAt: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastErrorKind: args.kind,
      updatedAt: Date.now(),
      retentionPending: status === "failed" ? true : undefined,
    });
    if (status === "failed" && job.targetType === "documentVersion") {
      await applyPublicationJobOutcome(ctx, job, "failed", job.processId);
    }
    await auditJob(ctx, job, "failure", status === "manual_review" ? "integration.job_manual_review" : "integration.job_failed");
    return { status, nextAttemptAt: null };
  },
});

export const reconcileStaleJobs = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const candidatesByStatus = await Promise.all(
      (["queued", "running", "waiting_callback"] as const).map(
        async (status) =>
          await ctx.db
            .query("integrationJobs")
            .withIndex("by_status_and_nextAttemptAt", (q) =>
              q.eq("status", status).lte("nextAttemptAt", now),
            )
            .take(MAX_RECONCILE_BATCH + 1),
      ),
    );
    const candidates = candidatesByStatus
      .flat()
      .sort((left, right) =>
        (left.nextAttemptAt ?? 0) - (right.nextAttemptAt ?? 0) ||
        left._creationTime - right._creationTime ||
        left._id.localeCompare(right._id),
      );
    const hasMore =
      candidates.length > MAX_RECONCILE_BATCH ||
      candidatesByStatus.some((rows) => rows.length > MAX_RECONCILE_BATCH);
    let scheduled = 0;
    for (const job of candidates.slice(0, MAX_RECONCILE_BATCH)) {
      const claim = await claimJobDocument(ctx, job, true);
      if (!claim) continue;
      await ctx.scheduler.runAfter(0, runGroundxJobRef, {
        jobId: job._id,
        leaseToken: claim.leaseToken,
      });
      scheduled += 1;
    }
    if (hasMore) {
      await ctx.scheduler.runAfter(0, reconcileStaleJobsRef, {});
    }
    return { scheduled, hasMore };
  },
});

const controlledJobResultValidator = v.object({
  jobId: v.id("integrationJobs"),
  status: jobStatusValidator,
  correlationId: v.string(),
});

function validateOperationKey(value: string): string {
  if (value.length < 8 || value.length > 128 || !SAFE_IDENTIFIER.test(value)) {
    throw new ConvexError("INTEGRATION_IDEMPOTENCY_INVALID");
  }
  return value;
}

async function existingJobControl(
  ctx: MutationCtx,
  actorId: string,
  idempotencyKey: string,
  action: "job_retry" | "job_cancel",
  targetId: string,
  fingerprint: string,
) {
  const rows = await ctx.db
    .query("adminOperations")
    .withIndex("by_actorId_and_idempotencyKey", (q) =>
      q.eq("actorId", actorId).eq("idempotencyKey", idempotencyKey),
    )
    .take(2);
  if (rows.length > 1) throw new ConvexError("ADMIN_IDEMPOTENCY_STATE_INVALID");
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.action !== action || row.targetId !== targetId || row.requestFingerprint !== fingerprint) {
    throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
  }
  if (!row.result) throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
  const stored = await ctx.db.query("jobControlResults").withIndex("by_operationId", (q) => q.eq("operationId", row._id)).unique();
  if (!stored) throw new ConvexError("ADMIN_OPERATION_RESULT_MISSING");
  return { jobId: stored.jobId, status: stored.status, correlationId: stored.correlationId };
}

async function recordJobControl(
  ctx: MutationCtx,
  actor: { userId: string; roles: AdminRole[] },
  input: { action: "job_retry" | "job_cancel"; job: Doc<"integrationJobs">; reason: string; idempotencyKey: string; fingerprint: string; status: Doc<"integrationJobs">["status"] },
) {
  const now = Date.now();
  const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
  const result = { status: "succeeded" as const, correlationId, action: input.action, targetId: input.job._id };
  const operationId = await ctx.db.insert("adminOperations", {
    actorId: actor.userId, action: input.action, targetId: input.job._id,
    idempotencyKey: input.idempotencyKey, requestFingerprint: input.fingerprint,
    correlationId, status: "succeeded", result, createdAt: now, updatedAt: now,
  });
  if (input.status !== "queued" && input.status !== "running" && input.status !== "cancelled") throw new ConvexError("ADMIN_OPERATION_RESULT_INVALID");
  await ctx.db.insert("jobControlResults", { operationId, jobId: input.job._id, status: input.status, correlationId, createdAt: now });
  await writeAudit(ctx, {
    actorId: actor.userId, actorRoles: actor.roles,
    action: input.action === "job_retry" ? "integration.job_retry" : "integration.job_cancel",
    targetType: "integrationJob", targetId: input.job._id, reason: input.reason,
    beforeSummary: JSON.stringify({ status: input.job.status }),
    afterSummary: JSON.stringify({ status: input.status }), correlationId, outcome: "success",
  });
  return { jobId: input.job._id, status: input.status, correlationId };
}

export const retryJob = mutation({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: controlledJobResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "retry");
    const reason = validateAuditReason(args.reason);
    const idempotencyKey = validateOperationKey(args.idempotencyKey);
    const fingerprint = JSON.stringify({ jobId: args.jobId, reason });
    const replay = await existingJobControl(ctx, actor.userId, idempotencyKey, "job_retry", args.jobId, fingerprint);
    if (replay) return replay;
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("Integration job was not found");

    let status: Doc<"integrationJobs">["status"];
    if (job.status === "manual_review") {
      if (!job.processId || !job.lastErrorKind || !["network", "timeout", "rate_limit"].includes(job.lastErrorKind)) {
        throw new ConvexError("Integration job is not retryable");
      }
      const claim = await claimJobDocument(ctx, job, false, true);
      if (!claim) throw new ConvexError("Integration job is not retryable");
      await ctx.scheduler.runAfter(0, runGroundxJobRef, { jobId: job._id, leaseToken: claim.leaseToken });
      status = "running";
    } else if (
      job.status === "failed" &&
      job.processId === undefined &&
      job.leaseToken === undefined &&
      job.targetType !== "documentVersion" &&
      job.lastErrorKind !== undefined &&
      ["network", "timeout", "rate_limit"].includes(job.lastErrorKind)
    ) {
      status = "queued";
      await ctx.db.patch(job._id, {
        status, attemptCount: 0, nextAttemptAt: Date.now(), lastErrorKind: undefined,
        leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, runGroundxJobRef, { jobId: job._id });
    } else {
      throw new ConvexError("Integration job is not retryable");
    }
    return await recordJobControl(ctx, actor, { action: "job_retry", job, reason, idempotencyKey, fingerprint, status });
  },
});

export const cancelJob = mutation({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: controlledJobResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "write");
    const reason = validateAuditReason(args.reason);
    const idempotencyKey = validateOperationKey(args.idempotencyKey);
    const fingerprint = JSON.stringify({ jobId: args.jobId, reason });
    const replay = await existingJobControl(ctx, actor.userId, idempotencyKey, "job_cancel", args.jobId, fingerprint);
    if (replay) return replay;
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("Integration job was not found");
    if (job.processId || job.status === "manual_review" || job.status === "running" || job.status === "waiting_callback") {
      throw new ConvexError("Integration job provider outcome is uncertain");
    }
    if (job.status !== "queued" || job.leaseToken || job.targetType === "documentVersion") {
      throw new ConvexError("Integration job is not cancellable");
    }
    await ctx.db.patch(job._id, { status: "cancelled", nextAttemptAt: undefined, retentionPending: true, updatedAt: Date.now() });
    return await recordJobControl(ctx, actor, { action: "job_cancel", job, reason, idempotencyKey, fingerprint, status: "cancelled" });
  },
});

const jobListRowValidator = v.object({
  id: v.id("integrationJobs"), type: jobTypeValidator, targetType: v.string(), targetId: v.string(),
  status: jobStatusValidator, attemptCount: v.number(), lastErrorKind: v.optional(providerErrorKindValidator),
  correlationId: v.string(), createdAt: v.number(), updatedAt: v.number(),
});

export const listJobs = query({
  args: { paginationOpts: paginationOptsValidator, status: v.optional(jobStatusValidator), type: v.optional(jobTypeValidator) },
  returns: v.object({ page: v.array(jobListRowValidator), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    if (!Number.isInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems < 1) throw new ConvexError("INVALID_ADMIN_PAGINATION");
    const opts = { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50), maximumRowsRead: 51 };
    const base = args.status && args.type
      ? ctx.db.query("integrationJobs").withIndex("by_status_and_type_and_createdAt", (q) => q.eq("status", args.status!).eq("type", args.type!))
      : args.status
        ? ctx.db.query("integrationJobs").withIndex("by_status_and_createdAt", (q) => q.eq("status", args.status!))
        : args.type
          ? ctx.db.query("integrationJobs").withIndex("by_type_and_createdAt", (q) => q.eq("type", args.type!))
          : ctx.db.query("integrationJobs").withIndex("by_createdAt");
    const result = await base.order("desc").paginate(opts);
    return { page: result.page.map((job) => ({ id: job._id, type: job.type, targetType: job.targetType, targetId: job.targetId, status: job.status, attemptCount: job.attemptCount, lastErrorKind: job.lastErrorKind, correlationId: job.correlationId, createdAt: job.createdAt, updatedAt: job.updatedAt })), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
