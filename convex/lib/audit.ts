import type { MutationCtx } from "../_generated/server";
import { writeAudit } from "../admin/audit";

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
  return await writeAudit(ctx, {
    actorId: event.actorUserId ?? "system",
    actorRoles: [],
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    outcome: "success",
  }, {
    actorType: event.actorType,
    actorUserId: event.actorUserId,
    metadata: event.metadata ?? {},
  });
}
