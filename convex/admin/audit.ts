import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type MutationCtx } from "../_generated/server";
import { requireAdminPermission } from "../lib/requireAdmin";

const MAX_ACTOR_ROLES = 6;
const MAX_AUDIT_REASON_LENGTH = 500;
const MAX_AUDIT_SUMMARY_LENGTH = 2_000;
const DEFAULT_AUDIT_LIST_LIMIT = 50;
const MAX_AUDIT_LIST_LIMIT = 100;
const SIGNED_URL_PATTERN =
  /https?:\/\/\S*[?&](?:x-amz-signature|signature|sig|token)=/i;
const SECRET_VALUE_PATTERN =
  /\b(?:authorization|bearer|token|api[_ -]?key|secret)\b\s*[:=]/i;

export type AuditOutcome = "success" | "failure" | "denied";

export type GovernanceAuditEvent = {
  actorId: string;
  actorRoles: readonly string[];
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  beforeSummary?: string;
  afterSummary?: string;
  outcome: AuditOutcome;
};

type LegacyAuditFields = {
  actorType: "system" | "user";
  actorUserId?: string;
  metadata: Record<string, string | number | boolean | null>;
};

function assertSafeAuditText(
  value: string | undefined,
  field: "reason" | "summary" | "metadata",
  maximumLength: number,
): void {
  if (!value) {
    return;
  }
  if (value.length > maximumLength) {
    throw new ConvexError(`Audit ${field} exceeds its maximum length`);
  }
  if (SIGNED_URL_PATTERN.test(value)) {
    throw new ConvexError("Audit text must not contain signed URLs");
  }
  if (SECRET_VALUE_PATTERN.test(value)) {
    throw new ConvexError("Audit text must not contain secrets");
  }
}

function assertSafeLegacyMetadata(
  metadata: Record<string, string | number | boolean | null>,
): void {
  for (const value of Object.values(metadata)) {
    if (typeof value === "string") {
      assertSafeAuditText(value, "metadata", MAX_AUDIT_SUMMARY_LENGTH);
    }
  }
}

function maskAuditIdentifier(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

const maskedAuditEventValidator = v.object({
  actorId: v.string(),
  actorRoles: v.array(v.string()),
  action: v.string(),
  targetType: v.string(),
  targetId: v.string(),
  outcome: v.union(
    v.literal("success"),
    v.literal("failure"),
    v.literal("denied"),
  ),
  createdAt: v.number(),
});

/**
 * Appends an audit event from a mutation. This is deliberately the only
 * insert path for governance-shaped audit events; no update or delete writer
 * is exported.
 */
export async function writeAudit(
  ctx: MutationCtx,
  event: GovernanceAuditEvent,
  legacy: LegacyAuditFields = {
    actorType: "user",
    actorUserId: event.actorId,
    metadata: {},
  },
): Promise<Id<"auditEvents">> {
  if (event.actorRoles.length > MAX_ACTOR_ROLES) {
    throw new ConvexError("Audit actor roles exceed the fixed role limit");
  }
  assertSafeAuditText(event.reason, "reason", MAX_AUDIT_REASON_LENGTH);
  assertSafeAuditText(
    event.beforeSummary,
    "summary",
    MAX_AUDIT_SUMMARY_LENGTH,
  );
  assertSafeAuditText(
    event.afterSummary,
    "summary",
    MAX_AUDIT_SUMMARY_LENGTH,
  );
  assertSafeLegacyMetadata(legacy.metadata);

  return await ctx.db.insert("auditEvents", {
    actorType: legacy.actorType,
    actorUserId: legacy.actorUserId,
    actorId: event.actorId,
    actorRoles: [...new Set(event.actorRoles)],
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    reason: event.reason,
    beforeSummary: event.beforeSummary,
    afterSummary: event.afterSummary,
    outcome: event.outcome,
    metadata: legacy.metadata,
    createdAt: Date.now(),
  });
}

export const listAudit = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(maskedAuditEventValidator),
  handler: async (ctx, args) => {
    await requireAdminPermission(ctx, "audit", "read_masked");

    const limit = args.limit ?? DEFAULT_AUDIT_LIST_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_AUDIT_LIST_LIMIT
    ) {
      throw new ConvexError(
        `Audit list limit must be an integer between 1 and ${MAX_AUDIT_LIST_LIMIT}`,
      );
    }

    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);

    return events.map((event) => ({
      actorId: maskAuditIdentifier(event.actorId ?? event.actorUserId ?? "system"),
      actorRoles: event.actorRoles ?? [],
      action: event.action,
      targetType: event.targetType,
      targetId: maskAuditIdentifier(event.targetId),
      outcome: event.outcome ?? "success",
      createdAt: event.createdAt,
    }));
  },
});
