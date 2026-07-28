import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { hasRolePermission, parseAdminRoles, type AdminRole } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { maskSensitiveFields, validateConversationAccessGrant } from "./conversations";
import { readAdminEnabled, requireEnabledAdminPermission } from "./featureFlags";

const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
const DOWNLOAD_REFERENCE_TTL_MS = 10 * 60 * 1_000;
const buildConversationExportRef = makeFunctionReference<"action">("admin/exportActions:buildConversationExport");

const exportResultValidator = v.object({
  status: v.literal("queued"),
  correlationId: v.string(),
  action: v.literal("conversation_export"),
  targetId: v.string(),
});

type ExportResult = {
  status: "queued";
  correlationId: string;
  action: "conversation_export";
  targetId: string;
};

function validateIdempotencyKey(value: string): string {
  if (
    value.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}

function exportFingerprint(input: {
  chatId: Id<"chatSessions">;
  grantId: Id<"adminAccessGrants">;
  reason: string;
  confirmation: string;
}): string {
  return JSON.stringify({
    chatId: input.chatId,
    confirmation: input.confirmation,
    grantId: input.grantId,
    reason: input.reason,
  });
}

async function consumeExportStepUp(
  ctx: MutationCtx,
  input: {
    actorId: string;
    chatId: Id<"chatSessions">;
    grantId: Id<"adminAccessGrants">;
    idempotencyKey: string;
  },
): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (
    !identity ||
    identity.subject !== input.actorId ||
    typeof identity.sessionId !== "string"
  ) {
    return false;
  }
  const proofs = await ctx.db
    .query("adminStepUpProofs")
    .withIndex(
      "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
      (q) =>
        q
          .eq("actorId", input.actorId)
          .eq("sessionId", identity.sessionId as string)
          .eq("action", "conversation_export")
          .eq("targetId", `${input.chatId}:${input.grantId}`)
          .eq("idempotencyKey", input.idempotencyKey),
    )
    .take(2);
  if (
    proofs.length !== 1 ||
    proofs[0].consumedAt !== undefined ||
    proofs[0].expiresAt <= Date.now() ||
    Date.now() - proofs[0].issuedAt > STEP_UP_MAX_AGE_MS
  ) {
    return false;
  }
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
  return true;
}

async function writeExportAudit(
  ctx: MutationCtx,
  actor: { userId: string; roles: AdminRole[] },
  input: {
    action: "admin.conversation_export.attempt" | "admin.conversation_export.success";
    chatId: Id<"chatSessions">;
    reason: string;
    correlationId: string;
  },
) {
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: input.action,
    targetType: "chatSession",
    targetId: input.chatId,
    reason: input.reason,
    correlationId: input.correlationId,
    outcome: "success",
  });
}

