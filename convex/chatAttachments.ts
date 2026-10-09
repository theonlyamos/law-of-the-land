import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/requireUser";
import { canAccessSession } from "./chats";
import { attachmentKindValidator, chatAttachmentMetadataValidator, ATTACHMENT_DRAFT_TTL_MS, MAX_CONTEXT_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS } from "./lib/chatAttachmentContracts";
import { chatAttachmentFormat, chatAttachmentBackendUploadsEnabled, validateChatAttachmentSelection, MAX_CHAT_CONTEXT_CHARACTERS, MAX_CHAT_DOCUMENT_PAGES, MAX_CHAT_TEXT_CHARACTERS } from "../shared/chat-attachments";
import { consumeRateBucket } from "./lib/rateBuckets";

type AttachmentCtx = QueryCtx | MutationCtx;
const expireDraftRef = makeFunctionReference<"mutation">("chatAttachments:expireDraft");
const deleteBatchRef = makeFunctionReference<"mutation">("chatAttachments:deleteSessionBatch");

function unavailable(): never { throw new ConvexError("CHAT_ATTACHMENT_UNAVAILABLE"); }
function requireUploadsEnabled(): void {
  if (!chatAttachmentBackendUploadsEnabled(process.env)) throw new ConvexError("CHAT_ATTACHMENT_UPLOADS_DISABLED");
}

export function attachmentMetadata(row: Doc<"chatAttachments">) {
  return { id: row._id, filename: row.filename, mimeType: row.mimeType, byteSize: row.byteSize, kind: row.kind };
}

export async function ownedAttachmentSession(ctx: AttachmentCtx, externalId: string): Promise<Doc<"chatSessions">> {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q => q.eq("userId", userId).eq("externalId", externalId)).unique();
  if (!session || !(await canAccessSession(ctx, session))) unavailable();
  return session;
}

async function ownedAttachment(ctx: AttachmentCtx, attachmentId: Id<"chatAttachments">): Promise<Doc<"chatAttachments">> {
  const userId = await requireUserId(ctx);
  const attachment = await ctx.db.get("chatAttachments", attachmentId);
  if (!attachment || attachment.userId !== userId || (attachment.expiresAt !== undefined && attachment.expiresAt <= Date.now())) unavailable();
  const session = await ctx.db.get("chatSessions", attachment.sessionId);
  if (!session || session.userId !== userId || !(await canAccessSession(ctx, session))) unavailable();
  return attachment;
}

/** The caller must already hold current owner and jurisdiction authority for session. */
export async function checkedAttachments(ctx: AttachmentCtx, session: Doc<"chatSessions">, ids: readonly string[], maximum = MAX_CONTEXT_ATTACHMENTS): Promise<Doc<"chatAttachments">[]> {
  if (ids.length > maximum || new Set(ids).size !== ids.length) throw new ConvexError("CHAT_ATTACHMENT_LIMIT");
  const rows: Doc<"chatAttachments">[] = [];
  for (const id of ids) {
    const normalized = ctx.db.normalizeId("chatAttachments", id);
    const row = normalized ? await ctx.db.get("chatAttachments", normalized) : null;
    if (!row || row.sessionId !== session._id || row.userId !== session.userId || row.status !== "ready" || !row.storageId
      || (row.expiresAt !== undefined && row.expiresAt <= Date.now())) unavailable();
    if (!(await ctx.db.system.get("_storage", row.storageId))) unavailable();
    rows.push(row);
  }
  if (rows.reduce((total, row) => total + row.byteSize, 0) > MAX_MESSAGE_ATTACHMENT_BYTES
    || rows.reduce((total, row) => total + (row.extractedText?.length ?? 0), 0) > MAX_CHAT_CONTEXT_CHARACTERS
    || rows.reduce((total, row) => total + (row.pageCount ?? 0), 0) > MAX_CHAT_DOCUMENT_PAGES) throw new ConvexError("CHAT_ATTACHMENT_CONTEXT_LIMIT");
  return rows;
}

