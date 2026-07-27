import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { validateAuditReason, writeAudit } from "./audit";
import { validateConversationAccessGrant } from "./conversations";
import { requireEnabledAdminPermission } from "./featureFlags";

const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;

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
    await writeExportAudit(ctx, actor, {
      action: "admin.conversation_export.success",
      chatId: args.chatId,
      reason,
      correlationId,
    });
    return result;
  },
});
