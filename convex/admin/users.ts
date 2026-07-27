import {
  makeFunctionReference,
  paginationOptsValidator,
  type PaginationResult,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import {
  ADMIN_ROLES,
  parseAdminRoles,
  type AdminRole,
} from "../lib/adminPermissions";
import {
  createAuth,
  createAuthOptions,
  createGuardedAdminAuth,
  authComponent,
} from "../auth";
import { writeAudit, validateAuditReason } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";
import { writeAdminRoles } from "./roles";

const MAX_PAGE_SIZE = 50;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERIFICATION_RESEND_WINDOW_MS = 5 * 60 * 1_000;
const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;
const USER_DELETION_DELAY_MS = 7 * 24 * 60 * 60 * 1_000;

const adminRoleValidator = v.union(
  ...ADMIN_ROLES.map((role) => v.literal(role)),
);

const operationStatusValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("queued"),
  v.literal("authorized"),
);

const operationResultValidator = v.object({
  status: operationStatusValidator,
  correlationId: v.string(),
  action: v.string(),
  targetId: v.string(),
});

type OperationStatus = "succeeded" | "failed" | "queued" | "authorized";
type OperationResult = {
  status: OperationStatus;
  correlationId: string;
  action: string;
  targetId: string;
};

type OperationActor = {
  userId: string;
  roles: AdminRole[];
};

type BegunOperation =
  | { replay: true; result: OperationResult }
  | {
      replay: false;
      operationId: Id<"adminOperations">;
      correlationId: string;
      action: string;
      targetId: string;
    };

const STEP_UP_ACTIONS = new Set([
  "roles_assign",
  "impersonation_start",
  "user_deletion_queue",
]);

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

function requireExactConfirmation(
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
  }
}

function requestFingerprint(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify(Object.fromEntries(entries));
}

function operationResult(
  status: OperationStatus,
  operation: Exclude<BegunOperation, { replay: true }>,
): OperationResult {
  return {
    status,
    correlationId: operation.correlationId,
    action: operation.action,
    targetId: operation.targetId,
  };
}

function auditAction(action: string, phase: "attempt" | "success" | "failure") {
  return `admin.${action}.${phase}`;
}

async function beginOperation(
  ctx: MutationCtx,
  actor: OperationActor,
  input: {
    action: string;
    targetType: "user" | "session";
    targetId: string;
    reason: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<BegunOperation> {
  validateAuditReason(input.reason);
  validateIdempotencyKey(input.idempotencyKey);
  const fingerprint = requestFingerprint(input.payload);
  const existing = await ctx.db
    .query("adminOperations")
    .withIndex("by_actorId_and_idempotencyKey", (q) =>
      q.eq("actorId", actor.userId).eq("idempotencyKey", input.idempotencyKey),
    )
    .take(2);
  if (existing.length > 1) {
    throw new ConvexError("ADMIN_IDEMPOTENCY_STATE_INVALID");
  }
  if (existing.length === 1) {
    const operation = existing[0];
    if (
      operation.action !== input.action ||
      operation.targetId !== input.targetId ||
      operation.requestFingerprint !== fingerprint
    ) {
      throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
    }
    if (!operation.result) {
      throw new ConvexError("ADMIN_OPERATION_IN_PROGRESS");
    }
    return { replay: true, result: operation.result };
  }

  const now = Date.now();
  const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
  const operationId = await ctx.db.insert("adminOperations", {
    actorId: actor.userId,
    action: input.action,
    targetId: input.targetId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint,
    correlationId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: auditAction(input.action, "attempt"),
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    correlationId,
    outcome: "success",
  });
  return {
    replay: false,
    operationId,
    correlationId,
    action: input.action,
    targetId: input.targetId,
  };
}

async function finishOperation(
  ctx: MutationCtx,
  actor: OperationActor,
  operation: Exclude<BegunOperation, { replay: true }>,
  input: {
    status: OperationStatus;
    targetType: "user" | "session";
    reason: string;
  },
): Promise<OperationResult> {
  const result = operationResult(input.status, operation);
  await ctx.db.patch(operation.operationId, {
    status: input.status,
    result,
    updatedAt: Date.now(),
  });
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: auditAction(
      operation.action,
      input.status === "failed" ? "failure" : "success",
    ),
    targetType: input.targetType,
    targetId: operation.targetId,
    reason: input.reason,
    correlationId: operation.correlationId,
    outcome: input.status === "failed" ? "failure" : "success",
  });
  return result;
}

