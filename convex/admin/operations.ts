import { paginationOptsValidator } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 20;
const CURSOR_PREFIX = "integration-health:v1:";

const integrationHealthRowValidator = v.object({
  id: v.string(),
  label: v.string(),
  configured: v.boolean(),
  status: v.union(v.literal("ready"), v.literal("configuration_required")),
});

const INTEGRATIONS = [
  {
    id: "identity",
    label: "Identity and sessions",
    environmentVariables: ["SITE_URL", "BETTER_AUTH_SECRET"],
  },
  {
    id: "legal-search",
    label: "Legal search",
    environmentVariables: ["GROUNDX_API_KEY"],
  },
  {
    id: "answer-generation",
    label: "Answer generation",
    environmentVariables: ["GOOGLE_AI_API_KEY"],
  },
  {
    id: "billing",
    label: "Billing",
    environmentVariables: ["POLAR_ORGANIZATION_TOKEN"],
  },
  {
    id: "email",
    label: "Transactional email",
    environmentVariables: ["RESEND_API_KEY"],
  },
] as const;

function readOffset(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error("INVALID_ADMIN_CURSOR");
  }
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0 || value > INTEGRATIONS.length) {
    throw new Error("INVALID_ADMIN_CURSOR");
  }
  return value;
}

export const listIntegrationHealth = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(integrationHealthRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    ) {
      throw new Error("INVALID_ADMIN_PAGINATION");
    }

    const offset = readOffset(args.paginationOpts.cursor);
    const pageSize = Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE);
    const end = Math.min(offset + pageSize, INTEGRATIONS.length);
    const page = INTEGRATIONS.slice(offset, end).map((integration) => {
      const configured = integration.environmentVariables.every(
        (name) => {
          const value = process.env[name];
          return typeof value === "string" && value.trim().length > 0;
        },
      );
      return {
        id: integration.id,
        label: integration.label,
        configured,
        status: configured
          ? "ready" as const
          : "configuration_required" as const,
      };
    });

    return {
      page,
      isDone: end >= INTEGRATIONS.length,
      continueCursor: `${CURSOR_PREFIX}${end}`,
    };
  },
});

const incidentSeverityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"));
const incidentStatusValidator = v.union(v.literal("open"), v.literal("investigating"), v.literal("monitoring"), v.literal("resolved"));
const incidentTimelineKindValidator = v.union(v.literal("created"), v.literal("note"), v.literal("status"), v.literal("ownership"), v.literal("severity"));
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_INCIDENT_TEXT = 500;

function incidentText(value: string, field: string): string {
  if (value.trim() !== value || value.length < 3 || value.length > MAX_INCIDENT_TEXT || /https?:\/\//i.test(value)) {
    throw new ConvexError(`Invalid incident ${field}`);
  }
  return value;
}

async function findIncidentOperation(ctx: MutationCtx, actorId: string, idempotencyKey: string, action: string, fingerprint: string) {
  if (!SAFE_KEY.test(idempotencyKey)) throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  const rows = await ctx.db.query("adminOperations").withIndex("by_actorId_and_idempotencyKey", (q) => q.eq("actorId", actorId).eq("idempotencyKey", idempotencyKey)).take(2);
  if (rows.length > 1) throw new ConvexError("ADMIN_IDEMPOTENCY_STATE_INVALID");
  if (!rows[0]) return null;
  if (rows[0].action !== action || rows[0].requestFingerprint !== fingerprint) throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
  if (!rows[0].result) throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
  return { incidentId: rows[0].result.targetId, correlationId: rows[0].correlationId };
}

async function completeIncidentOperation(ctx: MutationCtx, actor: { userId: string; roles: AdminRole[] }, input: { action: string; incidentId: string; idempotencyKey: string; fingerprint: string; reason: string; auditAction: string; beforeSummary?: string; afterSummary?: string }) {
  const now = Date.now();
  const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
  await ctx.db.insert("adminOperations", { actorId: actor.userId, action: input.action, targetId: input.incidentId, idempotencyKey: input.idempotencyKey, requestFingerprint: input.fingerprint, correlationId, status: "succeeded", result: { status: "succeeded", correlationId, action: input.action, targetId: input.incidentId }, createdAt: now, updatedAt: now });
  await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: input.auditAction, targetType: "systemIncident", targetId: input.incidentId, reason: input.reason, beforeSummary: input.beforeSummary, afterSummary: input.afterSummary, correlationId, outcome: "success" });
  return { incidentId: input.incidentId, correlationId };
}

