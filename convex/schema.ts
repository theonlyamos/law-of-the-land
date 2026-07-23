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
    .index("by_user_and_updatedAt", ["userId", "updatedAt"])
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