async function storeOperationResult(
  ctx: MutationCtx,
  operation: Exclude<BegunOperation, { replay: true }>,
  status: OperationStatus,
): Promise<OperationResult> {
  const result = operationResult(status, operation);
  await ctx.db.patch(operation.operationId, {
    status,
    result,
    updatedAt: Date.now(),
  });
  return result;
}

async function failOperation(
  ctx: MutationCtx,
  actor: OperationActor,
  operation: Exclude<BegunOperation, { replay: true }>,
  targetType: "user" | "session",
  reason: string,
): Promise<OperationResult> {
  return await finishOperation(ctx, actor, operation, {
    status: "failed",
    targetType,
    reason,
  });
}

async function requireTargetUser(ctx: MutationCtx, userId: string) {
  if (!userId || userId.trim() !== userId) {
    throw new ConvexError("ADMIN_INVALID_TARGET");
  }
  const target = await authComponent.getAnyUserById(ctx, userId);
  if (!target) {
    throw new ConvexError("ADMIN_TARGET_NOT_FOUND");
  }
  return target;
}

async function requireStepUp(
  ctx: MutationCtx,
  actorId: string,
  input: {
    action: string;
    targetId: string;
    idempotencyKey: string;
  },
): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (
    !identity ||
    typeof identity.sessionId !== "string" ||
    identity.subject !== actorId
  ) {
    throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  }
  const proofs = await ctx.db
    .query("adminStepUpProofs")
    .withIndex(
      "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
      (q) =>
        q
          .eq("actorId", actorId)
          .eq("sessionId", identity.sessionId as string)
          .eq("action", input.action)
          .eq("targetId", input.targetId)
          .eq("idempotencyKey", input.idempotencyKey),
    )
    .take(2);
  if (
    proofs.length !== 1 ||
    proofs[0].consumedAt !== undefined ||
    proofs[0].expiresAt < Date.now() ||
    Date.now() - proofs[0].issuedAt > STEP_UP_MAX_AGE_MS
  ) {
    throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  }
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
}

const userRowValidator = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  roles: v.array(v.string()),
  banned: v.boolean(),
  twoFactorEnabled: v.boolean(),
});

const sessionRowValidator = v.object({
  id: v.string(),
  userId: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  isImpersonated: v.boolean(),
});

const userSearchValidator = v.union(
  v.object({ kind: v.literal("email"), value: v.string() }),
  v.object({ kind: v.literal("user_id"), value: v.string() }),
);

