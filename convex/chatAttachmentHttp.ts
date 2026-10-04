import { makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { ChatAttachment } from "../shared/chat-attachments";
import { MAX_CHAT_FILE_BYTES } from "../shared/chat-attachments";
import { validateChatAttachment } from "../shared/chat-attachment-content";
import { verifyChatAttachmentProof } from "./lib/chatAttachmentProof";

const privateHeaders = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };
const getUploadRef = makeFunctionReference<"mutation">("chatAttachments:getUpload");
const finalizeRef = makeFunctionReference<"mutation">("chatAttachments:finalizeUpload");
const discardRef = makeFunctionReference<"mutation">("chatAttachments:discardUnclaimedUpload");

function uploadHeaders(request: Request): Headers | null {
  const origin = request.headers.get("origin");
  try {
    const allowed = new URL(process.env.SITE_URL ?? "").origin;
    if (origin !== allowed) return null;
    return new Headers({ ...privateHeaders, "access-control-allow-origin": allowed, vary: "Origin" });
  } catch { return null; }
}

async function readBytes(request: Request, maximum: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > maximum) throw new Error("CHAT_ATTACHMENT_SIZE");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("CHAT_ATTACHMENT_SIZE"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export const attachmentUploadOptions = httpAction(async (_ctx, request) => {
  const headers = uploadHeaders(request);
  if (!headers) return new Response(null, { status: 403, headers: privateHeaders });
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, X-Attachment-Id");
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers });
});

export const uploadAttachment = httpAction(async (ctx, request) => {
  const headers = uploadHeaders(request);
  if (!headers) return Response.json({ error: "Upload must start from your chat." }, { status: 403, headers: privateHeaders });
  if (!(await ctx.auth.getUserIdentity())) return Response.json({ error: "Sign in to attach files." }, { status: 401, headers });
  const attachmentId = request.headers.get("x-attachment-id");
  if (!attachmentId || !/^[A-Za-z0-9_-]{1,128}$/u.test(attachmentId)) return Response.json({ error: "Choose the file again." }, { status: 400, headers });
  let storageId: Id<"_storage"> | undefined;
  let validationMessage: string | undefined;
  try {
    const prepared: { attachment: ChatAttachment; ready: boolean } = await ctx.runMutation(getUploadRef, { attachmentId });
    if (prepared.ready) return Response.json({ attachment: prepared.attachment }, { headers });
    const bytes = await readBytes(request, Math.min(prepared.attachment.byteSize, MAX_CHAT_FILE_BYTES));
    if (bytes.byteLength !== prepared.attachment.byteSize) throw new Error("CHAT_ATTACHMENT_SIZE");
    const validated = await validateChatAttachment(bytes, prepared.attachment.filename, prepared.attachment.mimeType).catch(error => {
      // The shared validator supplies bounded product errors without filenames or file contents.
      validationMessage = error instanceof Error ? error.message : undefined;
      throw error;
    });
    storageId = await ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: validated.mimeType }));
    const attachment: ChatAttachment = await ctx.runMutation(finalizeRef, { attachmentId, storageId, ...validated });
    return Response.json({ attachment }, { headers });
  } catch (error) {
    if (error instanceof Error && error.message.includes("CHAT_ATTACHMENT_RATE_LIMITED")) return Response.json({ error: "You have uploaded several files recently. Wait a while and try again." }, { status: 429, headers });
    const size = error instanceof Error && error.message.includes("CHAT_ATTACHMENT_SIZE");
    return Response.json({ error: validationMessage ?? (size ? "Each file must be 10 MB or smaller and upload completely." : "This file could not be read or saved. Check its format and try again.") }, { status: size ? 413 : 400, headers });
  } finally {
    // A concurrent retry may have won, or the draft/chat may have been removed mid-upload.
    // The mutation checks references before deleting, including after an ambiguous finalize result.
    if (storageId) await ctx.runMutation(discardRef, { storageId });
  }
});

export const resolveAttachments = httpAction(async (ctx, request) => {
  if (!(await ctx.auth.getUserIdentity())) return new Response(null, { status: 401, headers: privateHeaders });
  const operation = new URL(request.url).pathname.endsWith("/file") ? "file" : "resolve";
  try {
    const bytes = await readBytes(request, 4096);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!await verifyChatAttachmentProof(operation, body, Number(request.headers.get("x-file-issued-at")), request.headers.get("x-file-proof") ?? "")) return new Response(null, { status: 401, headers: privateHeaders });
    const input: unknown = JSON.parse(body);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request");
    const record = input as Record<string, unknown>;
    if (operation === "file") {
      if (Object.keys(record).length !== 1 || typeof record.attachmentId !== "string") throw new Error("Invalid request");
      const result: unknown = await ctx.runQuery(makeFunctionReference<"query">("chatAttachments:getFile"), { attachmentId: record.attachmentId });
      return Response.json(result, { headers: privateHeaders });
    }
    if (Object.keys(record).length !== 2 || typeof record.externalId !== "string" || !Array.isArray(record.attachmentIds)
      || record.attachmentIds.length > 5 || record.attachmentIds.some(id => typeof id !== "string")) throw new Error("Invalid request");
    const result: unknown = await ctx.runQuery(makeFunctionReference<"query">("chatAttachments:resolve"), { externalId: record.externalId, attachmentIds: record.attachmentIds });
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    const limited = error instanceof Error && /CHAT_ATTACHMENT_(?:CONTEXT_)?LIMIT/u.test(error.message);
    return Response.json({ error: limited ? "CHAT_ATTACHMENT_CONTEXT_LIMIT" : "CHAT_ATTACHMENT_UNAVAILABLE" }, { status: limited ? 413 : 404, headers: privateHeaders });
  }
});
