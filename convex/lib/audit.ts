import type { MutationCtx } from "../_generated/server";

type AuditMetadataValue = string | number | boolean | null;

export type AuditEventInput = {
  actorType: "system" | "user";
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, AuditMetadataValue>;
};

/**
 * The sole audit write path. Task 4 can extend this append-only table and
 * helper without migrating bootstrap events out of a temporary store.
 */
export async function appendAuditEvent(
  ctx: MutationCtx,
  event: AuditEventInput,
) {
  return await ctx.db.insert("auditEvents", {
    actorType: event.actorType,
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata ?? {},
    createdAt: Date.now(),
  });
}