export const prepareUpload = mutation({
  args: { externalId: v.string(), filename: v.string(), mimeType: v.string(), byteSize: v.number() },
  returns: v.object({ attachmentId: v.id("chatAttachments") }),
  handler: async (ctx, args) => {
    requireUploadsEnabled();
    const session = await ownedAttachmentSession(ctx, args.externalId);
    const filename = args.filename.trim();
    const type = chatAttachmentFormat(filename, args.mimeType);
    if (!type || validateChatAttachmentSelection({ name: args.filename, type: args.mimeType, size: args.byteSize })) throw new ConvexError("CHAT_ATTACHMENT_INVALID");
    const now = Date.now();
    const liveDrafts = await ctx.db.query("chatAttachments").withIndex("by_sessionId_and_expiresAt", q => q.eq("sessionId", session._id).gt("expiresAt", now)).take(MAX_MESSAGE_ATTACHMENTS + 1);
    if (liveDrafts.length >= MAX_MESSAGE_ATTACHMENTS || liveDrafts.reduce((total, row) => total + row.byteSize, args.byteSize) > MAX_MESSAGE_ATTACHMENT_BYTES) throw new ConvexError("CHAT_ATTACHMENT_LIMIT");
    const userDrafts = await ctx.db.query("chatAttachments").withIndex("by_userId_and_expiresAt", q => q.eq("userId", session.userId).gt("expiresAt", now)).take(40);
    if (userDrafts.length >= 40) throw new ConvexError("CHAT_ATTACHMENT_LIMIT");
    if (await consumeRateBucket(ctx, "chat-attachment-prepare", session.userId, 60, 60 * 60_000)) throw new ConvexError("CHAT_ATTACHMENT_RATE_LIMITED");
    const expiresAt = now + ATTACHMENT_DRAFT_TTL_MS;
    const attachmentId = await ctx.db.insert("chatAttachments", { sessionId: session._id, userId: session.userId, filename, mimeType: type.mimeType, kind: type.kind, byteSize: args.byteSize, status: "pending", createdAt: now, expiresAt });
    await ctx.scheduler.runAt(expiresAt, expireDraftRef, { attachmentId });
    return { attachmentId };
  },
});

export const getUpload = internalMutation({
  args: { attachmentId: v.id("chatAttachments") },
  returns: v.object({ attachment: chatAttachmentMetadataValidator, ready: v.boolean() }),
  handler: async (ctx, { attachmentId }) => {
    // Raw HTTP uploads invoke this before reading bytes or allocating storage.
    // Saved-file reads and cleanup use separate owner-authorized boundaries.
    requireUploadsEnabled();
    const row = await ownedAttachment(ctx, attachmentId);
    if (row.messageClientId !== undefined) unavailable();
    if (await consumeRateBucket(ctx, "chat-attachment-upload", row.userId, 120, 60 * 60_000)) throw new ConvexError("CHAT_ATTACHMENT_RATE_LIMITED");
    return { attachment: attachmentMetadata(row), ready: row.status === "ready" };
  },
});

export const finalizeUpload = internalMutation({
  args: { attachmentId: v.id("chatAttachments"), storageId: v.id("_storage"), mimeType: v.string(), kind: attachmentKindValidator, extractedText: v.optional(v.string()), pageCount: v.optional(v.number()) },
  returns: chatAttachmentMetadataValidator,
  handler: async (ctx, args) => {
    // Recheck after bytes arrive so disabling the capability also closes an
    // upload already in flight; the HTTP finally block discards unclaimed bytes.
    requireUploadsEnabled();
    const row = await ownedAttachment(ctx, args.attachmentId);
    if (row.messageClientId !== undefined) unavailable();
    const stored = await ctx.db.system.get("_storage", args.storageId);
    if (!stored || stored.size !== row.byteSize || (stored.contentType !== undefined && stored.contentType !== args.mimeType) || row.mimeType !== args.mimeType || row.kind !== args.kind
      || (args.extractedText !== undefined && args.extractedText.length > MAX_CHAT_TEXT_CHARACTERS)
      || (args.pageCount !== undefined && (!Number.isSafeInteger(args.pageCount) || args.pageCount < 1 || args.pageCount > MAX_CHAT_DOCUMENT_PAGES))) throw new ConvexError("CHAT_ATTACHMENT_CONTENT_INVALID");
    if (row.status === "ready") {
      const existing = row.storageId ? await ctx.db.system.get("_storage", row.storageId) : null;
      if (!existing || existing.sha256 !== stored.sha256) throw new ConvexError("CHAT_ATTACHMENT_UPLOAD_CONFLICT");
      return attachmentMetadata(row);
    }
    const claimed = await ctx.db.query("chatAttachments").withIndex("by_storageId", q => q.eq("storageId", args.storageId)).take(1);
    if (claimed.length) throw new ConvexError("CHAT_ATTACHMENT_UPLOAD_CONFLICT");
    await ctx.db.patch(row._id, { storageId: args.storageId, status: "ready", extractedText: args.extractedText, pageCount: args.pageCount });
    return attachmentMetadata(row);
  },
});

