import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 50;
const ACCESS_GRANT_TTL_MS = 15 * 60 * 1_000;

type ConversationAdminCtx = QueryCtx | MutationCtx;

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
  messageCount: v.number(),
  updatedAt: v.number(),
  country: v.union(v.string(), v.null()),
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
    await requireEnabledAdminPermission(ctx, "conversation", "read_content");
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

    return {
      page: result.page.map((session) => ({
        id: session._id,
        userId: session.userId,
        externalId: session.externalId,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
        country: session.country ?? null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
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
      /(["']?(?:password|passwd|authorization|cookie|secret|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)["']?\s*:\s*)(["'])([^"'\r\n]*)(\2)/gi,
      "$1$2[REDACTED]$4",
    )
    .replace(
      /(\b(?:password|passwd|authorization|cookie|secret|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)\b\s*[=:]\s*)([^\r\n]+)/gi,
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
    const admin = await requireEnabledAdminPermission(
      ctx,
      "conversation",
      "read_content",
    );
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
    const admin = await requireEnabledAdminPermission(
      ctx,
      "conversation",
      "read_content",
    );
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