const userPageValidator = v.object({
  page: v.array(userRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

const sessionPageValidator = v.object({
  page: v.array(sessionRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

type AuthDocument = Record<string, unknown>;

function normalizedPagination(paginationOpts: {
  numItems: number;
  cursor: string | null;
}) {
  if (
    !Number.isInteger(paginationOpts.numItems) ||
    paginationOpts.numItems < 1
  ) {
    throw new Error("INVALID_ADMIN_PAGINATION");
  }
  return {
    numItems: Math.min(paginationOpts.numItems, MAX_PAGE_SIZE),
    cursor: paginationOpts.cursor,
    maximumRowsRead: MAX_PAGE_SIZE + 1,
  };
}

function requiredString(document: AuthDocument, field: string): string {
  const value = document[field];
  if (typeof value !== "string") {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function requiredNumber(document: AuthDocument, field: string): number {
  const value = document[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function requiredBoolean(document: AuthDocument, field: string): boolean {
  const value = document[field];
  if (typeof value !== "boolean") {
    throw new Error("INVALID_AUTH_COMPONENT_DATA");
  }
  return value;
}

function userWhere(search?: { kind: "email" | "user_id"; value: string }) {
  if (!search) {
    return undefined;
  }
  if (!search.value.trim()) {
    throw new Error("INVALID_ADMIN_FILTER");
  }
  if (search.kind === "user_id") {
    if (search.value.trim() !== search.value) {
      throw new Error("INVALID_ADMIN_FILTER");
    }
    return [{ field: "_id", operator: "eq" as const, value: search.value }];
  }
  return [
    {
      field: "email",
      operator: "eq" as const,
      value: search.value.trim().toLowerCase(),
    },
  ];
}

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(userSearchValidator),
  },
  returns: userPageValidator,
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "user", "read");

    const result = (await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "user",
        where: userWhere(args.search),
        select: [
          "id",
          "name",
          "email",
          "emailVerified",
          "createdAt",
          "updatedAt",
          "role",
          "banned",
          "twoFactorEnabled",
        ],
        sortBy: { field: "createdAt", direction: "desc" },
        paginationOpts: normalizedPagination(args.paginationOpts),
      },
    )) as PaginationResult<AuthDocument>;

    return {
      page: result.page.map((user) => ({
        id: requiredString(user, "_id"),
        name: requiredString(user, "name"),
        email: requiredString(user, "email"),
        emailVerified: requiredBoolean(user, "emailVerified"),
        createdAt: requiredNumber(user, "createdAt"),
        updatedAt: requiredNumber(user, "updatedAt"),
        roles: parseAdminRoles(user.role),
        banned: user.banned === true,
        twoFactorEnabled: user.twoFactorEnabled === true,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listSessions = query({
  args: {
    userId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: sessionPageValidator,
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "session", "revoke");
    if (!args.userId || args.userId.trim() !== args.userId) {
      throw new Error("INVALID_ADMIN_FILTER");
    }

    const result = (await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "session",
        where: [{ field: "userId", operator: "eq", value: args.userId }],
        select: [
          "id",
          "userId",
          "expiresAt",
          "createdAt",
          "updatedAt",
          "impersonatedBy",
        ],
        sortBy: { field: "createdAt", direction: "desc" },
        paginationOpts: normalizedPagination(args.paginationOpts),
      },
    )) as PaginationResult<AuthDocument>;

    return {
      page: result.page.map((session) => ({
        id: requiredString(session, "_id"),
        userId: requiredString(session, "userId"),
        expiresAt: requiredNumber(session, "expiresAt"),
        createdAt: requiredNumber(session, "createdAt"),
        updatedAt: requiredNumber(session, "updatedAt"),
        isImpersonated: typeof session.impersonatedBy === "string",
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const banUser = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "user", "ban");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    requireExactConfirmation(args.confirmation, `BAN ${args.userId}`);
    if (actor.userId === args.userId) {
      throw new ConvexError("ADMIN_SELF_ACTION_FORBIDDEN");
    }
    await requireTargetUser(ctx, args.userId);

    const operation = await beginOperation(ctx, actor, {
      action: "user_ban",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: {
        confirmation: args.confirmation,
        reason: args.reason,
        userId: args.userId,
      },
    });
    if (operation.replay) {
      return operation.result;
    }

    try {
      const { auth, headers } = await authComponent.getAuth(
        createGuardedAdminAuth,
        ctx,
      );
      await auth.api.banUser({
        body: { userId: args.userId, banReason: args.reason },
        headers,
      });
      return await finishOperation(ctx, actor, operation, {
        status: "succeeded",
        targetType: "user",
        reason: args.reason,
      });
    } catch {
      return await failOperation(ctx, actor, operation, "user", args.reason);
    }
  },
});

export const unbanUser = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "user", "ban");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    await requireTargetUser(ctx, args.userId);

    const operation = await beginOperation(ctx, actor, {
      action: "user_unban",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: { reason: args.reason, userId: args.userId },
    });
    if (operation.replay) {
      return operation.result;
    }

    try {
      const { auth, headers } = await authComponent.getAuth(
        createGuardedAdminAuth,
        ctx,
      );
      await auth.api.unbanUser({
        body: { userId: args.userId },
        headers,
      });
      return await finishOperation(ctx, actor, operation, {
        status: "succeeded",
        targetType: "user",
        reason: args.reason,
      });
    } catch {
      return await failOperation(ctx, actor, operation, "user", args.reason);
    }
  },
});

export const revokeSession = mutation({
  args: {
    sessionId: v.string(),
    userId: v.string(),
    reason: v.string(),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "session", "revoke");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    requireExactConfirmation(args.confirmation, `REVOKE ${args.sessionId}`);
    const session = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: "session",
        where: [{ field: "_id", operator: "eq", value: args.sessionId }],
      },
    );
    if (!session || session.userId !== args.userId) {
      throw new ConvexError("ADMIN_SESSION_NOT_FOUND");
    }
    if (session.userId === actor.userId) {
      throw new ConvexError("ADMIN_SELF_ACTION_FORBIDDEN");
    }
    if (typeof session.token !== "string") {
      throw new ConvexError("ADMIN_SESSION_STATE_INVALID");
    }

    const operation = await beginOperation(ctx, actor, {
      action: "session_revoke",
      targetType: "session",
      targetId: args.sessionId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: {
        confirmation: args.confirmation,
        reason: args.reason,
        sessionId: args.sessionId,
        userId: args.userId,
      },
    });
    if (operation.replay) {
      return operation.result;
    }

    try {
      const { auth, headers } = await authComponent.getAuth(
        createGuardedAdminAuth,
        ctx,
      );
      await auth.api.revokeUserSession({
        body: { sessionToken: session.token },
        headers,
      });
      return await finishOperation(ctx, actor, operation, {
        status: "succeeded",
        targetType: "session",
        reason: args.reason,
      });
    } catch {
      return await failOperation(ctx, actor, operation, "session", args.reason);
    }
  },
});

export const revokeAllSessions = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "session", "revoke");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    requireExactConfirmation(
      args.confirmation,
      `REVOKE ALL ${args.userId}`,
    );
    if (actor.userId === args.userId) {
      throw new ConvexError("ADMIN_SELF_ACTION_FORBIDDEN");
    }
    await requireTargetUser(ctx, args.userId);

    const operation = await beginOperation(ctx, actor, {
      action: "sessions_revoke_all",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: {
        confirmation: args.confirmation,
        reason: args.reason,
        userId: args.userId,
      },
    });
    if (operation.replay) {
      return operation.result;
    }

    try {
      const { auth, headers } = await authComponent.getAuth(
        createGuardedAdminAuth,
        ctx,
      );
      await auth.api.revokeUserSessions({
        body: { userId: args.userId },
        headers,
      });
      return await finishOperation(ctx, actor, operation, {
        status: "succeeded",
        targetType: "user",
        reason: args.reason,
      });
    } catch {
      return await failOperation(ctx, actor, operation, "user", args.reason);
    }
  },
});

