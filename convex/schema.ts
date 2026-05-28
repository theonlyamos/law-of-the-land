import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),
  sessionMetadata: defineTable({
    userId: v.id("users"),
    authSessionId: v.id("authSessions"),
    deviceLabel: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    lastActiveAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_auth_session", ["authSessionId"]),
  chatSessions: defineTable({
    userId: v.id("users"),
    externalId: v.string(),
    title: v.string(),
    lastMessage: v.string(),
    messageCount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_externalId", ["userId", "externalId"]),
  messages: defineTable({
    sessionId: v.id("chatSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),
});
