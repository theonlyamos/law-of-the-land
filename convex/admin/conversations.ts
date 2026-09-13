import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { adminAccessError } from "../lib/adminAccessErrors";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 50;
const ACCESS_GRANT_TTL_MS = 15 * 60 * 1_000;

type ConversationAdminCtx = QueryCtx | MutationCtx;

async function requireDirectConversationContentAdmin(
  ctx: ConversationAdminCtx,
) {
  const admin = await requireEnabledAdminPermission(
    ctx,
    "conversation",
    "read_content",
  );
  if (admin.impersonatedBy) {
    throw adminAccessError(
      "ADMIN_FORBIDDEN",
      "Impersonated sessions cannot access conversation content",
    );
  }
  return admin;
}

const messageRowValidator = v.object({
  id: v.id("messages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  createdAt: v.number(),
});

const conversationRowValidator = v.object({
  id: v.id("chatSessions"),
  userId: v.string(),
  externalId: v.string(),
  userName: v.union(v.string(), v.null()),
  userEmail: v.union(v.string(), v.null()),
  createdAt: v.number(),
  messageCount: v.number(),
  updatedAt: v.number(),
  jurisdiction: v.union(
    v.object({
      id: v.id("jurisdictions"),
      name: v.string(),
      kind: v.union(v.literal("geographic"), v.literal("organizational")),
    }),
    v.null(),
  ),
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    userId: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(conversationRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireDirectConversationContentAdmin(ctx);
    if (
      args.userId !== undefined &&
      (!args.userId || args.userId.trim() !== args.userId)
    ) {
      throw new Error("INVALID_ADMIN_FILTER");
    }
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    ) {
      throw new Error("INVALID_ADMIN_PAGINATION");
    }

    const paginationOpts = {
      numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE),
      cursor: args.paginationOpts.cursor,
      maximumRowsRead: MAX_PAGE_SIZE + 1,
    };
    const result = args.userId
      ? await ctx.db
          .query("chatSessions")
          .withIndex("by_userId_and_updatedAt", (q) =>
            q.eq("userId", args.userId!),
          )
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("chatSessions")
          .withIndex("by_updatedAt")
          .order("desc")
          .paginate(paginationOpts);

    const userIds = [...new Set(result.page.map((session) => session.userId))];
    const users = userIds.length === 0 ? [] : (await ctx.runQuery(
      components.betterAuth.adminUsers.getDisplayProfiles,
      { userIds },
    ));
    const usersById = new Map(users.map((user) => [user.userId, user]));

    return {
      page: result.page.map((session) => ({
        id: session._id,
        userId: session.userId,
        externalId: session.externalId,
        userName: usersById.get(session.userId)?.name ?? null,
        userEmail: usersById.get(session.userId)?.email ?? null,
        createdAt: session._creationTime,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
        jurisdiction:
          session.jurisdictionContract === "unified"
          && session.jurisdictionId
          && session.jurisdictionName?.trim()
          && session.jurisdictionKind
            ? {
                id: session.jurisdictionId,
                name: session.jurisdictionName,
                kind: session.jurisdictionKind,
              }
            : null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const previews = query({
  args: { chatIds: v.array(v.id("chatSessions")) },
  returns: v.array(v.object({
    id: v.id("chatSessions"),
    firstUserMessagePreview: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, { chatIds }) => {
    await requireDirectConversationContentAdmin(ctx);
    // At most 8 one-MiB message documents, leaving room for authorization reads.
    if (chatIds.length > 8) throw new Error("TOO_MANY_CONVERSATION_PREVIEWS");
    return await Promise.all([...new Set(chatIds)].map(async (id) => {
      const firstMessage = await ctx.db.query("messages")
        .withIndex("by_sessionId_and_role_and_createdAt", (q) =>
          q.eq("sessionId", id).eq("role", "user"),
        )
        .order("asc")
        .first();
      const text = maskSensitiveFields(firstMessage?.content ?? "").replace(/\s+/g, " ").trim();
      const characters = Array.from(text);
      return {
        id,
        firstUserMessagePreview: (characters.length > 120
          ? `${characters.slice(0, 119).join("").trimEnd()}…`
          : text) || null,
      };
    }));
  },
});

/**
 * Removes secret-bearing field values before conversation content crosses the
 * administrative read boundary. Markdown rendering applies a second,
 * independent URL policy in the client.
 */
export function maskSensitiveFields(content: string): string {
  return content
    .replace(
      /(["']?(?:password|passwd|authorization|cookie|secret|access[_\s-]*token|refresh[_\s-]*token|api[_\s-]*key)["']?\s*:\s*)(["'])([^"'\r\n]*)(\2)/gi,
      "$1$2[REDACTED]$4",
    )
    .replace(
      /(\b(?:password|passwd|authorization|cookie|secret|access[_\s-]*token|refresh[_\s-]*token|api[_\s-]*key)\b\s*[=:]\s*)([^\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

export async function validateConversationAccessGrant(
  ctx: ConversationAdminCtx,
  input: {
    grantId: Id<"adminAccessGrants">;
    chatId: Id<"chatSessions">;
    adminId: string;
  },
): Promise<Doc<"adminAccessGrants">> {
  const grant = await ctx.db.get("adminAccessGrants", input.grantId);
  if (!grant) {
    throw new ConvexError("Conversation access grant was not found");
  }
  if (grant.adminId !== input.adminId) {
    throw new ConvexError("Conversation access grant does not belong to this administrator");
  }
  if (grant.chatSessionId !== input.chatId) {
    throw new ConvexError("Conversation access grant does not match this conversation");
  }
  if (grant.revokedAt !== undefined) {
    throw new ConvexError("Conversation access grant was revoked");
  }
  if (grant.expiresAt <= Date.now()) {
    throw new ConvexError("Conversation access grant expired");
  }
  if (!(await ctx.db.get("chatSessions", input.chatId))) {
    throw new ConvexError("Conversation was not found");
  }
  return grant;
}

export const createAccessGrant = mutation({
  args: {
    chatId: v.id("chatSessions"),
    purpose: v.string(),
  },
  returns: v.object({
    grantId: v.id("adminAccessGrants"),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const admin = await requireDirectConversationContentAdmin(ctx);
    const purpose = validateAuditReason(args.purpose);
    if (!(await ctx.db.get("chatSessions", args.chatId))) {
      throw new ConvexError("Conversation was not found");
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + ACCESS_GRANT_TTL_MS;
    const correlationId = `grant_${crypto.randomUUID().replaceAll("-", "")}`;
    const grantId = await ctx.db.insert("adminAccessGrants", {
      adminId: admin.userId,
      chatSessionId: args.chatId,
      purpose,
      issuedAt,
      expiresAt,
      correlationId,
    });
    await writeAudit(ctx, {
      actorId: admin.userId,
      actorRoles: admin.roles,
      action: "conversation.access_granted",
      targetType: "chatSession",
      targetId: args.chatId,
      reason: purpose,
      correlationId,
      outcome: "success",
    });
    return { grantId, expiresAt };
  },
});

export const listMessages = query({
  args: {
    chatId: v.id("chatSessions"),
    grantId: v.id("adminAccessGrants"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(messageRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const admin = await requireDirectConversationContentAdmin(ctx);
    await validateConversationAccessGrant(ctx, {
      grantId: args.grantId,
      chatId: args.chatId,
      adminId: admin.userId,
    });
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    ) {
      throw new ConvexError("INVALID_ADMIN_PAGINATION");
    }
    const result = await ctx.db
      .query("messages")
      .withIndex("by_session_and_createdAt", (q) =>
        q.eq("sessionId", args.chatId),
      )
      .order("asc")
      .paginate({
        numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE),
        cursor: args.paginationOpts.cursor,
        maximumRowsRead: MAX_PAGE_SIZE + 1,
      });
    return {
      page: result.page.map((message) => ({
        id: message._id,
        role: message.role,
        content: maskSensitiveFields(message.content),
        createdAt: message.createdAt,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