const sendQueuedVerificationEmailReference =
  makeFunctionReference<"action">(
    "admin/users:sendQueuedVerificationEmail",
  );

export const resendVerification = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "user", "support");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    const target = await requireTargetUser(ctx, args.userId);
    if (target.emailVerified === true) {
      throw new ConvexError("ADMIN_EMAIL_ALREADY_VERIFIED");
    }
    if (typeof target.email !== "string") {
      throw new ConvexError("ADMIN_TARGET_STATE_INVALID");
    }

    const recent = await ctx.db
      .query("adminOperations")
      .withIndex("by_action_and_targetId_and_createdAt", (q) =>
        q.eq("action", "verification_resend").eq("targetId", args.userId),
      )
      .order("desc")
      .take(1);
    if (
      recent[0] &&
      recent[0].idempotencyKey !== args.idempotencyKey &&
      recent[0].createdAt > Date.now() - VERIFICATION_RESEND_WINDOW_MS
    ) {
      throw new ConvexError("ADMIN_VERIFICATION_RATE_LIMITED");
    }

    const operation = await beginOperation(ctx, actor, {
      action: "verification_resend",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: { reason: args.reason, userId: args.userId },
    });
    if (operation.replay) {
      return operation.result;
    }

    const now = Date.now();
    const requestId = await ctx.db.insert("verificationEmailRequests", {
      operationId: operation.operationId,
      actorId: actor.userId,
      targetUserId: args.userId,
      targetEmail: target.email,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, sendQueuedVerificationEmailReference, {
      requestId,
    });
    return await storeOperationResult(ctx, operation, "queued");
  },
});

const claimVerificationEmailReference =
  makeFunctionReference<"mutation">(
    "admin/users:claimVerificationEmail",
  );
const finalizeVerificationEmailReference =
  makeFunctionReference<"mutation">(
    "admin/users:finalizeVerificationEmail",
  );