export const queueConversationExport = mutation({
  args: {
    chatId: v.id("chatSessions"),
    grantId: v.id("adminAccessGrants"),
    reason: v.string(),
    idempotencyKey: v.string(),
    confirmation: v.string(),
  },
  returns: exportResultValidator,
  handler: async (ctx, args): Promise<ExportResult> => {
    const actor = await requireEnabledAdminPermission(
      ctx,
      "conversation",
      "export",
    );
    const reason = validateAuditReason(args.reason);
    const idempotencyKey = validateIdempotencyKey(args.idempotencyKey);
    if (args.confirmation !== `EXPORT ${args.chatId}`) {
      throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
    }
    await validateConversationAccessGrant(ctx, {
      grantId: args.grantId,
      chatId: args.chatId,
      adminId: actor.userId,
    });

    const fingerprint = exportFingerprint({
      chatId: args.chatId,
      grantId: args.grantId,
      reason,
      confirmation: args.confirmation,
    });
    const existing = await ctx.db
      .query("adminOperations")
      .withIndex("by_actorId_and_idempotencyKey", (q) =>
        q.eq("actorId", actor.userId).eq("idempotencyKey", idempotencyKey),
      )
      .take(2);
    if (existing.length > 1) {
      throw new ConvexError("ADMIN_IDEMPOTENCY_STATE_INVALID");
    }
    if (existing.length === 1) {
      const operation = existing[0];
      if (
        operation.action !== "conversation_export" ||
        operation.targetId !== args.chatId ||
        operation.requestFingerprint !== fingerprint
      ) {
        throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
      }
      if (!operation.result || operation.result.status !== "queued") {
        throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
      }
      return {
        status: "queued",
        correlationId: operation.result.correlationId,
        action: "conversation_export",
        targetId: operation.result.targetId,
      };
    }

    if (
      !(await consumeExportStepUp(ctx, {
        actorId: actor.userId,
        chatId: args.chatId,
        grantId: args.grantId,
        idempotencyKey,
      }))
    ) {
      throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
    }

    const now = Date.now();
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || typeof identity.sessionId !== "string") throw new ConvexError("ADMIN_AUTH_REQUIRED");
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationId = await ctx.db.insert("adminOperations", {
      actorId: actor.userId,
      action: "conversation_export",
      targetId: args.chatId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      correlationId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await writeExportAudit(ctx, actor, {
      action: "admin.conversation_export.attempt",
      chatId: args.chatId,
      reason,
      correlationId,
    });

    const result: ExportResult = {
      status: "queued",
      correlationId,
      action: "conversation_export",
      targetId: args.chatId,
    };
    await ctx.db.patch(operationId, {
      status: "queued",
      result,
      updatedAt: Date.now(),
    });
    const exportId = await ctx.db.insert("adminExports", {
      correlationId,
      requesterId: actor.userId,
      requesterSessionId: identity.sessionId,
      chatSessionId: args.chatId,
      accessGrantId: args.grantId,
      status: "queued",
      expiresAt: now + EXPORT_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, buildConversationExportRef, { exportId });
    await writeExportAudit(ctx, actor, {
      action: "admin.conversation_export.success",
      chatId: args.chatId,
      reason,
      correlationId,
    });
    return result;
  },
});

async function hashReference(reference: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reference));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const finalizedExportValidator = v.object({ exportId: v.id("adminExports"), status: v.literal("ready"), expiresAt: v.number() });

export const finalizeConversationExport = internalMutation({
  args: { correlationId: v.string(), storageId: v.id("_storage") },
  returns: finalizedExportValidator,
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", args.correlationId)).take(2);
    if (rows.length !== 1) throw new ConvexError("ADMIN_EXPORT_NOT_FOUND");
    const item = rows[0];
    if (item.status === "ready") {
      if (item.storageId !== args.storageId) throw new ConvexError("ADMIN_EXPORT_FINALIZATION_CONFLICT");
      return { exportId: item._id, status: "ready" as const, expiresAt: item.expiresAt };
    }
    if (item.status !== "queued" || item.expiresAt <= Date.now()) throw new ConvexError("ADMIN_EXPORT_NOT_FINALIZABLE");
    await validateBuilderAuthority(ctx, item);
    if (!(await ctx.db.system.get("_storage", args.storageId))) throw new ConvexError("ADMIN_EXPORT_STORAGE_NOT_FOUND");
    await ctx.db.patch(item._id, { status: "ready", storageId: args.storageId, updatedAt: Date.now() });
    return { exportId: item._id, status: "ready" as const, expiresAt: item.expiresAt };
  },
});

async function validateBuilderAuthority(ctx: QueryCtx | MutationCtx, item: { requesterId: string; requesterSessionId: string; accessGrantId: Id<"adminAccessGrants">; chatSessionId: Id<"chatSessions">; expiresAt: number }) {
  if (item.expiresAt <= Date.now() || !(await readAdminEnabled(ctx))) throw new ConvexError("ADMIN_EXPORT_AUTHORITY_EXPIRED");
  const [user, session, grant, chat] = await Promise.all([
    ctx.runQuery(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "_id", operator: "eq", value: item.requesterId }] }),
    ctx.runQuery(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "_id", operator: "eq", value: item.requesterSessionId }] }),
    ctx.db.get(item.accessGrantId),
    ctx.db.get(item.chatSessionId),
  ]);
  const roles = parseAdminRoles(user?.role);
  if (!user || user.banned === true || user.emailVerified !== true || user.twoFactorEnabled !== true || !hasRolePermission(roles, "conversation", "export") || !session || session.userId !== item.requesterId || session.expiresAt <= Date.now() || typeof session.adminTwoFactorVerifiedAt !== "number" || typeof session.impersonatedBy === "string" || !grant || grant.adminId !== item.requesterId || grant.chatSessionId !== item.chatSessionId || grant.revokedAt !== undefined || grant.expiresAt <= Date.now() || !chat) {
    throw new ConvexError("ADMIN_EXPORT_AUTHORITY_EXPIRED");
  }
}

