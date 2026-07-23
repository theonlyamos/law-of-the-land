import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type MutationCtx } from "../_generated/server";
import { isAdminRole } from "../lib/adminPermissions";
import { requireAdminPermission } from "../lib/requireAdmin";

const MAX_ACTOR_ROLES = 6;
const MAX_AUDIT_REASON_LENGTH = 500;
const MAX_AUDIT_SUMMARY_LENGTH = 2_000;
const DEFAULT_AUDIT_LIST_LIMIT = 50;
const MAX_AUDIT_LIST_LIMIT = 100;
const MAX_AUDIT_IDENTIFIER_LENGTH = 256;
const MAX_AUDIT_ACTION_LENGTH = 128;
const MAX_AUDIT_TARGET_TYPE_LENGTH = 64;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_ENTRIES = 20;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const TARGET_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const RAW_URI_PATTERN = /(?:^|[^A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:(?:\/\/)?\S+/i;
const SENSITIVE_TERM_PATTERN =
  /password|passwd|cookie|credentials?|signature|authorization|bearer|secret|private\s+key|api\s+key|(?:access|refresh|id|session)\s+token/i;

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
  metadata: Record<string, AuditMetadataValue>;
};

type AuditMetadataPrimitive = string | number | boolean | null;

interface AuditMetadataObject {
  [key: string]: AuditMetadataValue;
}

type AuditMetadataValue = AuditMetadataPrimitive | AuditMetadataObject;

type PersistedAuditMetadata = Record<string, string | number | boolean | null>;

function hasSensitiveTerm(value: string): boolean {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return SENSITIVE_TERM_PATTERN.test(normalized);
}

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
  if (RAW_URI_PATTERN.test(value)) {
    throw new ConvexError("Audit text must not contain raw URIs");
  }
  if (hasSensitiveTerm(value)) {
    throw new ConvexError("Audit text must not contain secrets");
  }
}

function assertLexeme(
  value: string,
  field: string,
  pattern: RegExp,
  maximumLength: number,
): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    !pattern.test(value) ||
    RAW_URI_PATTERN.test(value)
  ) {
    throw new ConvexError(`Audit ${field} is not a safe lexeme`);
  }
}

function assertSafeGovernanceEvent(event: GovernanceAuditEvent): void {
  assertLexeme(
    event.actorId,
    "actor ID",
    IDENTIFIER_PATTERN,
    MAX_AUDIT_IDENTIFIER_LENGTH,
  );
  if (event.actorRoles.length > MAX_ACTOR_ROLES) {
    throw new ConvexError("Audit actor roles exceed the fixed role limit");
  }
  for (const role of event.actorRoles) {
    if (!isAdminRole(role)) {
      throw new ConvexError("Audit actor role is not a fixed administrative role");
    }
  }
  assertLexeme(event.action, "action", ACTION_PATTERN, MAX_AUDIT_ACTION_LENGTH);
  assertLexeme(
    event.targetType,
    "target type",
    TARGET_TYPE_PATTERN,
    MAX_AUDIT_TARGET_TYPE_LENGTH,
  );
  assertLexeme(
    event.targetId,
    "target ID",
    IDENTIFIER_PATTERN,
    MAX_AUDIT_IDENTIFIER_LENGTH,
  );
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
}

function assertSafeLegacyActorIdentity(
  legacy: LegacyAuditFields,
  canonicalActorId: string,
): void {
  if (legacy.actorUserId === undefined) {
    return;
  }
  assertLexeme(
    legacy.actorUserId,
    "actor ID",
    IDENTIFIER_PATTERN,
    MAX_AUDIT_IDENTIFIER_LENGTH,
  );
  if (
    (legacy.actorType === "user" && legacy.actorUserId !== canonicalActorId) ||
    (legacy.actorType === "system" && legacy.actorUserId !== "system")
  ) {
    throw new ConvexError("Audit actor identities must not diverge");
  }
}

function assertSafeMetadataKey(key: string): void {
  if (!METADATA_KEY_PATTERN.test(key) || hasSensitiveTerm(key)) {
    throw new ConvexError("Audit metadata key is not safe");
  }
}

function validateMetadataValue(
  value: AuditMetadataValue,
  depth: number,
  entries: { count: number },
): void {
  if (typeof value === "string") {
    assertSafeAuditText(value, "metadata", MAX_AUDIT_SUMMARY_LENGTH);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (depth >= MAX_METADATA_DEPTH) {
    throw new ConvexError("Audit metadata exceeds its maximum depth");
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    entries.count += 1;
    if (entries.count > MAX_METADATA_ENTRIES) {
      throw new ConvexError("Audit metadata exceeds its maximum entry count");
    }
    assertSafeMetadataKey(key);
    validateMetadataValue(nestedValue, depth + 1, entries);
  }
}

function validateLegacyMetadata(
  metadata: Record<string, AuditMetadataValue>,
): PersistedAuditMetadata {
  const entries = { count: 0 };
  const persisted: PersistedAuditMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    entries.count += 1;
    if (entries.count > MAX_METADATA_ENTRIES) {
      throw new ConvexError("Audit metadata exceeds its maximum entry count");
    }
    assertSafeMetadataKey(key);
    validateMetadataValue(value, 0, entries);
    if (typeof value === "object" && value !== null) {
      throw new ConvexError("Audit metadata must remain flat");
    }
    persisted[key] = value;
  }
  return persisted;
}

function isSafeStoredAuditEvent(event: {
  actorType: "system" | "user";
  actorId?: string;
  actorUserId?: string;
  actorRoles?: string[];
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  beforeSummary?: string;
  afterSummary?: string;
  outcome?: AuditOutcome;
  metadata: Record<string, AuditMetadataValue>;
}): boolean {
  try {
    if (event.actorId !== undefined) {
      assertLexeme(
        event.actorId,
        "actor ID",
        IDENTIFIER_PATTERN,
        MAX_AUDIT_IDENTIFIER_LENGTH,
      );
    }
    if (event.actorUserId !== undefined) {
      assertLexeme(
        event.actorUserId,
        "actor ID",
        IDENTIFIER_PATTERN,
        MAX_AUDIT_IDENTIFIER_LENGTH,
      );
    }
    const canonicalActorId =
      event.actorId ?? event.actorUserId ?? "system";
    assertSafeLegacyActorIdentity(
      {
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        metadata: event.metadata,
      },
      canonicalActorId,
    );
    assertSafeGovernanceEvent({
      actorId: canonicalActorId,
      actorRoles: event.actorRoles ?? [],
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      reason: event.reason,
      beforeSummary: event.beforeSummary,
      afterSummary: event.afterSummary,
      outcome: event.outcome ?? "success",
    });
    validateLegacyMetadata(event.metadata);
    return true;
  } catch {
    return false;
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
  assertSafeGovernanceEvent(event);
  assertSafeLegacyActorIdentity(legacy, event.actorId);
  const metadata = validateLegacyMetadata(legacy.metadata);

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
    metadata,
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

    return events.filter(isSafeStoredAuditEvent).map((event) => ({
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