export const claimVerificationEmail = internalMutation({
  args: { requestId: v.id("verificationEmailRequests") },
  returns: v.union(
    v.null(),
    v.object({
      targetEmail: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "queued") {
      return null;
    }
    await ctx.db.patch(request._id, {
      status: "executing",
      updatedAt: Date.now(),
    });
    return { targetEmail: request.targetEmail };
  },
});

export const finalizeVerificationEmail = internalMutation({
  args: {
    requestId: v.id("verificationEmailRequests"),
    succeeded: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "executing") {
      return null;
    }
    const operation = await ctx.db.get(request.operationId);
    if (!operation) {
      await ctx.db.patch(request._id, {
        status: "failed",
        updatedAt: Date.now(),
      });
      return null;
    }
    const actor = await authComponent.getAnyUserById(ctx, request.actorId);
    const roles = parseAdminRoles(actor?.role);
    await ctx.db.patch(request._id, {
      status: args.succeeded ? "completed" : "failed",
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: request.actorId,
      actorRoles: roles,
      action: auditAction(
        "verification_resend",
        args.succeeded ? "success" : "failure",
      ),
      targetType: "user",
      targetId: request.targetUserId,
      correlationId: operation.correlationId,
      outcome: args.succeeded ? "success" : "failure",
    });
    return null;
  },
});

export const sendQueuedVerificationEmail = internalAction({
  args: { requestId: v.id("verificationEmailRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(claimVerificationEmailReference, {
      requestId: args.requestId,
    });
    if (!claimed) {
      return null;
    }
    let succeeded = false;
    try {
      const { auth } = await authComponent.getAuth(createAuth, ctx);
      const response = await auth.api.sendVerificationEmail({
        body: { email: claimed.targetEmail },
      });
      succeeded = response.status === true;
    } catch {
      succeeded = false;
    }
    await ctx.runMutation(finalizeVerificationEmailReference, {
      requestId: args.requestId,
      succeeded,
    });
    return null;
  },
});

export const assignRoles = mutation({
  args: {
    userId: v.string(),
    roles: v.array(adminRoleValidator),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "user", "set_role");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    const target = await requireTargetUser(ctx, args.userId);
    if (actor.userId === args.userId) {
      throw new ConvexError("ADMIN_SELF_ROLE_CHANGE_FORBIDDEN");
    }
    const operation = await beginOperation(ctx, actor, {
      action: "roles_assign",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: {
        reason: args.reason,
        roles: [...new Set(args.roles)].sort().join(","),
        userId: args.userId,
      },
    });
    if (operation.replay) {
      return operation.result;
    }
    await requireStepUp(ctx, actor.userId, {
      action: "roles_assign",
      targetId: args.userId,
      idempotencyKey: args.idempotencyKey,
    });

    try {
      await writeAdminRoles(
        ctx,
        {
          actorType: "user",
          actorUserId: actor.userId,
          targetUserId: args.userId,
          roles: args.roles,
          auditAction: "admin.roles_changed",
        },
        { skipAudit: true },
      );
      return await finishOperation(ctx, actor, operation, {
        status: "succeeded",
        targetType: "user",
        reason: args.reason,
      });
    } catch {
      return await failOperation(ctx, actor, operation, "user", args.reason);
    }
  },
});

export const startImpersonation = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(
      ctx,
      "user",
      "impersonate",
    );
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    if (actor.userId === args.userId) {
      throw new ConvexError("ADMIN_SELF_ACTION_FORBIDDEN");
    }
    const target = await requireTargetUser(ctx, args.userId);
    if (parseAdminRoles(target.role).length > 0) {
      throw new ConvexError("ADMIN_IMPERSONATION_TARGET_FORBIDDEN");
    }
    const operation = await beginOperation(ctx, actor, {
      action: "impersonation_start",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: { reason: args.reason, userId: args.userId },
    });
    if (operation.replay) {
      return operation.result;
    }
    await requireStepUp(ctx, actor.userId, {
      action: "impersonation_start",
      targetId: args.userId,
      idempotencyKey: args.idempotencyKey,
    });
    return await storeOperationResult(ctx, operation, "authorized");
  },
});