const incidentMutationResultValidator = v.object({ incidentId: v.string(), correlationId: v.string() });

export const createIncident = mutation({
  args: { title: v.string(), severity: incidentSeverityValidator, reason: v.string(), idempotencyKey: v.string() },
  returns: incidentMutationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "write");
    const title = incidentText(args.title, "title");
    const reason = validateAuditReason(args.reason);
    const fingerprint = JSON.stringify({ title, severity: args.severity, reason });
    const replay = await findIncidentOperation(ctx, actor.userId, args.idempotencyKey, "incident_create", fingerprint);
    if (replay) return replay;
    const now = Date.now();
    const incidentId = await ctx.db.insert("systemIncidents", { title, severity: args.severity, status: "open", createdBy: actor.userId, createdAt: now, updatedAt: now });
    await ctx.db.insert("incidentTimeline", { incidentId, kind: "created", actorId: actor.userId, summary: `Incident opened at ${args.severity} severity`, createdAt: now });
    return await completeIncidentOperation(ctx, actor, { action: "incident_create", incidentId, idempotencyKey: args.idempotencyKey, fingerprint, reason, auditAction: "incident.created", afterSummary: JSON.stringify({ severity: args.severity, status: "open" }) });
  },
});

export const addIncidentNote = mutation({
  args: { incidentId: v.id("systemIncidents"), note: v.string(), reason: v.string(), idempotencyKey: v.string() },
  returns: incidentMutationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "write");
    const note = incidentText(args.note, "note");
    const reason = validateAuditReason(args.reason);
    const fingerprint = JSON.stringify({ incidentId: args.incidentId, note, reason });
    const replay = await findIncidentOperation(ctx, actor.userId, args.idempotencyKey, "incident_note", fingerprint);
    if (replay) return replay;
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new ConvexError("Incident was not found");
    await ctx.db.insert("incidentTimeline", { incidentId: incident._id, kind: "note", actorId: actor.userId, summary: note, createdAt: Date.now() });
    await ctx.db.patch(incident._id, { updatedAt: Date.now() });
    return await completeIncidentOperation(ctx, actor, { action: "incident_note", incidentId: incident._id, idempotencyKey: args.idempotencyKey, fingerprint, reason, auditAction: "incident.note_added", afterSummary: JSON.stringify({ noteAdded: true }) });
  },
});