export const discardUnclaimedUpload = internalMutation({
  args: { storageId: v.id("_storage") }, returns: v.null(),
  handler: async (ctx, { storageId }) => {
    const claimed = await ctx.db.query("chatAttachments").withIndex("by_storageId", q => q.eq("storageId", storageId)).take(1);
    if (!claimed.length && await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId);
    return null;
  },
});

export const remove = mutation({
  args: { attachmentId: v.id("chatAttachments") }, returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, { attachmentId }) => {
    await requireUserId(ctx);
    if (!await ctx.db.get("chatAttachments", attachmentId)) return { deleted: false };
    const row = await ownedAttachment(ctx, attachmentId);
    if (row.messageClientId !== undefined) throw new ConvexError("CHAT_ATTACHMENT_ALREADY_SENT");
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
    return { deleted: true };
  },
});

export const resolve = internalQuery({
  args: { externalId: v.string(), attachmentIds: v.array(v.string()) },
  returns: v.object({
    selectedJurisdiction: v.object({ id: v.id("jurisdictions"), name: v.string(), kind: v.union(v.literal("geographic"), v.literal("organizational")) }),
    attachments: v.array(v.object({ ...chatAttachmentMetadataValidator.fields, url: v.string(), extractedText: v.optional(v.string()), pageCount: v.optional(v.number()) })),
  }),
  handler: async (ctx, args) => {
    const session = await ownedAttachmentSession(ctx, args.externalId);
    if (!session.jurisdictionId || !session.jurisdictionName || !session.jurisdictionKind) unavailable();
    if (args.attachmentIds.length > MAX_MESSAGE_ATTACHMENTS || new Set(args.attachmentIds).size !== args.attachmentIds.length) throw new ConvexError("CHAT_ATTACHMENT_LIMIT");
    const saved = await ctx.db.query("chatAttachments").withIndex("by_sessionId_and_messageClientId", q => q.eq("sessionId", session._id).gt("messageClientId", undefined)).take(MAX_CONTEXT_ATTACHMENTS + 1);
    const ids = [...new Set([...saved.map(row => row._id), ...args.attachmentIds])];
    const rows = await checkedAttachments(ctx, session, ids);
    const attachments = await Promise.all(rows.map(async row => {
      const url = await ctx.storage.getUrl(row.storageId!);
      if (!url) unavailable();
      return { ...attachmentMetadata(row), url, extractedText: row.extractedText, pageCount: row.pageCount };
    }));
    return { selectedJurisdiction: { id: session.jurisdictionId, name: session.jurisdictionName, kind: session.jurisdictionKind }, attachments };
  },
});

export const getFile = internalQuery({
  args: { attachmentId: v.id("chatAttachments") },
  returns: v.object({ ...chatAttachmentMetadataValidator.fields, url: v.string() }),
  handler: async (ctx, { attachmentId }) => {
    const row = await ownedAttachment(ctx, attachmentId);
    if (row.status !== "ready" || !row.storageId) unavailable();
    const url = await ctx.storage.getUrl(row.storageId);
    if (!url) unavailable();
    return { ...attachmentMetadata(row), url };
  },
});

export const expireDraft = internalMutation({
  args: { attachmentId: v.id("chatAttachments") }, returns: v.null(),
  handler: async (ctx, { attachmentId }) => {
    const row = await ctx.db.get("chatAttachments", attachmentId);
    if (row && row.messageClientId === undefined && row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const deleteSessionBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") }, returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const rows = await ctx.db.query("chatAttachments").withIndex("by_sessionId", q => q.eq("sessionId", sessionId)).take(50);
    for (const row of rows) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    if (rows.length === 50) await ctx.scheduler.runAfter(0, deleteBatchRef, { sessionId });
    return null;
  },
});
