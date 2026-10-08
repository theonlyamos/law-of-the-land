import "server-only";
import { createChatAttachmentProof } from "../../convex/lib/chatAttachmentProof";
import {
  chatAttachmentFormat, MAX_CHAT_CONTEXT_CHARACTERS, MAX_CHAT_CONTEXT_FILES,
  MAX_CHAT_DOCUMENT_PAGES, MAX_CHAT_FILE_BYTES, MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_TEXT_CHARACTERS, type ChatAttachment,
} from "../../shared/chat-attachments";
import type { ChatModelAttachment } from "./gemini-file-search-chat";

export class ChatAttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function readAttachmentBody(input: Request | Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = input.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new ChatAttachmentError("The file or request is too large.", 413);
  const reader = input.body?.getReader();
  if (!reader) return new Uint8Array();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal?.aborted) throw new ChatAttachmentError("The file request was interrupted.");
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new ChatAttachmentError("The file request was interrupted.");
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new ChatAttachmentError("The file or request is too large.", 413); }
      chunks.push(value);
    }
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function callChatAttachmentBridge(operation: "resolve" | "file", input: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<unknown> {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site) throw new ChatAttachmentError("Attachments are unavailable right now.", 503);
  const body = JSON.stringify(input);
  const issuedAt = Date.now();
  const proof = await createChatAttachmentProof(operation, body, issuedAt);
  const response = await fetch(new URL(`/private/chat-attachments/${operation}`, site), {
    method: "POST", body, cache: "no-store", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-file-issued-at": String(issuedAt), "x-file-proof": proof },
  });
  if (!response.ok) {
    if (response.status === 413) throw new ChatAttachmentError("This chat has more file content than one answer can read. Start a new chat with fewer or smaller files.", 413);
    throw new ChatAttachmentError("The attachment is unavailable or you no longer have access to it.", response.status === 401 ? 401 : 404);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readAttachmentBody(response, 1024 * 1024, signal))); }
  catch (error) { if (error instanceof ChatAttachmentError) throw error; throw new ChatAttachmentError("The attachment could not be read.", 502); }
}

type PrivateAttachment = ChatAttachment & { url: string; extractedText?: string; pageCount?: number };

export function parsePrivateAttachment(value: unknown, requireId = true): PrivateAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatAttachmentError("The attachment could not be read.", 502);
  const file = value as Record<string, unknown>;
  if ((requireId && (typeof file.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(file.id)))
    || typeof file.filename !== "string" || file.filename.length > 180
    || typeof file.mimeType !== "string" || typeof file.url !== "string"
    || !Number.isSafeInteger(file.byteSize) || (file.byteSize as number) < 1 || (file.byteSize as number) > MAX_CHAT_FILE_BYTES
    || !["document", "text", "image"].includes(String(file.kind))) throw new ChatAttachmentError("The attachment could not be read.", 502);
  const format = chatAttachmentFormat(file.filename, file.mimeType);
  if (!format || format.mimeType !== file.mimeType || format.kind !== file.kind) throw new ChatAttachmentError("The attachment could not be read.", 502);
  const url = new URL(file.url);
  const allowed = [process.env.NEXT_PUBLIC_CONVEX_URL, process.env.NEXT_PUBLIC_CONVEX_SITE_URL].filter(Boolean).map(value => new URL(value!).origin);
  if (!allowed.includes(url.origin) || !url.pathname.startsWith("/api/storage/") || url.username || url.password) throw new ChatAttachmentError("The attachment could not be read.", 502);
  if (file.extractedText !== undefined && (typeof file.extractedText !== "string" || file.extractedText.length > MAX_CHAT_TEXT_CHARACTERS || !file.extractedText.trim())) throw new ChatAttachmentError("The attachment could not be read.", 502);
  if (file.pageCount !== undefined && (!Number.isInteger(file.pageCount) || (file.pageCount as number) < 1 || (file.pageCount as number) > MAX_CHAT_DOCUMENT_PAGES)) throw new ChatAttachmentError("The attachment could not be read.", 502);
  return file as PrivateAttachment;
}

export type ChatAttachmentContext = {
  attachments: ChatModelAttachment[];
  attachmentIds: string[];
  selectedJurisdiction: { id: string; name: string; kind: "geographic" | "organizational" };
};

export async function loadChatAttachmentContext(externalId: string, attachmentIds: string[], token: string, signal: AbortSignal): Promise<ChatAttachmentContext> {
  const result = await callChatAttachmentBridge("resolve", { externalId, attachmentIds }, token, signal);
  if (!result || typeof result !== "object" || !("attachments" in result) || !Array.isArray(result.attachments) || !("selectedJurisdiction" in result)) throw new ChatAttachmentError("The attachments could not be read.", 502);
  const jurisdiction = result.selectedJurisdiction as ChatAttachmentContext["selectedJurisdiction"];
  if (!jurisdiction || typeof jurisdiction.id !== "string" || typeof jurisdiction.name !== "string" || !["geographic", "organizational"].includes(jurisdiction.kind)) throw new ChatAttachmentError("The attachments could not be read.", 502);
  if (result.attachments.length > MAX_CHAT_CONTEXT_FILES) throw new ChatAttachmentError("This chat has too many files to read at once. Start a new chat with fewer files.", 413);
  const files = result.attachments.map(file => parsePrivateAttachment(file));
  const ids = new Set(files.map(file => file.id));
  if (ids.size !== files.length || attachmentIds.some(id => !ids.has(id))) throw new ChatAttachmentError("The attachments could not be read.", 502);
  const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
  const totalCharacters = files.reduce((sum, file) => sum + (file.extractedText?.length ?? 0), 0);
  const totalPages = files.reduce((sum, file) => sum + (file.pageCount ?? 0), 0);
  if (totalBytes > MAX_CHAT_MESSAGE_BYTES || totalCharacters > MAX_CHAT_CONTEXT_CHARACTERS || totalPages > MAX_CHAT_DOCUMENT_PAGES) throw new ChatAttachmentError("These files contain too much content for one answer. Start a new chat with fewer files or shorter documents.", 413);
  const attachments: ChatModelAttachment[] = [];
  // Sequential reads keep the peak memory bounded while base64 copies are made.
  for (const file of files) {
    const base = { id: file.id, filename: file.filename, mimeType: file.mimeType, kind: file.kind };
    if (file.extractedText !== undefined) { attachments.push({ ...base, kind: "text", text: file.extractedText }); continue; }
    if (file.kind !== "image" && file.mimeType !== "application/pdf") throw new ChatAttachmentError("This document has no readable text. Upload it again.");
    const response = await fetch(file.url, { cache: "no-store", signal, redirect: "error" });
    if (!response.ok) throw new ChatAttachmentError("A saved file could not be read. Please try again.", 503);
    const bytes = await readAttachmentBody(response, file.byteSize, signal);
    if (bytes.byteLength !== file.byteSize) throw new ChatAttachmentError("A saved file could not be read. Please upload it again.");
    attachments.push({ ...base, data: Buffer.from(bytes).toString("base64") });
  }
  return { attachments, attachmentIds: files.map(file => file.id), selectedJurisdiction: jurisdiction };
}