export const updateIncident = mutation({
  args: { incidentId: v.id("systemIncidents"), status: v.optional(incidentStatusValidator), severity: v.optional(incidentSeverityValidator), ownerId: v.optional(v.union(v.string(), v.null())), reason: v.string(), idempotencyKey: v.string() },
  returns: incidentMutationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "operations", "write");
    const reason = validateAuditReason(args.reason);
    const fingerprint = JSON.stringify({ incidentId: args.incidentId, status: args.status, severity: args.severity, ownerId: args.ownerId, reason });
    const replay = await findIncidentOperation(ctx, actor.userId, args.idempotencyKey, "incident_update", fingerprint);
    if (replay) return replay;
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new ConvexError("Incident was not found");
    if (args.status === undefined && args.severity === undefined && args.ownerId === undefined) throw new ConvexError("Incident update is empty");
    const now = Date.now();
    if (args.status !== undefined && args.status !== incident.status) await ctx.db.insert("incidentTimeline", { incidentId: incident._id, kind: "status", actorId: actor.userId, summary: `Status changed from ${incident.status} to ${args.status}`, createdAt: now });
    if (args.severity !== undefined && args.severity !== incident.severity) await ctx.db.insert("incidentTimeline", { incidentId: incident._id, kind: "severity", actorId: actor.userId, summary: `Severity changed from ${incident.severity} to ${args.severity}`, createdAt: now });
    if (args.ownerId !== undefined && args.ownerId !== (incident.ownerId ?? null)) await ctx.db.insert("incidentTimeline", { incidentId: incident._id, kind: "ownership", actorId: actor.userId, summary: args.ownerId === null ? "Incident ownership cleared" : "Incident owner assigned", createdAt: now });
    const patch: { status?: "open" | "investigating" | "monitoring" | "resolved"; severity?: "low" | "medium" | "high" | "critical"; ownerId?: string; resolvedAt?: number; updatedAt: number } = { updatedAt: now };
    if (args.status !== undefined) {
      patch.status = args.status;
      if (args.status === "resolved") patch.resolvedAt = now;
    }
    if (args.severity !== undefined) patch.severity = args.severity;
    if (args.ownerId !== undefined) patch.ownerId = args.ownerId === null ? undefined : args.ownerId;
    await ctx.db.patch(incident._id, patch);
    return await completeIncidentOperation(ctx, actor, { action: "incident_update", incidentId: incident._id, idempotencyKey: args.idempotencyKey, fingerprint, reason, auditAction: "incident.updated", beforeSummary: JSON.stringify({ status: incident.status, severity: incident.severity, hasOwner: incident.ownerId !== undefined }), afterSummary: JSON.stringify({ status: args.status ?? incident.status, severity: args.severity ?? incident.severity, hasOwner: args.ownerId === undefined ? incident.ownerId !== undefined : args.ownerId !== null }) });
  },
});