export const recordAdminStepUpProof = internalMutation({
  args: {
    actorId: v.string(),
    sessionId: v.string(),
    action: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateIdempotencyKey(args.idempotencyKey);
    if (!STEP_UP_ACTIONS.has(args.action)) {
      throw new ConvexError("ADMIN_STEP_UP_SCOPE_INVALID");
    }
    const [actor, target, session] = await Promise.all([
      authComponent.getAnyUserById(ctx, args.actorId),
      authComponent.getAnyUserById(ctx, args.targetId),
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", operator: "eq", value: args.sessionId }],
      }),
    ]);
    if (
      !actor ||
      !target ||
      parseAdminRoles(actor.role).length === 0 ||
      actor.twoFactorEnabled !== true ||
      !session ||
      session.userId !== args.actorId ||
      typeof session.adminTwoFactorVerifiedAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      throw new ConvexError("ADMIN_STEP_UP_SCOPE_INVALID");
    }

    const existing = await ctx.db
      .query("adminStepUpProofs")
      .withIndex(
        "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
        (q) =>
          q
            .eq("actorId", args.actorId)
            .eq("sessionId", args.sessionId)
            .eq("action", args.action)
            .eq("targetId", args.targetId)
            .eq("idempotencyKey", args.idempotencyKey),
      )
      .take(2);
    if (existing.length > 1) {
      throw new ConvexError("ADMIN_STEP_UP_STATE_INVALID");
    }
    const now = Date.now();
    const proof = {
      actorId: args.actorId,
      sessionId: args.sessionId,
      action: args.action,
      targetId: args.targetId,
      idempotencyKey: args.idempotencyKey,
      issuedAt: now,
      expiresAt: now + STEP_UP_MAX_AGE_MS,
    };
    if (existing[0]) {
      await ctx.db.replace(existing[0]._id, proof);
    } else {
      await ctx.db.insert("adminStepUpProofs", proof);
    }
    return null;
  },
});

