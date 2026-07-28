import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { adminAccessError } from "../lib/adminAccessErrors";
import {
  requireAdminPermission,
  requireCurrentAdmin,
} from "../lib/requireAdmin";
import { validateAuditReason, writeAudit } from "./audit";

function readAdminEnvironment(): string | null {
  const environment = process.env.ADMIN_ENVIRONMENT;
  if (!environment || environment.trim() !== environment) {
    return null;
  }
  return environment;
}

/**
 * The administrative surface is enabled only when its deployment gate and
 * its explicitly selected environment row are both enabled. An absent or
 * blank selector deliberately cannot fall back to another environment.
 */
export async function readAdminEnabled(ctx: QueryCtx): Promise<boolean> {
  if (process.env.ADMIN_PANEL_ENABLED !== "true") {
    return false;
  }

  const environment = readAdminEnvironment();
  if (!environment) {
    return false;
  }

  const flags = await ctx.db
    .query("featureFlags")
    .withIndex("by_key_and_environment", (q) =>
      q.eq("key", "admin_panel").eq("environment", environment),
    )
    .take(2);

  return flags.length === 1 && flags[0].enabled === true;
}

export async function requireEnabledAdminPermission(
  ctx: QueryCtx,
  resource: string,
  action: string,
) {
  const admin = await requireAdminPermission(ctx, resource, action);
  if (!(await readAdminEnabled(ctx))) {
    throw adminAccessError(
      "ADMIN_DISABLED",
      "Administration is not enabled",
    );
  }
  return admin;
}

export const isAdminEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requireCurrentAdmin(ctx);
    return await readAdminEnabled(ctx);
  },
});

/**
 * Minimal state needed by the recovery page. This deliberately bypasses the
 * ordinary panel-enabled check while retaining full session assurance,
 * non-impersonation, and Super Admin authorization.
 */
export const getAdminPanelRecoveryState = query({
  args: {},
  returns: v.object({ environment: v.string(), enabled: v.boolean() }),
  handler: async (ctx) => {
    await requireAdminPermission(ctx, "user", "set_role");
    const environment = readAdminEnvironment();
    if (!environment) throw new ConvexError("ADMIN_FLAG_ENVIRONMENT_INVALID");
    const flags = await ctx.db
      .query("featureFlags")
      .withIndex("by_key_and_environment", (q) =>
        q.eq("key", "admin_panel").eq("environment", environment),
      )
      .take(2);
    if (flags.length > 1) throw new ConvexError("ADMIN_FLAG_STATE_INVALID");
    return { environment, enabled: flags[0]?.enabled === true };
  },
});

const FLAG_TARGET_PREFIX = "admin_panel:";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

async function consumeFlagStepUp(
  ctx: MutationCtx,
  actorId: string,
  sessionId: string,
  environment: string,
  idempotencyKey: string,
) {
  const proofs = await ctx.db
    .query("adminStepUpProofs")
    .withIndex(
      "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
      (q) =>
        q
          .eq("actorId", actorId)
          .eq("sessionId", sessionId)
          .eq("action", "admin_panel_set")
          .eq("targetId", `${FLAG_TARGET_PREFIX}${environment}`)
          .eq("idempotencyKey", idempotencyKey),
    )
    .take(2);
  if (
    proofs.length !== 1 ||
    proofs[0].consumedAt !== undefined ||
    proofs[0].expiresAt <= Date.now()
  ) {
    throw new ConvexError("ADMIN_STEP_UP_REQUIRED");
  }
  await ctx.db.patch(proofs[0]._id, { consumedAt: Date.now() });
}

/**
 * Break-glass control: intentionally ungated so an assured Super Admin can
 * re-enable the database flag after the ordinary surface is disabled.
 */
export const setAdminPanel = mutation({
  args: {
    environment: v.string(),
    enabled: v.boolean(),
    confirmation: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.object({ environment: v.string(), enabled: v.boolean(), correlationId: v.string() }),
  handler: async (ctx, args) => {
    const actor = await requireAdminPermission(ctx, "user", "set_role");
    const environment = readAdminEnvironment();
    if (!environment || args.environment !== environment) {
      throw new ConvexError("ADMIN_FLAG_ENVIRONMENT_INVALID");
    }
    if (!IDEMPOTENCY_KEY.test(args.idempotencyKey)) {
      throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
    }
    const expected = `ADMIN_PANEL ${environment} ${args.enabled ? "ENABLE" : "DISABLE"}`;
    if (args.confirmation !== expected) {
      throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
    }
    const reason = validateAuditReason(args.reason);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || typeof identity.sessionId !== "string") {
      throw new ConvexError("ADMIN_AUTH_REQUIRED");
    }
    const fingerprint = JSON.stringify({ environment, enabled: args.enabled, reason });
    const existing = await ctx.db
      .query("adminOperations")
      .withIndex("by_actorId_and_idempotencyKey", (q) =>
        q.eq("actorId", actor.userId).eq("idempotencyKey", args.idempotencyKey),
      )
      .take(2);
    if (existing.length > 1) throw new ConvexError("ADMIN_IDEMPOTENCY_STATE_INVALID");
    if (existing[0]) {
      if (existing[0].action !== "admin_panel_set" || existing[0].targetId !== environment || existing[0].requestFingerprint !== fingerprint || !existing[0].result) {
        throw new ConvexError("ADMIN_IDEMPOTENCY_CONFLICT");
      }
      return { environment, enabled: args.enabled, correlationId: existing[0].correlationId };
    }
    await consumeFlagStepUp(ctx, actor.userId, identity.sessionId, environment, args.idempotencyKey);
    const flags = await ctx.db
      .query("featureFlags")
      .withIndex("by_key_and_environment", (q) =>
        q.eq("key", "admin_panel").eq("environment", environment),
      )
      .take(2);
    if (flags.length > 1) throw new ConvexError("ADMIN_FLAG_STATE_INVALID");
    const now = Date.now();
    if (flags[0]) {
      await ctx.db.patch(flags[0]._id, { enabled: args.enabled, updatedAt: now, updatedBy: actor.userId });
    } else {
      await ctx.db.insert("featureFlags", { key: "admin_panel", environment, enabled: args.enabled, updatedAt: now, updatedBy: actor.userId });
    }
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    await ctx.db.insert("adminOperations", {
      actorId: actor.userId,
      action: "admin_panel_set",
      targetId: environment,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint,
      correlationId,
      status: "succeeded",
      result: { status: "succeeded", correlationId, action: "admin_panel_set", targetId: environment },
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: "admin.panel_flag_set",
      targetType: "featureFlag",
      targetId: environment,
      reason,
      afterSummary: JSON.stringify({ enabled: args.enabled }),
      correlationId,
      outcome: "success",
    });
    return { environment, enabled: args.enabled, correlationId };
  },
});
