import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  auditEvents: defineTable({
    actorType: v.union(v.literal("system"), v.literal("user")),
    actorUserId: v.optional(v.string()),
    // Governance fields are optional while Task 3's bootstrap and role-change
    // rows continue to use their original shape.
    actorId: v.optional(v.string()),
    actorRoles: v.optional(v.array(v.string())),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    reason: v.optional(v.string()),
    beforeSummary: v.optional(v.string()),
    afterSummary: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    outcome: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failure"),
        v.literal("denied"),
      ),
    ),
    metadata: v.record(
      v.string(),
      v.union(v.string(), v.number(), v.boolean(), v.null()),
    ),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_actorId_and_createdAt", ["actorId", "createdAt"])
    .index("by_action_and_createdAt", ["action", "createdAt"])
    .index("by_targetType_and_targetId", ["targetType", "targetId"]),
  adminOperations: defineTable({
    actorId: v.string(),
    action: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    correlationId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("queued"),
      v.literal("authorized"),
    ),
    result: v.optional(
      v.object({
        status: v.union(
          v.literal("succeeded"),
          v.literal("failed"),
          v.literal("queued"),
          v.literal("authorized"),
        ),
        correlationId: v.string(),
        action: v.string(),
        targetId: v.string(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_actorId_and_idempotencyKey", [
      "actorId",
      "idempotencyKey",
    ])
    .index("by_action_and_targetId_and_createdAt", [
      "action",
      "targetId",
      "createdAt",
    ])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),
  adminStepUpProofs: defineTable({
    actorId: v.string(),
    sessionId: v.string(),
    action: v.string(),
    targetId: v.string(),
    idempotencyKey: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  }).index(
    "by_actorId_and_sessionId_and_action_and_targetId_and_idempotencyKey",
    ["actorId", "sessionId", "action", "targetId", "idempotencyKey"],
  ),
  userDeletionRequests: defineTable({
    operationId: v.id("adminOperations"),
    actorId: v.string(),
    targetUserId: v.string(),
    executeAfter: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("executing"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    phase: v.optional(
      v.union(
        v.literal("sessions"),
        v.literal("accounts"),
        v.literal("two_factor"),
        v.literal("user"),
      ),
    ),
    cursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_executeAfter", ["status", "executeAfter"])
    .index("by_targetUserId_and_status", ["targetUserId", "status"]),
  verificationEmailRequests: defineTable({
    operationId: v.id("adminOperations"),
    actorId: v.string(),
    targetUserId: v.string(),
    targetEmail: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("executing"),
      v.literal("unknown"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_targetUserId_and_createdAt", ["targetUserId", "createdAt"]),
  adminAccessGrants: defineTable({
    adminId: v.string(),
    chatSessionId: v.id("chatSessions"),
    purpose: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    correlationId: v.optional(v.string()),
  }).index("by_adminId_and_chatSessionId_and_expiresAt", [
    "adminId",
    "chatSessionId",
    "expiresAt",
  ]),
  featureFlags: defineTable({
    key: v.literal("admin_panel"),
    environment: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  }).index("by_key_and_environment", ["key", "environment"]),
  chatSessions: defineTable({
    userId: v.string(),
    externalId: v.string(),
    title: v.string(),
    lastMessage: v.string(),
    messageCount: v.number(),
    updatedAt: v.number(),
    // ISO 3166-1 alpha-2 jurisdiction code; absent on rows created before
    // multi-country support (treated as the default country).
    country: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"])
    .index("by_user_externalId", ["userId", "externalId"]),
  dailyUsage: defineTable({
    userId: v.string(),
    // UTC day key, e.g. "2026-06-11".
    day: v.string(),
    count: v.number(),
  }).index("by_user_day", ["userId", "day"]),
  messages: defineTable({
    sessionId: v.id("chatSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_and_createdAt", ["sessionId", "createdAt"])
    .index("by_session_clientId", ["sessionId", "clientId"]),
});