const incidentRowValidator = v.object({ id: v.id("systemIncidents"), title: v.string(), severity: incidentSeverityValidator, status: incidentStatusValidator, ownerId: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number() });
export const listIncidents = query({
  args: { paginationOpts: paginationOptsValidator, status: v.optional(incidentStatusValidator), severity: v.optional(incidentSeverityValidator) },
  returns: v.object({ page: v.array(incidentRowValidator), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    if (!Number.isInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems < 1) throw new ConvexError("INVALID_ADMIN_PAGINATION");
    const opts = { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50), maximumRowsRead: 51 };
    const base = args.status && args.severity ? ctx.db.query("systemIncidents").withIndex("by_status_and_severity_and_updatedAt", (q) => q.eq("status", args.status!).eq("severity", args.severity!)) : args.status ? ctx.db.query("systemIncidents").withIndex("by_status_and_updatedAt", (q) => q.eq("status", args.status!)) : args.severity ? ctx.db.query("systemIncidents").withIndex("by_severity_and_updatedAt", (q) => q.eq("severity", args.severity!)) : ctx.db.query("systemIncidents").withIndex("by_status_and_updatedAt");
    const result = await base.order("desc").paginate(opts);
    return { page: result.page.map((row) => ({ id: row._id, title: row.title, severity: row.severity, status: row.status, ownerId: row.ownerId, createdAt: row.createdAt, updatedAt: row.updatedAt })), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const listIncidentTimeline = query({
  args: { incidentId: v.id("systemIncidents"), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.object({ id: v.id("incidentTimeline"), kind: incidentTimelineKindValidator, actorId: v.string(), summary: v.string(), createdAt: v.number() })), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    const result = await ctx.db.query("incidentTimeline").withIndex("by_incidentId_and_createdAt", (q) => q.eq("incidentId", args.incidentId)).order("asc").paginate({ ...args.paginationOpts, numItems: Math.min(Math.max(1, args.paginationOpts.numItems), 50), maximumRowsRead: 51 });
    return { page: result.page.map((row) => ({ id: row._id, kind: row.kind, actorId: row.actorId, summary: row.summary, createdAt: row.createdAt })), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

const RETENTION_LIMIT = 200;
const RETENTION_SLICE = 40;
const DAY_MS = 24 * 60 * 60_000;
const runRetentionBatchRef = makeFunctionReference<"mutation">("admin/operations:runRetentionBatch");
const retentionResultValidator = v.object({ deleted: v.number(), done: v.boolean(), cursor: v.union(v.string(), v.null()) });
const RETENTION_PHASES = [
  "grants", "references",
  "exports_queued", "exports_ready", "exports_failed", "exports_expired",
  "query_runs",
  "jobs_succeeded", "jobs_failed", "jobs_cancelled",
  "correlations_issued", "correlations_search_complete", "correlations_chat_claimed", "correlations_finalized",
  "storage",
] as const;
type RetentionPhase = typeof RETENTION_PHASES[number];

function retentionPhaseIndex(phase: string | undefined): number {
  const index = RETENTION_PHASES.indexOf(phase as RetentionPhase);
  return index < 0 ? 0 : index;
}

export const runRetentionBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: retentionResultValidator,
  handler: async (ctx, _args) => {
    const now = Date.now();
    const state = await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique();
    const stateId = state?._id ?? await ctx.db.insert("retentionState", { key: "default", phase: "records", deletedTotal: 0, lastStartedAt: now, updatedAt: now });
    let deleted = 0;
    let phaseIndex = state?.phase === "complete" ? 0 : retentionPhaseIndex(state?.phase);
    let cycleHadChanges = state?.phase === "complete" ? false : (state?.cycleHadChanges ?? false);
    let storagePassHadChanges = state?.phase === "complete" ? false : (state?.storagePassHadChanges ?? false);
    let storageCursor: string | null = state?.phase === "complete" ? null : (state?.cursor ?? null);
    let storageVisited = false;
    let done = false;
    while (deleted < RETENTION_LIMIT && !done) {
      const phase = RETENTION_PHASES[phaseIndex];
      if (phase === "storage" && storageVisited) break;
      const capacity = Math.min(RETENTION_SLICE, RETENTION_LIMIT - deleted);
      const before = deleted;
      let phaseBlocked = false;
      const reserveBudget = (cost: number) => {
        if (deleted + cost <= RETENTION_LIMIT) return true;
        phaseBlocked = true;
        return false;
      };
      if (phase === "grants") {
        const rows = await ctx.db.query("adminAccessGrants").withIndex("by_expiresAt", (q) => q.lt("expiresAt", now)).take(capacity);
        for (const row of rows) { await ctx.db.delete(row._id); deleted += 1; }
      } else if (phase === "references") {
        const rows = await ctx.db.query("exportDownloadReferences").withIndex("by_expiresAt", (q) => q.lt("expiresAt", now)).take(capacity);
        for (const row of rows) { await ctx.db.delete(row._id); deleted += 1; }
      } else if (phase.startsWith("exports_")) {
        const status = phase.slice("exports_".length) as "queued" | "ready" | "failed" | "expired";
        const rows = await ctx.db.query("adminExports").withIndex("by_status_and_expiresAt", (q) => q.eq("status", status).lt("expiresAt", now)).take(capacity);
        for (const row of rows) {
          const cost = row.storageId ? 2 : 1;
          if (!reserveBudget(cost)) break;
          if (row.storageId) await ctx.storage.delete(row.storageId);
          await ctx.db.delete(row._id); deleted += cost;
        }
      } else if (phase === "query_runs") {
        const rows = await ctx.db.query("queryRuns").withIndex("by_rollupStatus_and_completedAt", (q) => q.eq("rollupStatus", "processed").lt("completedAt", now - 90 * DAY_MS)).take(capacity);
        for (const row of rows) { await ctx.db.delete(row._id); deleted += 1; }
      } else if (phase.startsWith("jobs_")) {
        const status = phase.slice("jobs_".length) as "succeeded" | "failed" | "cancelled";
        const [pending, legacy] = await Promise.all([
          ctx.db.query("integrationJobs").withIndex("by_status_and_retentionPending_and_createdAt", (q) => q.eq("status", status).eq("retentionPending", true).lt("createdAt", now - 90 * DAY_MS)).take(capacity),
          ctx.db.query("integrationJobs").withIndex("by_status_and_retentionPending_and_createdAt", (q) => q.eq("status", status).eq("retentionPending", undefined).lt("createdAt", now - 90 * DAY_MS)).take(capacity),
        ]);
        for (const row of [...pending, ...legacy].sort((a, b) => a.createdAt - b.createdAt).slice(0, capacity)) {
          await ctx.db.patch(row._id, { payload: "{}", lastErrorKind: undefined, retentionPending: false, retentionRedactedAt: now, updatedAt: now }); deleted += 1;
        }
      } else if (phase.startsWith("correlations_")) {
        const status = phase.slice("correlations_".length) as "issued" | "search_complete" | "chat_claimed" | "finalized";
        const rows = await ctx.db.query("telemetryCorrelations").withIndex("by_status_and_expiresAt", (q) => q.eq("status", status).lt("expiresAt", now)).take(capacity);
        for (const row of rows) { await ctx.db.delete(row._id); deleted += 1; }
      } else {
        storageVisited = true;
        const page = await ctx.db.system.query("_storage").order("asc").paginate({ numItems: capacity, cursor: storageCursor });
        storageCursor = page.isDone ? null : page.continueCursor;
        for (const blob of page.page) {
          if (blob._creationTime >= now - DAY_MS || deleted >= RETENTION_LIMIT) continue;
          const attached = await ctx.db.query("documentVersions").withIndex("by_originalStorageId", (q) => q.eq("originalStorageId", blob._id)).take(1);
          const exportArtifact = await ctx.db.query("adminExports").withIndex("by_storageId", (q) => q.eq("storageId", blob._id)).take(1);
          if (attached.length === 0 && exportArtifact.length === 0) { await ctx.storage.delete(blob._id); deleted += 1; }
        }
      }
      if (deleted > before || phaseBlocked) {
        cycleHadChanges = true;
        if (phase === "storage") storagePassHadChanges = true;
      }
      if (phaseBlocked) break;
      phaseIndex = (phaseIndex + 1) % RETENTION_PHASES.length;
      if (phaseIndex === 0) {
        if (storageCursor === null && !cycleHadChanges && !storagePassHadChanges) done = true;
        else {
          cycleHadChanges = false;
          if (storageCursor === null) storagePassHadChanges = false;
        }
      }
    }

    const cursor = done ? null : `retention_${crypto.randomUUID().replaceAll("-", "")}`;
    const current = await ctx.db.get(stateId);
    await ctx.db.patch(stateId, { phase: done ? "complete" : RETENTION_PHASES[phaseIndex], cursor: storageCursor ?? undefined, cycleHadChanges: done ? false : cycleHadChanges, storagePassHadChanges: done ? false : storagePassHadChanges, deletedTotal: (current?.deletedTotal ?? 0) + deleted, lastStartedAt: state?.phase === "complete" ? now : (current?.lastStartedAt ?? now), lastSuccessfulAt: done ? now : current?.lastSuccessfulAt, updatedAt: now });
    await writeAudit(ctx, { actorId: "system", actorRoles: [], action: done ? "retention.batch_completed" : "retention.batch_continued", targetType: "retention", targetId: "default", reason: "Enforce configured data retention policy", afterSummary: JSON.stringify({ deleted, done }), outcome: "success" }, { actorType: "system", actorUserId: "system", metadata: {} });
    if (!done) await ctx.scheduler.runAfter(0, runRetentionBatchRef, { cursor });
    return { deleted, done, cursor };
  },
});

export const getRetentionPolicy = query({
  args: {},
  returns: v.object({ queryRunDays: v.number(), exportHours: v.number(), unattachedStorageHours: v.number(), maxPerInvocation: v.number(), lastSuccessfulAt: v.union(v.number(), v.null()), deletedTotal: v.number() }),
  handler: async (ctx) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    const state = await ctx.db.query("retentionState").withIndex("by_key", (q) => q.eq("key", "default")).unique();
    return { queryRunDays: 90, exportHours: 24, unattachedStorageHours: 24, maxPerInvocation: RETENTION_LIMIT, lastSuccessfulAt: state?.lastSuccessfulAt ?? null, deletedTotal: state?.deletedTotal ?? 0 };
  },
});
