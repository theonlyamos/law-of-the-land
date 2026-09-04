import { ConvexError, v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import {
  isGeminiDocumentName,
  isGeminiFileSearchStoreName,
  parseGeminiUploadOperationName,
} from "../lib/geminiFileSearchNames";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import {
  applyGeminiDeleteCompletion,
  applyGeminiIndexCompletion,
  applyPublicationJobFailure,
  resolveGeminiPublicationWorkflow,
  transferPublicationLock,
} from "./publicationState";

const MAX_PAYLOAD_BYTES = 8_192;
const MAX_PAYLOAD_DEPTH = 5;
const MAX_PAYLOAD_ENTRIES = 100;
const MAX_PAYLOAD_ARRAY = 100;
const MAX_PAYLOAD_STRING = 10_000;
const MAX_RECONCILE_BATCH = 25;
const JOB_LEASE_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 20 * 60_000] as const;
const GEMINI_POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;
const GEMINI_INDEX_REVIEW_AFTER_MS = 30 * 60_000;
const GEMINI_EMBEDDING_MODEL = "models/gemini-embedding-2" as const;
const PROVIDER_DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_TARGET_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SENSITIVE_KEY = /(?:token|secret|password|passwd|credential|auth(?:entication|orization)?|bearer|cookie|api.?key|signature|private.?key)/i;