export const consumePreparedImpersonation = internalMutation({
  args: {
    actorId: v.string(),
    sessionId: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateIdempotencyKey(args.idempotencyKey);
    const operations = await ctx.db
      .query("adminOperations")
      .withIndex("by_actorId_and_idempotencyKey", (q) =>
        q
          .eq("actorId", args.actorId)
          .eq("idempotencyKey", args.idempotencyKey),
      )
      .take(2);
    const operation = operations[0];
    if (
      operations.length !== 1 ||
      !operation ||
      operation.action !== "impersonation_start" ||
      operation.targetId !== args.targetId ||
      operation.status !== "authorized" ||
      operation.updatedAt < Date.now() - STEP_UP_MAX_AGE_MS
    ) {
      return false;
    }
    const [session, target] = await Promise.all([
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "session",
        where: [{ field: "_id", operator: "eq", value: args.sessionId }],
      }),
      authComponent.getAnyUserById(ctx, args.targetId),
    ]);
    if (
      !session ||
      session.userId !== args.actorId ||
      session.expiresAt <= Date.now() ||
      typeof session.adminTwoFactorVerifiedAt !== "number" ||
      !target ||
      parseAdminRoles(target.role).length > 0
    ) {
      return false;
    }
    await ctx.db.patch(operation._id, {
      status: "pending",
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const finalizePreparedImpersonation = internalMutation({
  args: {
    actorId: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
    succeeded: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operations = await ctx.db
      .query("adminOperations")
      .withIndex("by_actorId_and_idempotencyKey", (q) =>
        q
          .eq("actorId", args.actorId)
          .eq("idempotencyKey", args.idempotencyKey),
      )
      .take(2);
    const operation = operations[0];
    if (
      operations.length !== 1 ||
      !operation ||
      operation.action !== "impersonation_start" ||
      operation.targetId !== args.targetId ||
      operation.status !== "pending"
    ) {
      return null;
    }
    const actor = await authComponent.getAnyUserById(ctx, args.actorId);
    await ctx.db.patch(operation._id, {
      status: args.succeeded ? "succeeded" : "failed",
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: args.actorId,
      actorRoles: parseAdminRoles(actor?.role),
      action: auditAction(
        "impersonation_start",
        args.succeeded ? "success" : "failure",
      ),
      targetType: "user",
      targetId: args.targetId,
      correlationId: operation.correlationId,
      outcome: args.succeeded ? "success" : "failure",
    });
    return null;
  },
});

const executeQueuedUserDeletionReference =
  makeFunctionReference<"mutation">(
    "admin/users:executeQueuedUserDeletion",
  );

export const queueUserDeletion = mutation({
  args: {
    userId: v.string(),
    reason: v.string(),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: operationResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "user", "support");
    validateAuditReason(args.reason);
    validateIdempotencyKey(args.idempotencyKey);
    requireExactConfirmation(args.confirmation, `DELETE ${args.userId}`);
    if (actor.userId === args.userId) {
      throw new ConvexError("ADMIN_SELF_ACTION_FORBIDDEN");
    }
    const target = await requireTargetUser(ctx, args.userId);
    if (parseAdminRoles(target.role).length > 0) {
      throw new ConvexError("ADMIN_ADMINISTRATOR_DELETION_FORBIDDEN");
    }
    const operation = await beginOperation(ctx, actor, {
      action: "user_deletion_queue",
      targetType: "user",
      targetId: args.userId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      payload: {
        confirmation: args.confirmation,
        reason: args.reason,
        userId: args.userId,
      },
    });
    if (operation.replay) {
      return operation.result;
    }
    await requireStepUp(ctx, actor.userId, {
      action: "user_deletion_queue",
      targetId: args.userId,
      idempotencyKey: args.idempotencyKey,
    });

    const now = Date.now();
    const requestId = await ctx.db.insert("userDeletionRequests", {
      operationId: operation.operationId,
      actorId: actor.userId,
      targetUserId: args.userId,
      executeAfter: now + USER_DELETION_DELAY_MS,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      USER_DELETION_DELAY_MS,
      executeQueuedUserDeletionReference,
      { requestId },
    );
    return await finishOperation(ctx, actor, operation, {
      status: "queued",
      targetType: "user",
      reason: args.reason,
    });
  },
});

export const executeQueuedUserDeletion = internalMutation({
  args: { requestId: v.id("userDeletionRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (
      !request ||
      request.status !== "queued" ||
      request.executeAfter > Date.now()
    ) {
      return null;
    }
    const operation = await ctx.db.get(request.operationId);
    const target = await authComponent.getAnyUserById(
      ctx,
      request.targetUserId,
    );
    if (!operation || !target || parseAdminRoles(target.role).length > 0) {
      await ctx.db.patch(request._id, {
        status: "failed",
        updatedAt: Date.now(),
      });
      if (operation) {
        await writeAudit(ctx, {
          actorId: "system",
          actorRoles: [],
          action: "admin.user_deletion_execute.failure",
          targetType: "user",
          targetId: request.targetUserId,
          correlationId: operation.correlationId,
          outcome: "failure",
        }, {
          actorType: "system",
          actorUserId: "system",
          metadata: {},
        });
      }
      return null;
    }

    await ctx.db.patch(request._id, {
      status: "executing",
      updatedAt: Date.now(),
    });
    const adapter = authComponent.adapter(ctx)(createAuthOptions(ctx));
    try {
      await adapter.deleteMany({
        model: "session",
        where: [{ field: "userId", value: request.targetUserId }],
      });
      await adapter.deleteMany({
        model: "account",
        where: [{ field: "userId", value: request.targetUserId }],
      });
      await adapter.delete({
        model: "user",
        where: [{ field: "id", value: request.targetUserId }],
      });
    } catch {
      await ctx.db.patch(request._id, {
        status: "failed",
        updatedAt: Date.now(),
      });
      await writeAudit(ctx, {
        actorId: "system",
        actorRoles: [],
        action: "admin.user_deletion_execute.failure",
        targetType: "user",
        targetId: request.targetUserId,
        correlationId: operation.correlationId,
        outcome: "failure",
      }, {
        actorType: "system",
        actorUserId: "system",
        metadata: {},
      });
      return null;
    }
    await ctx.db.patch(request._id, {
      status: "completed",
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      actorId: "system",
      actorRoles: [],
      action: "admin.user_deletion_execute.success",
      targetType: "user",
      targetId: request.targetUserId,
      correlationId: operation.correlationId,
      outcome: "success",
    }, {
      actorType: "system",
      actorUserId: "system",
      metadata: {},
    });
    return null;
  },
});