export const failConversationExport = internalMutation({
  args: { exportId: v.id("adminExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.exportId);
    if (item?.status === "queued") await ctx.db.patch(item._id, { status: "failed", updatedAt: Date.now() });
    return null;
  },
});

export const getConversationExportPage = internalQuery({
  args: { exportId: v.id("adminExports"), paginationOpts: paginationOptsValidator },
  returns: v.object({ correlationId: v.string(), page: v.array(v.object({ role: v.union(v.literal("user"), v.literal("assistant")), content: v.string(), createdAt: v.number() })), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.exportId);
    if (!item || item.status !== "queued" || item.expiresAt <= Date.now()) throw new ConvexError("ADMIN_EXPORT_NOT_BUILDABLE");
    await validateBuilderAuthority(ctx, item);
    const result = await ctx.db.query("messages").withIndex("by_session_and_createdAt", (q) => q.eq("sessionId", item.chatSessionId)).order("asc").paginate({ ...args.paginationOpts, numItems: Math.min(Math.max(1, args.paginationOpts.numItems), 100), maximumRowsRead: 101 });
    return { correlationId: item.correlationId, page: result.page.map((row) => ({ role: row.role, content: maskSensitiveFields(row.content), createdAt: row.createdAt })), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const getConversationExportStatus = query({
  args: { correlationId: v.string(), grantId: v.id("adminAccessGrants") },
  returns: v.object({ status: v.union(v.literal("queued"), v.literal("ready"), v.literal("failed"), v.literal("expired")), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "conversation", "export");
    const rows = await ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", args.correlationId)).take(2);
    if (rows.length !== 1 || rows[0].requesterId !== actor.userId || rows[0].accessGrantId !== args.grantId) throw new ConvexError("ADMIN_EXPORT_NOT_FOUND");
    await validateConversationAccessGrant(ctx, { grantId: args.grantId, chatId: rows[0].chatSessionId, adminId: actor.userId });
    return { status: rows[0].expiresAt <= Date.now() ? "expired" as const : rows[0].status, expiresAt: rows[0].expiresAt };
  },
});

export const issueConversationExportReference = mutation({
  args: { correlationId: v.string(), grantId: v.id("adminAccessGrants") },
  returns: v.object({ reference: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "conversation", "export");
    const rows = await ctx.db.query("adminExports").withIndex("by_correlationId", (q) => q.eq("correlationId", args.correlationId)).take(2);
    if (rows.length !== 1) throw new ConvexError("ADMIN_EXPORT_NOT_FOUND");
    const item = rows[0];
    if (item.requesterId !== actor.userId || item.accessGrantId !== args.grantId || item.status !== "ready" || !item.storageId || item.expiresAt <= Date.now()) throw new ConvexError("ADMIN_EXPORT_NOT_AVAILABLE");
    await validateConversationAccessGrant(ctx, { grantId: args.grantId, chatId: item.chatSessionId, adminId: actor.userId });
    const existing = await ctx.db.query("exportDownloadReferences").withIndex("by_exportId_and_createdAt", (q) => q.eq("exportId", item._id)).order("desc").take(1);
    if (existing[0] && existing[0].consumedAt === undefined && existing[0].expiresAt > Date.now()) throw new ConvexError("ADMIN_EXPORT_REFERENCE_ALREADY_ISSUED");
    const reference = `exp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAt = Math.min(item.expiresAt, Date.now() + DOWNLOAD_REFERENCE_TTL_MS);
    await ctx.db.insert("exportDownloadReferences", { exportId: item._id, requesterId: actor.userId, referenceHash: await hashReference(reference), expiresAt, createdAt: Date.now() });
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "admin.conversation_export_reference_issued", targetType: "chatSession", targetId: item.chatSessionId, reason: "Issue one-time conversation export download", correlationId: item.correlationId, outcome: "success" });
    return { reference, expiresAt };
  },
});

export const claimConversationExportReference = internalMutation({
  args: { reference: v.string() },
  returns: v.object({ storageId: v.id("_storage"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "conversation", "export");
    if (!/^exp_[A-Za-z0-9_-]{64}$/.test(args.reference)) throw new ConvexError("ADMIN_EXPORT_REFERENCE_INVALID");
    const referenceHash = await hashReference(args.reference);
    const rows = await ctx.db.query("exportDownloadReferences").withIndex("by_referenceHash", (q) => q.eq("referenceHash", referenceHash)).take(2);
    if (rows.length !== 1) throw new ConvexError("ADMIN_EXPORT_REFERENCE_INVALID");
    const reference = rows[0];
    if (reference.requesterId !== actor.userId || reference.consumedAt !== undefined || reference.expiresAt <= Date.now()) throw new ConvexError("ADMIN_EXPORT_REFERENCE_EXPIRED");
    const item = await ctx.db.get(reference.exportId);
    if (!item || item.requesterId !== actor.userId || item.status !== "ready" || !item.storageId || item.expiresAt <= Date.now()) throw new ConvexError("ADMIN_EXPORT_NOT_AVAILABLE");
    await validateConversationAccessGrant(ctx, { grantId: item.accessGrantId, chatId: item.chatSessionId, adminId: actor.userId });
    if (!(await ctx.db.system.get("_storage", item.storageId))) throw new ConvexError("ADMIN_EXPORT_STORAGE_NOT_FOUND");
    await ctx.db.patch(reference._id, { consumedAt: Date.now() });
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "admin.conversation_export_downloaded", targetType: "chatSession", targetId: item.chatSessionId, reason: "Consume one-time conversation export download", correlationId: item.correlationId, outcome: "success" });
    return { storageId: item.storageId, expiresAt: reference.expiresAt };
  },
});