const jobTypeValidator = v.union(
  v.literal("gemini_create_store"),
  v.literal("gemini_index_document"),
  v.literal("gemini_delete_document"),
  v.literal("gemini_delete_store"),
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
const providerOperationValidator = v.union(
  v.literal("store_create"),
  v.literal("document_upload"),
  v.literal("operation_poll"),
  v.literal("store_get"),
  v.literal("document_delete"),
  v.literal("store_delete"),
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
  v.literal("waiting_provider"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("manual_review"),
);
const knownStoreResultValidator = v.union(
  v.object({
    kind: v.literal("store_created"),
    storeName: v.string(),
    embeddingModel: v.string(),
  }),
  v.object({ kind: v.literal("store_deleted"), storeName: v.string() }),
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
  providerOperationName: v.optional(v.string()),
  providerPollCount: v.optional(v.number()),
  knownStoreResult: v.optional(knownStoreResultValidator),
  recoveryKind: v.optional(v.union(
    v.literal("poll_operation"),
    v.literal("delete_document"),
    v.literal("delete_store"),
    v.literal("apply_store_result"),
  )),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  status: jobStatusValidator,
  attemptCount: v.number(),
  nextAttemptAt: v.optional(v.number()),
  lastErrorKind: v.optional(providerErrorKindValidator),
  lastProviderOperation: v.optional(providerOperationValidator),
  lastProviderStatus: v.optional(v.number()),
  lastProviderRawResponse: v.optional(v.string()),
  providerDiagnosticExpiresAt: v.optional(v.number()),
  retentionRedactedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const enqueueResultValidator = v.object({
  jobId: v.id("integrationJobs"),
  duplicate: v.boolean(),
});
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

const GEMINI_JOB_TYPES = [
  "gemini_create_store",
  "gemini_index_document",
  "gemini_delete_document",
  "gemini_delete_store",
] as const;
type GeminiJobType = (typeof GEMINI_JOB_TYPES)[number];
type JobType = GeminiJobType;
type GeminiJobStatus = "queued" | "running" | "waiting_provider" | "succeeded" | "failed" | "cancelled" | "manual_review";
type GeminiIntegrationJob = Omit<Doc<"integrationJobs">, "type" | "status"> & {
  type: GeminiJobType;
  status: GeminiJobStatus;
};
type ProviderErrorKind = "invalid_request" | "validation" | "authentication" | "not_found" | "rate_limit" | "timeout" | "network" | "invalid_response" | "provider";
type KnownStoreResult =
  | { kind: "store_created"; storeName: string; embeddingModel: string }
  | { kind: "store_deleted"; storeName: string };
type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

const runGeminiJobRef = makeFunctionReference<"action">("admin/geminiActions:runGeminiJob");
const reconcileStaleJobsRef = makeFunctionReference<"mutation">(
  "admin/jobs:reconcileStaleJobs",
);

function isGeminiJobType(type: Doc<"integrationJobs">["type"]): type is GeminiJobType {
  return type === "gemini_create_store" ||
    type === "gemini_index_document" ||
    type === "gemini_delete_document" ||
    type === "gemini_delete_store";
}

function jobRunner(type: Doc<"integrationJobs">["type"]) {
  if (!isGeminiJobType(type)) throw new ConvexError("INTEGRATION_JOB_NOT_SUPPORTED");
  return runGeminiJobRef;
}

function isGeminiJobDocument(job: Doc<"integrationJobs">): job is GeminiIntegrationJob {
  const currentStatus =
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "waiting_provider" ||
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "manual_review";
  return isGeminiJobType(job.type) && currentStatus;
}

async function geminiJobJurisdiction(
  ctx: MutationCtx | QueryCtx,
  job: GeminiIntegrationJob,
): Promise<Doc<"jurisdictions"> | null> {
  if (job.type === "gemini_create_store" || job.type === "gemini_delete_store") {
    const jurisdictionId = ctx.db.normalizeId("jurisdictions", job.targetId);
    return jurisdictionId ? await ctx.db.get(jurisdictionId) : null;
  }
  const versionId = ctx.db.normalizeId("documentVersions", job.targetId);
  const version = versionId ? await ctx.db.get(versionId) : null;
  const resource = version ? await ctx.db.get(version.resourceId) : null;
  return resource ? await ctx.db.get(resource.jurisdictionId) : null;
}

async function assertGeminiExecutionPermit(
  ctx: MutationCtx | QueryCtx,
  job: GeminiIntegrationJob,
  now: number,
): Promise<Doc<"jurisdictions"> | null> {
  const jurisdiction = await geminiJobJurisdiction(ctx, job);
  if (!jurisdiction) return null;
  const permit = jurisdiction.geminiExecutionPermit;
  if (
    job.leaseExpiresAt === undefined ||
    !permit ||
    permit.jobId !== job._id ||
    permit.leaseExpiresAt !== job.leaseExpiresAt ||
    permit.leaseExpiresAt <= now
  ) {
    throw new ConvexError("GEMINI_EXECUTION_PERMIT_INVALID");
  }
  return jurisdiction;
}

async function releaseGeminiExecutionPermit(
  ctx: MutationCtx,
  job: GeminiIntegrationJob,
  jurisdiction: Doc<"jurisdictions"> | null,
  now: number,
) {
  if (!jurisdiction) return;
  const permit = jurisdiction.geminiExecutionPermit;
  if (
    job.leaseExpiresAt === undefined ||
    !permit ||
    permit.jobId !== job._id ||
    permit.leaseExpiresAt !== job.leaseExpiresAt ||
    permit.leaseExpiresAt <= now
  ) {
    throw new ConvexError("GEMINI_EXECUTION_PERMIT_INVALID");
  }
  await ctx.db.patch(jurisdiction._id, { geminiExecutionPermit: undefined });
}

async function releaseExpiredGeminiExecutionPermit(
  ctx: MutationCtx,
  job: GeminiIntegrationJob,
  now: number,
) {
  const noUnresolvedProviderMutation =
    (job.recoveryKind === "apply_store_result" &&
      job.knownStoreResult !== undefined &&
      knownStoreResultMatchesJob(job, job.knownStoreResult)) ||
    (job.type === "gemini_index_document" && job.providerOperationName !== undefined);
  if (!noUnresolvedProviderMutation) return;
  const jurisdiction = await geminiJobJurisdiction(ctx, job);
  const permit = jurisdiction?.geminiExecutionPermit;
  if (
    jurisdiction &&
    permit &&
    job.leaseExpiresAt !== undefined &&
    permit.jobId === job._id &&
    permit.leaseExpiresAt === job.leaseExpiresAt &&
    permit.leaseExpiresAt <= now
  ) {
    await ctx.db.patch(jurisdiction._id, { geminiExecutionPermit: undefined });
  }
}

function knownStoreResultMatchesJob(
  job: Doc<"integrationJobs">,
  result: KnownStoreResult,
): boolean {
  if (!isGeminiFileSearchStoreName(result.storeName)) return false;
  if (result.kind === "store_created") {
    return job.type === "gemini_create_store" &&
      result.embeddingModel === GEMINI_EMBEDDING_MODEL;
  }
  if (job.type !== "gemini_delete_store") return false;
  try {
    const payload = JSON.parse(job.payload) as { storeName?: unknown };
    return payload.storeName === result.storeName;
  } catch {
    return false;
  }
}

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

export async function hashJobValue(token: string): Promise<string> {
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
    const fingerprint = await hashJobValue(JSON.stringify({ type: args.type, targetType, targetId, payload }));
    const existing = await ctx.db
      .query("integrationJobs")
      .withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actor.id).eq("idempotencyKey", idempotencyKey))
      .take(2);
    if (existing.length > 1) throw new ConvexError("INTEGRATION_IDEMPOTENCY_STATE_INVALID");
    if (existing.length === 1) {
      if (!safeEqual(existing[0].requestFingerprint, fingerprint)) {
        throw new ConvexError("INTEGRATION_IDEMPOTENCY_CONFLICT");
      }
      return {
        jobId: existing[0]._id,
        duplicate: true,
      };
    }

    const now = Date.now();
    const correlationId = `job_${crypto.randomUUID().replaceAll("-", "")}`;
    const jobId = await ctx.db.insert("integrationJobs", {
      type: args.type,
      targetType,
      targetId,
      payload,
      actorId: actor.id,
      actorRoles: actor.roles,
      idempotencyKey,
      requestFingerprint: fingerprint,
      correlationId,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const job = await ctx.db.get(jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    await auditJob(ctx, job, "success", "integration.job_queued");
    await ctx.scheduler.runAfter(0, jobRunner(args.type), { jobId });
    return {
      jobId,
      duplicate: false,
    };
}

const enqueueArgs = {
  type: jobTypeValidator,
  targetType: v.string(),
  targetId: v.string(),
  payload: v.any(),
  idempotencyKey: v.string(),
};

export const enqueueJob = internalMutation({
  args: enqueueArgs,
  returns: enqueueResultValidator,
  handler: async (ctx, args) => {
    return await persistJob(ctx, args as EnqueueInput, { id: "system", roles: [] });
  },
});

export const enqueueSystemJob = internalMutation({
  args: {
    ...enqueueArgs,
    systemActor: v.literal("gemini_orchestrator"),
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

const geminiStoreJobResultValidator = v.object({
  jobId: v.id("integrationJobs"),
  duplicate: v.boolean(),
});

function geminiDisplayName(slug: string): string {
  const environment = process.env.ADMIN_ENVIRONMENT?.trim().toLowerCase();
  if (!environment || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(environment)) {
    throw new ConvexError("ADMIN_ENVIRONMENT_INVALID");
  }
  const displayName = `law-of-the-land-${environment}-${slug}`;
  if (displayName.length > 200) throw new ConvexError("GEMINI_STORE_DISPLAY_NAME_INVALID");
  return displayName;
}

async function activeGeminiStoreJob(
  ctx: MutationCtx,
  jurisdictionId: Id<"jurisdictions">,
  type: "gemini_create_store" | "gemini_delete_store",
) {
  const jobs = await Promise.all(([
    "queued", "running", "waiting_provider", "manual_review",
  ] as const).map(async (status) => await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId_and_type_and_status", (q) => q
      .eq("targetType", "jurisdictionGeminiStore")
      .eq("targetId", jurisdictionId)
      .eq("type", type)
      .eq("status", status))
    .take(1)));
  return jobs.flat()[0];
}

export async function queueGeminiStoreProvision(
  ctx: MutationCtx,
  jurisdiction: Doc<"jurisdictions">,
  actor: { id: string; roles: AdminRole[] },
  idempotencyKey: string,
) {
  if (jurisdiction.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
  if (jurisdiction.geminiFileSearchStoreName !== undefined) {
    throw new ConvexError("GEMINI_STORE_ALREADY_CONFIGURED");
  }
  const active = await activeGeminiStoreJob(ctx, jurisdiction._id, "gemini_create_store");
  if (active) return { jobId: active._id, duplicate: true };

  const queued = await persistJob(ctx, {
    type: "gemini_create_store",
    targetType: "jurisdictionGeminiStore",
    targetId: jurisdiction._id,
    payload: {
      displayName: geminiDisplayName(jurisdiction.slug),
      embeddingModel: GEMINI_EMBEDDING_MODEL,
    },
    idempotencyKey,
  }, actor);
  await ctx.db.patch(jurisdiction._id, {
    geminiEmbeddingModel: GEMINI_EMBEDDING_MODEL,
    providerSyncState: "pending",
    updatedBy: actor.id,
    updatedAt: Date.now(),
  });
  return queued;
}

async function resourceWithActiveVersion(
  ctx: MutationCtx | QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
) {
  return await ctx.db
    .query("legalResources")
    .withIndex("by_jurisdictionId_and_activeVersionId", (q) =>
      q.eq("jurisdictionId", jurisdictionId).gt("activeVersionId", undefined),
    )
    .first();
}

export const provisionJurisdictionGeminiStore = mutation({
  args: {
    jurisdictionId: v.id("jurisdictions"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: geminiStoreJobResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const jurisdiction = await ctx.db.get(args.jurisdictionId);
    if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
    const queued = await queueGeminiStoreProvision(
      ctx,
      jurisdiction,
      { id: actor.userId, roles: actor.roles },
      args.idempotencyKey,
    );
    if (queued.duplicate) return queued;
    const job = await ctx.db.get(queued.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "jurisdiction.gemini_store.provision_queued",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      reason,
      correlationId: job.correlationId,
      outcome: "success",
    });
    return queued;
  },
});

async function consumeJurisdictionStoreStepUp(
  ctx: MutationCtx,
  actorId: string,
  sessionId: string,
  jurisdictionId: Id<"jurisdictions">,
  idempotencyKey: string,
) {
  const proofs = await ctx.db
    .query("adminStepUpProofs")
    .withIndex("by_actorId_sessionId_action_targetId_idempotencyKey", (q) => q
      .eq("actorId", actorId)
      .eq("sessionId", sessionId)
      .eq("action", "jurisdiction_store_delete")
      .eq("targetId", jurisdictionId)
      .eq("idempotencyKey", idempotencyKey))
    .take(2);
  if (
    proofs.length !== 1 ||
    proofs[0].consumedAt !== undefined ||
    proofs[0].expiresAt <= Date.now() ||
    Date.now() - proofs[0].issuedAt > 5 * 60_000
  ) {
    throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  }
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
}

export const deleteJurisdictionGeminiStore = mutation({
  args: {
    jurisdictionId: v.id("jurisdictions"),
    reason: v.string(),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: geminiStoreJobResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== actor.userId || typeof identity.sessionId !== "string") {
      throw new ConvexError("ADMIN_AUTH_REQUIRED");
    }
    const reason = validateAuditReason(args.reason);
    const jurisdiction = await ctx.db.get(args.jurisdictionId);
    if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
    if (jurisdiction.status === "enabled") throw new ConvexError("JURISDICTION_MUST_BE_DISABLED");
    if (args.confirmation !== `DELETE GEMINI STORE ${jurisdiction.slug}`) {
      throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
    }
    const storeName = jurisdiction.geminiFileSearchStoreName;
    if (!storeName || !isGeminiFileSearchStoreName(storeName)) {
      throw new ConvexError("GEMINI_STORE_NOT_CONFIGURED");
    }
    const activeResource = await resourceWithActiveVersion(ctx, jurisdiction._id);
    if (activeResource) throw new ConvexError("JURISDICTION_HAS_ACTIVE_PUBLISHED_RESOURCE");
    if (jurisdiction.geminiExecutionPermit) throw new ConvexError("GEMINI_EXECUTION_BUSY");
    const references = await ctx.db
      .query("jurisdictions")
      .withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", storeName))
      .take(2);
    if (references.some((row) => row._id !== jurisdiction._id) || references.length !== 1) {
      throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
    }
    const active = await activeGeminiStoreJob(ctx, jurisdiction._id, "gemini_delete_store");
    if (active) return { jobId: active._id, duplicate: true };
    await consumeJurisdictionStoreStepUp(
      ctx,
      actor.userId,
      identity.sessionId,
      jurisdiction._id,
      args.idempotencyKey,
    );
    const queued = await persistJob(ctx, {
      type: "gemini_delete_store",
      targetType: "jurisdictionGeminiStore",
      targetId: jurisdiction._id,
      payload: { storeName, reasonDigest: await hashJobValue(reason) },
      idempotencyKey: args.idempotencyKey,
    }, { id: actor.userId, roles: actor.roles });
    const job = await ctx.db.get(queued.jobId);
    if (!job) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    await ctx.db.patch(jurisdiction._id, {
      providerSyncState: "drifted",
      updatedBy: actor.userId,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "jurisdiction.gemini_store.delete_queued",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      reason,
      correlationId: job.correlationId,
      outcome: "success",
    });
    return queued;
  },
});

const geminiTargetValidator = v.union(
  v.object({
    kind: v.literal("create_store"),
    displayName: v.string(),
    embeddingModel: v.literal("models/gemini-embedding-2"),
  }),
  v.object({
    kind: v.literal("index_document"),
    signedUrl: v.optional(v.string()),
    byteSize: v.number(),
    storeName: v.string(),
    mimeType: v.string(),
    displayName: v.string(),
    customMetadata: v.array(v.object({ key: v.string(), stringValue: v.string() })),
  }),
  v.object({ kind: v.literal("delete_document"), documentName: v.string() }),
  v.object({ kind: v.literal("delete_store"), storeName: v.string() }),
);

function storedSha256Hex(value: string): string {
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("invalid digest length");
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ConvexError("DOCUMENT_STORAGE_CHECKSUM_INVALID");
  }
}

async function assertNoActiveGeminiStoreTeardown(
  ctx: MutationCtx | QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
) {
  const jobs = await Promise.all(([
    "queued", "running", "waiting_provider", "manual_review",
  ] as const).map(async (status) => await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId_and_type_and_status", (q) => q
      .eq("targetType", "jurisdictionGeminiStore")
      .eq("targetId", jurisdictionId)
      .eq("type", "gemini_delete_store")
      .eq("status", status))
    .take(1)));
  if (jobs.some((rows) => rows.length > 0)) {
    throw new ConvexError("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
  }
}

export const getGeminiJobTarget = internalQuery({
  args: { jobId: v.id("integrationJobs"), leaseToken: v.string() },
  returns: v.union(v.null(), geminiTargetValidator),
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.leaseToken === undefined ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= now ||
      !safeEqual(job.leaseToken, args.leaseToken)
    ) return null;
    if (!isGeminiJobDocument(job)) return null;
    const executionJurisdiction = await assertGeminiExecutionPermit(ctx, job, now);
    if (job.type === "gemini_create_store") {
      if (!executionJurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
      let payload: { displayName?: unknown; embeddingModel?: unknown };
      try { payload = JSON.parse(job.payload) as typeof payload; }
      catch { throw new ConvexError("INTEGRATION_PAYLOAD_INVALID"); }
      if (
        typeof payload.displayName !== "string" ||
        payload.embeddingModel !== GEMINI_EMBEDDING_MODEL
      ) throw new ConvexError("INTEGRATION_PAYLOAD_INVALID");
      return { kind: "create_store" as const, displayName: payload.displayName, embeddingModel: GEMINI_EMBEDDING_MODEL };
    }
    if (job.type === "gemini_delete_store") {
      const jurisdiction = executionJurisdiction;
      let payload: { storeName?: unknown };
      try { payload = JSON.parse(job.payload) as typeof payload; } catch { throw new ConvexError("INTEGRATION_PAYLOAD_INVALID"); }
      const boundStore = typeof payload.storeName === "string" ? payload.storeName : undefined;
      const activeResource = jurisdiction
        ? await resourceWithActiveVersion(ctx, jurisdiction._id)
        : null;
      const references = boundStore && isGeminiFileSearchStoreName(boundStore)
        ? await ctx.db.query("jurisdictions").withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", boundStore)).take(2)
        : [];
      if (!jurisdiction || jurisdiction.status === "enabled" || jurisdiction.providerSyncState !== "drifted" || activeResource || !boundStore || jurisdiction.geminiFileSearchStoreName !== boundStore || references.length !== 1 || references[0]._id !== jurisdiction._id) throw new ConvexError("GEMINI_STORE_DELETE_PRECONDITION_FAILED");
      return { kind: "delete_store" as const, storeName: boundStore };
    }
    const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", permitDrift: true }, now);
    if (workflow.kind === "delete") return { kind: "delete_document" as const, documentName: workflow.payload.documentName };
    const metadata = await ctx.db.system.get("_storage", workflow.version.originalStorageId);
    if (!metadata || metadata.size !== workflow.version.byteSize || storedSha256Hex(metadata.sha256) !== workflow.version.sha256) throw new ConvexError("DOCUMENT_ORIGINAL_INVALID");
    const environment = process.env.ADMIN_ENVIRONMENT?.trim();
    if (!environment || environment.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) throw new ConvexError("ADMIN_ENVIRONMENT_INVALID");
    let signedUrl: string | undefined;
    if (job.providerOperationName === undefined) {
      const issuedUrl = await ctx.storage.getUrl(workflow.version.originalStorageId);
      if (!issuedUrl) throw new ConvexError("DOCUMENT_ORIGINAL_NOT_FOUND");
      signedUrl = issuedUrl;
    }
    return {
      kind: "index_document" as const,
      ...(signedUrl === undefined ? {} : { signedUrl }),
      byteSize: workflow.version.byteSize,
      storeName: workflow.storeName,
      mimeType: workflow.version.mimeType,
      displayName: workflow.version.filename,
      customMetadata: [
        { key: "environment", stringValue: environment },
        { key: "jurisdiction_id", stringValue: workflow.jurisdiction._id },
        { key: "resource_id", stringValue: workflow.resource._id },
        { key: "version_id", stringValue: workflow.version._id },
        { key: "version_number", stringValue: String(workflow.version.versionNumber) },
        { key: "sha256", stringValue: workflow.version.sha256 },
      ],
    };
  },
});

const geminiProviderResultValidator = v.union(
  v.object({ kind: v.literal("store_created"), storeName: v.string(), embeddingModel: v.string() }),
  v.object({ kind: v.literal("index_accepted"), operationName: v.string() }),
  v.object({ kind: v.literal("index_pending") }),
  v.object({ kind: v.literal("index_completed"), documentName: v.string() }),
  v.object({ kind: v.literal("index_failed"), errorKind: providerErrorKindValidator }),
  v.object({ kind: v.literal("document_deleted") }),
  v.object({ kind: v.literal("store_deleted"), storeName: v.string() }),
);

async function markGeminiJurisdictionDrifted(ctx: MutationCtx, job: Doc<"integrationJobs">) {
  if (job.type === "gemini_create_store" || job.type === "gemini_delete_store") {
    const jurisdiction = await ctx.db.get(job.targetId as Id<"jurisdictions">);
    if (jurisdiction) await ctx.db.patch(jurisdiction._id, { providerSyncState: "drifted", updatedAt: Date.now() });
    return;
  }
  const version = await ctx.db.get(job.targetId as Id<"documentVersions">);
  const manualReviewSummary = "Gemini did not confirm the index update within 30 minutes. Search is paused until an administrator reviews the job.";
  if (version && job.type === "gemini_index_document") {
    await ctx.db.patch(version._id, { failureSummary: manualReviewSummary, updatedAt: Date.now() });
  } else if (version && job.type === "gemini_delete_document") {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(job.payload) as Record<string, unknown>; }
    catch { throw new ConvexError("INTEGRATION_PAYLOAD_INVALID"); }
    if (payload.operation === "unpublish" && payload.documentName === version.geminiDocumentName) {
      await ctx.db.patch(version._id, { failureSummary: manualReviewSummary, updatedAt: Date.now() });
    } else if (payload.operation === "replace_delete" && typeof payload.candidateVersionId === "string" && payload.previousVersionId === version._id && payload.documentName === version.geminiDocumentName) {
      const candidate = await ctx.db.get(payload.candidateVersionId as Id<"documentVersions">);
      const locks = await ctx.db.query("documentLifecycleLocks").withIndex("by_resourceId", (q) => q.eq("resourceId", version.resourceId)).take(2);
      if (!candidate || candidate.resourceId !== version.resourceId || candidate.status !== "publishing" || locks.length !== 1 || locks[0].jobId !== job._id) throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
      await ctx.db.patch(candidate._id, { failureSummary: manualReviewSummary, updatedAt: Date.now() });
    } else {
      throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
    }
  }
  const resource = version ? await ctx.db.get(version.resourceId) : null;
  const jurisdiction = resource ? await ctx.db.get(resource.jurisdictionId) : null;
  if (jurisdiction) await ctx.db.patch(jurisdiction._id, { providerSyncState: "drifted", updatedAt: Date.now() });
}

async function succeedGeminiJob(
  ctx: MutationCtx,
  job: GeminiIntegrationJob,
  executionJurisdiction: Doc<"jurisdictions"> | null,
  now: number,
) {
  await ctx.db.patch(job._id, {
    status: "succeeded",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    lastErrorKind: undefined,
    lastProviderOperation: undefined,
    lastProviderStatus: undefined,
    lastProviderRawResponse: undefined,
    providerDiagnosticExpiresAt: undefined,
    recoveryKind: undefined,
    knownStoreResult: undefined,
    updatedAt: now,
    retentionPending: true,
  });
  await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
  await auditJob(ctx, job, "success", "integration.job_succeeded");
}

export const applyGeminiProviderResult = internalMutation({
  args: {
    jobId: v.id("integrationJobs"),
    leaseToken: v.string(),
    result: geminiProviderResultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !isGeminiJobDocument(job)) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    const now = Date.now();
    assertCurrentLease(job, args.leaseToken, now);
    const executionJurisdiction = await assertGeminiExecutionPermit(ctx, job, now);
    if (args.result.kind === "store_created") {
      const storeName = args.result.storeName;
      if (job.type !== "gemini_create_store" || !isGeminiFileSearchStoreName(storeName) || args.result.embeddingModel !== GEMINI_EMBEDDING_MODEL) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      const jurisdiction = executionJurisdiction;
      if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
      const references = await ctx.db.query("jurisdictions")
        .withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", storeName))
        .take(2);
      if (references.some((row) => row._id !== jurisdiction._id)) throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
      if (jurisdiction.geminiFileSearchStoreName && jurisdiction.geminiFileSearchStoreName !== storeName) {
        throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
      }
      await ctx.db.patch(jurisdiction._id, {
        geminiFileSearchStoreName: storeName,
        geminiEmbeddingModel: GEMINI_EMBEDDING_MODEL,
        providerSyncState: "synced",
        updatedBy: job.actorId,
        updatedAt: now,
      });
      await succeedGeminiJob(ctx, job, executionJurisdiction, now);
      return null;
    }
    if (args.result.kind === "store_deleted") {
      const storeName = args.result.storeName;
      if (job.type !== "gemini_delete_store" || !isGeminiFileSearchStoreName(storeName)) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      const jurisdiction = executionJurisdiction;
      let payload: { storeName?: unknown };
      try { payload = JSON.parse(job.payload) as typeof payload; }
      catch { throw new ConvexError("INTEGRATION_PAYLOAD_INVALID"); }
      const boundStore = typeof payload.storeName === "string" ? payload.storeName : undefined;
      if (!boundStore || boundStore !== storeName || !jurisdiction || jurisdiction.geminiFileSearchStoreName !== boundStore) {
        throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
      }
      const references = await ctx.db.query("jurisdictions")
        .withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", storeName))
        .take(2);
      if (references.length !== 1 || references[0]._id !== jurisdiction._id) {
        throw new ConvexError("GEMINI_STORE_OWNERSHIP_INVALID");
      }
      await ctx.db.patch(jurisdiction._id, {
        geminiFileSearchStoreName: undefined,
        geminiEmbeddingModel: undefined,
        providerSyncState: "pending",
        updatedBy: job.actorId,
        updatedAt: now,
      });
      await succeedGeminiJob(ctx, job, executionJurisdiction, now);
      return null;
    }
    if (args.result.kind === "document_deleted") {
      if (job.type !== "gemini_delete_document") throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      await applyGeminiDeleteCompletion(ctx, job, now);
      await succeedGeminiJob(ctx, job, executionJurisdiction, now);
      return null;
    }
    if (args.result.kind === "index_accepted") {
      if (job.type !== "gemini_index_document" || parseGeminiUploadOperationName(args.result.operationName) === null || job.providerOperationName !== undefined) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", pendingOperationName: args.result.operationName, permitDrift: true }, now);
      if (workflow.kind !== "index") throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      const nextAttemptAt = now + GEMINI_POLL_DELAYS_MS[0];
      await ctx.db.patch(job._id, {
        providerOperationName: args.result.operationName,
        providerPollCount: 0,
        recoveryKind: "poll_operation",
        status: "waiting_provider",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt,
        updatedAt: now,
      });
      await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
      await ctx.scheduler.runAfter(GEMINI_POLL_DELAYS_MS[0], runGeminiJobRef, { jobId: job._id });
      return null;
    }
    if (args.result.kind === "index_pending") {
      if (job.type !== "gemini_index_document" || !job.providerOperationName) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", permitDrift: true }, now);
      if (workflow.kind !== "index") throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      if (now - job.createdAt >= GEMINI_INDEX_REVIEW_AFTER_MS) {
        await ctx.db.patch(job._id, {
          status: "manual_review",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastErrorKind: "timeout",
          updatedAt: now,
        });
        await markGeminiJurisdictionDrifted(ctx, job);
        await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
        await auditJob(ctx, job, "failure", "integration.job_manual_review");
        return null;
      }
      const pollCount = job.providerPollCount ?? 0;
      const delay = GEMINI_POLL_DELAYS_MS[Math.min(pollCount + 1, GEMINI_POLL_DELAYS_MS.length - 1)];
      await ctx.db.patch(job._id, {
        providerPollCount: pollCount + 1,
        status: "waiting_provider",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: now + delay,
        updatedAt: now,
      });
      await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
      await ctx.scheduler.runAfter(delay, runGeminiJobRef, { jobId: job._id });
      return null;
    }
    if (args.result.kind === "index_failed") {
      if (job.type !== "gemini_index_document" || !job.providerOperationName || job.recoveryKind !== "poll_operation") {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      await applyPublicationJobFailure(ctx, job, now);
      await ctx.db.patch(job._id, {
        status: "failed",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        lastErrorKind: args.result.errorKind,
        recoveryKind: undefined,
        updatedAt: now,
        retentionPending: true,
      });
      await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
      await auditJob(ctx, job, "failure", "integration.job_failed");
      return null;
    }
    if (job.type !== "gemini_index_document" || !isGeminiDocumentName(args.result.documentName)) {
      throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
    }
    const replacement = await applyGeminiIndexCompletion(ctx, job, args.result.documentName, now);
    if (replacement) {
      const queued = await persistJob(ctx, {
        type: "gemini_delete_document",
        targetType: "documentVersion",
        targetId: replacement.previousVersionId,
        payload: replacement.payload,
        idempotencyKey: `replace-delete-${job._id}`,
      }, { id: job.actorId, roles: job.actorRoles });
      await transferPublicationLock(ctx, job, queued.jobId, args.result.documentName, now);
    }
    await succeedGeminiJob(ctx, job, executionJurisdiction, now);
    return null;
  },
});

export const getJobForRun = internalQuery({
  args: { jobId: v.id("integrationJobs"), leaseToken: v.string() },
  returns: v.union(v.null(), jobDocumentValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      !isGeminiJobDocument(job) ||
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

async function unstartedPublicationBlockedByDrift(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
  now: number,
) {
  if (
    job.targetType !== "documentVersion" ||
    (job.type !== "gemini_index_document" && job.type !== "gemini_delete_document") ||
    job.providerOperationName !== undefined ||
    job.recoveryKind !== undefined
  ) return false;
  try {
    await resolveGeminiPublicationWorkflow(ctx, job, { kind: "defer_unstarted" }, now);
    return true;
  } catch {
    return false;
  }
}

async function deferPublicationJobForDrift(
  ctx: MutationCtx,
  job: GeminiIntegrationJob,
  now: number,
) {
  const delay = RETRY_DELAYS_MS[0];
  await ctx.db.patch(job._id, {
    status: "queued",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: now + delay,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(delay, jobRunner(job.type), { jobId: job._id });
}

async function deferJobForExecutionPermit(
  ctx: MutationCtx,
  job: GeminiIntegrationJob,
  now: number,
) {
  if (job.status !== "queued" && job.status !== "waiting_provider") {
    throw new ConvexError("GEMINI_EXECUTION_BUSY");
  }
  const delay = RETRY_DELAYS_MS[0];
  await ctx.db.patch(job._id, { nextAttemptAt: now + delay, updatedAt: now });
  await ctx.scheduler.runAfter(delay, jobRunner(job.type), { jobId: job._id });
}

async function claimJobDocument(
  ctx: MutationCtx,
  job: Doc<"integrationJobs">,
  allowStaleRunning = false,
  allowUncertainManualReview = false,
) {
  if (!isGeminiJobDocument(job)) return null;
  if (
      job.status !== "queued" &&
      job.status !== "waiting_provider" &&
      !(allowStaleRunning && job.status === "running") &&
      !(allowUncertainManualReview && job.status === "manual_review")
    ) {
      return null;
    }
    const now = Date.now();
    if (job.nextAttemptAt !== undefined && job.nextAttemptAt > now) {
      return null;
    }
    if (job.status === "queued" && await unstartedPublicationBlockedByDrift(ctx, job, now)) {
      await deferPublicationJobForDrift(ctx, job, now);
      return null;
    }
    const leaseToken = `lease_${crypto.randomUUID().replaceAll("-", "")}`;
    const leaseExpiresAt = now + JOB_LEASE_MS;
    const jurisdiction = await geminiJobJurisdiction(ctx, job);
    const retainedDeleteRecovery =
      jurisdiction?.geminiExecutionPermit?.jobId === job._id &&
      allowUncertainManualReview &&
      ((job.type === "gemini_delete_document" && job.recoveryKind === "delete_document") ||
        (job.type === "gemini_delete_store" && job.recoveryKind === "delete_store"));
    if (jurisdiction?.geminiExecutionPermit && !retainedDeleteRecovery) {
      if (allowUncertainManualReview) throw new ConvexError("GEMINI_EXECUTION_BUSY");
      await deferJobForExecutionPermit(ctx, job, now);
      return null;
    }
    const claimedJob: GeminiIntegrationJob = {
      ...job,
      status: "running",
      leaseToken,
      leaseExpiresAt,
      nextAttemptAt: leaseExpiresAt,
      updatedAt: now,
    };
    if (jurisdiction) {
      await ctx.db.patch(jurisdiction._id, {
        geminiExecutionPermit: { jobId: job._id, leaseExpiresAt },
      });
    }
    await ctx.db.patch(job._id, {
      status: "running",
      leaseToken,
      leaseExpiresAt,
      nextAttemptAt: leaseExpiresAt,
      updatedAt: now,
    });
    return {
      leaseToken,
      workKind: (job.providerOperationName === undefined ? "execute" : "poll") as
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

export const deferUnstartedPublicationJob = internalMutation({
  args: { jobId: v.id("integrationJobs"), leaseToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      !isGeminiJobDocument(job) ||
      job.status !== "running" ||
      job.leaseToken === undefined ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= now ||
      !safeEqual(job.leaseToken, args.leaseToken) ||
      !(await unstartedPublicationBlockedByDrift(ctx, job, now))
    ) return false;
    const executionJurisdiction = await assertGeminiExecutionPermit(ctx, job, now);
    await deferPublicationJobForDrift(ctx, job, now);
    await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
    return true;
  },
});

export const reconcileManualReviewJob = internalMutation({
  args: { jobId: v.id("integrationJobs") },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    let geminiRecovery = job?.recoveryKind === "apply_store_result" &&
      job.knownStoreResult !== undefined &&
      knownStoreResultMatchesJob(job, job.knownStoreResult);
    if (!geminiRecovery && (job?.type === "gemini_index_document" || job?.type === "gemini_delete_document")) {
      try {
        const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
        geminiRecovery = workflow.kind === "index"
          ? job.recoveryKind === "poll_operation" && job.providerOperationName !== undefined
          : job.recoveryKind === "delete_document";
      } catch { geminiRecovery = false; }
    }
    if (!geminiRecovery && job?.type === "gemini_delete_store") {
      geminiRecovery = job.recoveryKind === "delete_store";
    }
    if (
      !job ||
      job.status !== "manual_review" ||
      !geminiRecovery
    ) {
      return null;
    }
    const claim = await claimJobDocument(ctx, job, false, true);
    if (claim) {
      await ctx.scheduler.runAfter(0, jobRunner(job.type), {
        jobId: job._id,
        leaseToken: claim.leaseToken,
      });
    }
    return claim;
  },
});

function assertCurrentLease(job: Doc<"integrationJobs">, leaseToken: string, now = Date.now()) {
  if (
    job.status !== "running" ||
    job.leaseToken === undefined ||
    job.leaseExpiresAt === undefined ||
    job.leaseExpiresAt <= now ||
    !safeEqual(job.leaseToken, leaseToken)
  ) {
    throw new ConvexError("INTEGRATION_LEASE_INVALID");
  }
}

export const recordProviderFailure = internalMutation({
  args: {
    jobId: v.id("integrationJobs"),
    leaseToken: v.string(),
    kind: providerErrorKindValidator,
    retryable: v.optional(v.boolean()),
    sideEffectUncertain: v.optional(v.boolean()),
    providerOperation: v.optional(providerOperationValidator),
    providerStatus: v.optional(v.number()),
    providerRawResponse: v.optional(v.string()),
    providerOperationName: v.optional(v.string()),
    knownStoreResult: v.optional(knownStoreResultValidator),
  },
  returns: failureResultValidator,
  handler: async (ctx, args) => {
    const storedJob = await ctx.db.get(args.jobId);
    if (!storedJob || !isGeminiJobDocument(storedJob)) throw new ConvexError("INTEGRATION_JOB_NOT_FOUND");
    let job: GeminiIntegrationJob = storedJob;
    const now = Date.now();
    assertCurrentLease(job, args.leaseToken, now);
    const executionJurisdiction = await assertGeminiExecutionPermit(ctx, job, now);
    if (
      (args.providerOperation === undefined) !== (args.providerStatus === undefined)
      || (args.providerStatus !== undefined && (
        !Number.isInteger(args.providerStatus)
        || args.providerStatus < 100
        || args.providerStatus > 599
      ))
    ) {
      throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
    }
    const providerDiagnostic = args.providerOperation === undefined
      ? {
          lastProviderOperation: undefined,
          lastProviderStatus: undefined,
          lastProviderRawResponse: args.providerRawResponse,
          providerDiagnosticExpiresAt: args.providerRawResponse === undefined
            ? undefined
            : now + PROVIDER_DIAGNOSTIC_RETENTION_MS,
        }
      : {
          lastProviderOperation: args.providerOperation,
          lastProviderStatus: args.providerStatus,
          lastProviderRawResponse: args.providerRawResponse,
          providerDiagnosticExpiresAt: args.providerRawResponse === undefined
            ? undefined
            : now + PROVIDER_DIAGNOSTIC_RETENTION_MS,
        };
    if (args.providerOperationName !== undefined) {
      if (job.type !== "gemini_index_document" || job.providerOperationName !== undefined) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", pendingOperationName: args.providerOperationName, permitDrift: true }, now);
      if (workflow.kind !== "index") throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      await ctx.db.patch(job._id, {
        providerOperationName: args.providerOperationName,
        providerPollCount: 0,
        recoveryKind: "poll_operation",
        updatedAt: now,
      });
      job = { ...job, providerOperationName: args.providerOperationName, providerPollCount: 0, recoveryKind: "poll_operation" };
    }
    if (args.knownStoreResult !== undefined) {
      if (
        args.sideEffectUncertain !== true ||
        !knownStoreResultMatchesJob(job, args.knownStoreResult)
      ) {
        throw new ConvexError("GEMINI_PROVIDER_RESULT_INVALID");
      }
      await ctx.db.patch(job._id, {
        knownStoreResult: args.knownStoreResult,
        recoveryKind: "apply_store_result",
        updatedAt: now,
      });
      job = {
        ...job,
        knownStoreResult: args.knownStoreResult,
        recoveryKind: "apply_store_result",
      };
    }
    if (job.type === "gemini_delete_document" && args.sideEffectUncertain === true && job.recoveryKind === undefined) {
      const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", permitDrift: true }, now);
      if (workflow.kind !== "delete") throw new ConvexError("DOCUMENT_PUBLICATION_STATE_INVALID");
      await ctx.db.patch(job._id, { recoveryKind: "delete_document", updatedAt: now });
      job = { ...job, recoveryKind: "delete_document" };
    }
    if (job.type === "gemini_delete_store" && args.sideEffectUncertain === true && job.recoveryKind === undefined) {
      await ctx.db.patch(job._id, { recoveryKind: "delete_store", updatedAt: now });
      job = { ...job, recoveryKind: "delete_store" };
    }
    let replacementDeleteWorkflow = false;
    if (job.type === "gemini_index_document" || job.type === "gemini_delete_document") {
      const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active", permitDrift: true }, now);
      replacementDeleteWorkflow = workflow.kind === "delete" && workflow.payload.operation === "replace_delete";
    }
    const retryable = args.retryable ?? ["rate_limit", "timeout", "network"].includes(args.kind);
    const ambiguousSideEffect = args.sideEffectUncertain ?? (
      job.providerOperationName === undefined &&
      ["gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store"].includes(job.type) &&
      ["timeout", "network"].includes(args.kind)
    );
    const attemptCount = job.attemptCount + 1;
    if (!ambiguousSideEffect && retryable && attemptCount <= RETRY_DELAYS_MS.length) {
      const nextAttemptAt = now + RETRY_DELAYS_MS[attemptCount - 1];
      await ctx.db.patch(job._id, {
        status: "queued",
        attemptCount,
        nextAttemptAt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastErrorKind: args.kind,
        ...providerDiagnostic,
        updatedAt: now,
      });
      await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
      await ctx.scheduler.runAfter(RETRY_DELAYS_MS[attemptCount - 1], jobRunner(job.type), { jobId: job._id });
      return { status: "queued" as const, nextAttemptAt };
    }
    const pollObservationUncertain = job.type === "gemini_index_document" && job.recoveryKind === "poll_operation";
    const status: "manual_review" | "failed" = (pollObservationUncertain || replacementDeleteWorkflow || ambiguousSideEffect) ? "manual_review" : "failed";
    await ctx.db.patch(job._id, {
      status,
      attemptCount,
      nextAttemptAt: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastErrorKind: args.kind,
      ...providerDiagnostic,
      recoveryKind: status === "failed" ? undefined : replacementDeleteWorkflow ? "delete_document" : job.recoveryKind,
      knownStoreResult: status === "failed" ? undefined : job.knownStoreResult,
      updatedAt: now,
      retentionPending: status === "failed" ? true : undefined,
    });
    if (status === "failed" && job.targetType === "documentVersion") {
      await applyPublicationJobFailure(ctx, job, now);
    }
    if (status === "manual_review") {
      await markGeminiJurisdictionDrifted(ctx, job);
    }
    if (status === "failed" && job.type === "gemini_create_store") {
      const jurisdiction = await ctx.db.get(job.targetId as Id<"jurisdictions">);
      if (jurisdiction) await ctx.db.patch(jurisdiction._id, { providerSyncState: "failed", updatedAt: now });
    }
    const unresolvedProviderMutation = ambiguousSideEffect &&
      job.providerOperationName === undefined &&
      job.knownStoreResult === undefined;
    if (!unresolvedProviderMutation) {
      await releaseGeminiExecutionPermit(ctx, job, executionJurisdiction, now);
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
    const candidatesByStatusAndType = await Promise.all(
      (["queued", "running", "waiting_provider"] as const).flatMap((status) =>
        GEMINI_JOB_TYPES.map(
          async (type) =>
          await ctx.db
            .query("integrationJobs")
            .withIndex("by_status_and_type_and_nextAttemptAt", (q) =>
              q.eq("status", status).eq("type", type).lte("nextAttemptAt", now),
            )
            .take(MAX_RECONCILE_BATCH + 1),
        ),
      ),
    );
    const candidates = candidatesByStatusAndType
      .flat()
      .sort((left, right) =>
        (left.nextAttemptAt ?? 0) - (right.nextAttemptAt ?? 0) ||
        left._creationTime - right._creationTime ||
        left._id.localeCompare(right._id),
      );
    const hasMore =
      candidates.length > MAX_RECONCILE_BATCH ||
      candidatesByStatusAndType.some((rows) => rows.length > MAX_RECONCILE_BATCH);
    let scheduled = 0;
    for (const job of candidates.slice(0, MAX_RECONCILE_BATCH)) {
      if (!isGeminiJobDocument(job)) continue;
      if (
        (job.type === "gemini_index_document" || job.type === "gemini_delete_document") &&
        job.status === "running"
      ) {
        const staleLease = job.leaseToken !== undefined &&
          job.leaseExpiresAt !== undefined &&
          Number.isFinite(job.leaseExpiresAt) &&
          job.leaseExpiresAt <= now;
        if (!staleLease) continue;
        let recoveryKind: "poll_operation" | "delete_document" | undefined;
        try {
          const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "stale_reconciliation" }, now);
          recoveryKind = workflow.kind === "index"
            ? job.providerOperationName === undefined ? undefined : "poll_operation"
            : "delete_document";
        } catch {
          await ctx.db.patch(job._id, {
            status: "manual_review",
            leaseToken: undefined,
            leaseExpiresAt: undefined,
            nextAttemptAt: undefined,
            lastErrorKind: "invalid_response",
            recoveryKind: undefined,
            updatedAt: now,
          });
          await releaseExpiredGeminiExecutionPermit(ctx, job, now);
          await auditJob(ctx, job, "failure", "integration.job_manual_review");
          continue;
        }
        await ctx.db.patch(job._id, {
          status: "manual_review",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastErrorKind: "timeout",
          recoveryKind,
          updatedAt: now,
        });
        await markGeminiJurisdictionDrifted(ctx, job);
        await releaseExpiredGeminiExecutionPermit(ctx, job, now);
        await auditJob(ctx, job, "failure", "integration.job_manual_review");
        continue;
      }
      if (
        job.status === "running" &&
        job.providerOperationName === undefined
      ) {
        const recoveryKind = job.recoveryKind === "apply_store_result" &&
          job.knownStoreResult !== undefined &&
          knownStoreResultMatchesJob(job, job.knownStoreResult)
          ? "apply_store_result" as const
          : undefined;
        await ctx.db.patch(job._id, {
          status: "manual_review",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastErrorKind: "timeout",
          recoveryKind,
          updatedAt: now,
        });
        await markGeminiJurisdictionDrifted(ctx, job);
        await releaseExpiredGeminiExecutionPermit(ctx, job, now);
        await auditJob(ctx, job, "failure", "integration.job_manual_review");
        continue;
      }
      const claim = await claimJobDocument(ctx, job, true);
      if (!claim) continue;
      await ctx.scheduler.runAfter(0, jobRunner(job.type), {
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
    const now = Date.now();
    const actor = await requireEnabledAdminPermission(ctx, "operations", "retry");
    const reason = validateAuditReason(args.reason);
    const idempotencyKey = validateOperationKey(args.idempotencyKey);
    const fingerprint = JSON.stringify({ jobId: args.jobId, reason });
    const replay = await existingJobControl(ctx, actor.userId, idempotencyKey, "job_retry", args.jobId, fingerprint);
    if (replay) return replay;
    const job = await ctx.db.get(args.jobId);
    if (!job || !isGeminiJobDocument(job)) throw new ConvexError("Integration job was not found");

    let status: Doc<"integrationJobs">["status"];
    if (job.status === "manual_review") {
      let hasGeminiRecoveryTarget = job.recoveryKind === "apply_store_result" &&
        job.knownStoreResult !== undefined &&
        knownStoreResultMatchesJob(job, job.knownStoreResult);
      if (!hasGeminiRecoveryTarget && (job.type === "gemini_index_document" || job.type === "gemini_delete_document")) {
        try {
          const workflow = await resolveGeminiPublicationWorkflow(ctx, job, { kind: "active" }, now);
          hasGeminiRecoveryTarget = workflow.kind === "index"
            ? job.recoveryKind === "poll_operation" && job.providerOperationName !== undefined
            : job.recoveryKind === "delete_document";
        } catch { hasGeminiRecoveryTarget = false; }
      }
      if (!hasGeminiRecoveryTarget && job.type === "gemini_delete_store") {
        hasGeminiRecoveryTarget = job.recoveryKind === "delete_store";
      }
      if (!hasGeminiRecoveryTarget) {
        throw new ConvexError("Integration job is not retryable");
      }
      const claim = await claimJobDocument(ctx, job, false, true);
      if (!claim) throw new ConvexError("Integration job is not retryable");
      await ctx.scheduler.runAfter(0, jobRunner(job.type), { jobId: job._id, leaseToken: claim.leaseToken });
      status = "running";
    } else if (
      job.status === "failed" &&
      job.providerOperationName === undefined &&
      job.leaseToken === undefined &&
      job.targetType !== "documentVersion" &&
      job.lastErrorKind !== undefined &&
      ["network", "timeout", "rate_limit"].includes(job.lastErrorKind)
    ) {
      status = "queued";
      await ctx.db.patch(job._id, {
        status, attemptCount: 0, nextAttemptAt: Date.now(), lastErrorKind: undefined,
        lastProviderOperation: undefined, lastProviderStatus: undefined, lastProviderRawResponse: undefined,
        providerDiagnosticExpiresAt: undefined,
        leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, jobRunner(job.type), { jobId: job._id });
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
    if (!job || !isGeminiJobDocument(job)) throw new ConvexError("Integration job was not found");
    if (job.providerOperationName || job.status === "manual_review" || job.status === "running" || job.status === "waiting_provider") {
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
  lastProviderOperation: v.optional(providerOperationValidator), lastProviderStatus: v.optional(v.number()), lastProviderRawResponse: v.optional(v.string()),
  nextAttemptAt: v.optional(v.number()), correlationId: v.string(), createdAt: v.number(), updatedAt: v.number(),
});

export const listJobs = query({
  args: { paginationOpts: paginationOptsValidator, status: v.optional(jobStatusValidator), type: v.optional(jobTypeValidator) },
  returns: v.object({ page: v.array(jobListRowValidator), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "read");
    const canReadRawProviderResponse = actor.roles.includes("super_admin");
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
    return { page: result.page.filter(isGeminiJobDocument).map((job) => ({ id: job._id, type: job.type, targetType: job.targetType, targetId: job.targetId, status: job.status, attemptCount: job.attemptCount, nextAttemptAt: job.nextAttemptAt, lastErrorKind: job.lastErrorKind, lastProviderOperation: job.lastProviderOperation, lastProviderStatus: job.lastProviderStatus, lastProviderRawResponse: canReadRawProviderResponse ? job.lastProviderRawResponse : undefined, correlationId: job.correlationId, createdAt: job.createdAt, updatedAt: job.updatedAt })), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
