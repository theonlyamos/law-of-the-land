import { v } from "convex/values";

export const attachmentKindValidator = v.union(v.literal("document"), v.literal("text"), v.literal("image"));
export const chatAttachmentMetadataValidator = v.object({
  id: v.id("chatAttachments"), filename: v.string(), mimeType: v.string(), byteSize: v.number(), kind: attachmentKindValidator,
});
export { MAX_CHAT_FILE_BYTES as MAX_ATTACHMENT_BYTES, MAX_CHAT_MESSAGE_BYTES as MAX_MESSAGE_ATTACHMENT_BYTES, MAX_CHAT_FILES as MAX_MESSAGE_ATTACHMENTS, MAX_CHAT_CONTEXT_FILES as MAX_CONTEXT_ATTACHMENTS } from "../../shared/chat-attachments";
export const ATTACHMENT_DRAFT_TTL_MS = 24 * 60 * 60_000;
