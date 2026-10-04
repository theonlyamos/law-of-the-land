"use client";

import { useCallback } from "react";
import { useChatDraft, type DraftAttachment } from "./chat-requests";
import {
  MAX_CHAT_FILES,
  MAX_CHAT_MESSAGE_BYTES,
  validateChatAttachmentSelection,
  type ChatAttachment,
} from "../../../shared/chat-attachments";

export type { DraftAttachment } from "./chat-requests";

const NEW_CHAT = "new";
const ATTACHMENT_REQUEST_TIMEOUT_MS = 30_000;

/** Bound the whole control request, including success and error response bodies. */
async function attachmentRequest(url: string, init: RequestInit, signal: AbortSignal, fallback: string) {
  signal.throwIfAborted();
  const controller = new AbortController();
  let cancel!: () => void;
  let timeout!: ReturnType<typeof setTimeout>;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new DOMException("Upload cancelled", "AbortError")); };
    signal.addEventListener("abort", cancel, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("The file request took too long. Try again."));
    }, ATTACHMENT_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const data = response.status === 204 ? null : await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : fallback);
      return data;
    })(), cancelled]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

function uploadFile({ file, uploadUrl, token, attachmentId, signal, onProgress }: {
  file: File;
  uploadUrl: string;
  token: string;
  attachmentId: string;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", uploadUrl);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("x-attachment-id", attachmentId);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      finish();
      let data: { attachment?: ChatAttachment; error?: string };
      try { data = JSON.parse(xhr.responseText) as typeof data; }
      catch { reject(new Error("The upload could not be verified. Try again.")); return; }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment?.id === attachmentId) {
        resolve(data.attachment);
      } else {
        reject(new Error(data.error || "We could not upload this file. Try again."));
      }
    };
    xhr.onerror = () => { finish(); reject(new Error("Upload interrupted. Check your connection and retry.")); };
    xhr.ontimeout = () => { finish(); reject(new Error("The upload took too long. Try again.")); };
    xhr.onabort = () => { finish(); reject(new DOMException("Upload cancelled", "AbortError")); };
    if (signal.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

/** Private drafts share the root request lifecycle and remain isolated by chat. */
export function useChatAttachments(chatId: string | null) {
  const activeKey = chatId ?? NEW_CHAT;
  const { store, draft } = useChatDraft(activeKey);
  const updateDraft = store.updateDraft;
  const setQuery = useCallback((value: string | ((previous: string) => string)) => {
    updateDraft(activeKey, (current) => ({
      ...current, query: typeof value === "function" ? value(current.query) : value,
    }));
  }, [activeKey, updateDraft]);
  const addFiles = useCallback((selected: File[]) => {
    updateDraft(activeKey, (current) => {
      const files = [...current.files];
      const errors: string[] = [];
      for (const file of selected) {
        const invalid = validateChatAttachmentSelection(file);
        if (invalid) { errors.push(`${file.name}: ${invalid}`); continue; }
        if (files.length >= MAX_CHAT_FILES) { errors.push(`Attach up to ${MAX_CHAT_FILES} files per message.`); break; }
        if (files.reduce((total, item) => total + item.file.size, 0) + file.size > MAX_CHAT_MESSAGE_BYTES) {
          errors.push("Files must total 25 MB or less per message.");
          continue;
        }
        files.push({ localId: crypto.randomUUID(), file, state: "selected", progress: 0 });
      }
      return { ...current, files, error: [...new Set(errors)].join(" ") || null };
    });
  }, [activeKey, updateDraft]);
  const transferToChat = useCallback((externalId: string) => {
    store.transferDraftToChat(externalId);
  }, [store]);
  const updateFile = useCallback((key: string, id: string, patch: Partial<DraftAttachment>) => {
    updateDraft(key, (current) => ({ ...current, files: current.files.map((file) => file.localId === id ? { ...file, ...patch } : file) }));
  }, [updateDraft]);

  const uploadFiles = useCallback(async (externalId: string, files: DraftAttachment[], parentSignal?: AbortSignal) => {
    const uploaded: ChatAttachment[] = [];
    for (const item of files) {
      parentSignal?.throwIfAborted();
      if (item.attachment) { uploaded.push(item.attachment); continue; }
      const operation = store.startAttachmentOperation(externalId, item.localId);
      if (!operation) throw new DOMException("Upload cancelled", "AbortError");
      const signal = operation.signal;
      const abort = () => operation.abort();
      parentSignal?.addEventListener("abort", abort, { once: true });
      updateFile(externalId, item.localId, { state: "uploading", progress: 0, error: undefined });
      try {
        if (item.reservedId) {
          await attachmentRequest(`/api/chat/attachments/${encodeURIComponent(item.reservedId)}`, { method: "DELETE" }, signal, "We could not reset this upload. Try again.");
        }
        const prepared = await attachmentRequest("/api/chat/attachments", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ externalId, filename: item.file.name, mimeType: item.file.type, byteSize: item.file.size }),
        }, signal, "We could not prepare this upload. Try again.");
        signal.throwIfAborted();
        if (typeof prepared?.attachmentId !== "string" || typeof prepared.uploadUrl !== "string" || typeof prepared.token !== "string") {
          throw new Error("We could not prepare this upload. Try again.");
        }
        const { attachmentId, uploadUrl, token } = prepared;
        updateFile(externalId, item.localId, { reservedId: attachmentId });
        const attachment = await uploadFile({ attachmentId, uploadUrl, token, file: item.file, signal,
          onProgress: (progress) => { if (!signal.aborted) updateFile(externalId, item.localId, { progress }); },
        });
        signal.throwIfAborted();
        updateFile(externalId, item.localId, { state: "ready", progress: 100, attachment });
        uploaded.push(attachment);
      } catch (error) {
        if (!signal.aborted) updateFile(externalId, item.localId, {
          state: "error", error: error instanceof Error ? error.message : "Upload failed. Try again.",
        });
        throw error;
      } finally {
        parentSignal?.removeEventListener("abort", abort);
        store.finishAttachmentOperation(externalId, item.localId, operation);
      }
    }
    return uploaded;
  }, [store, updateFile]);

  const removeFile = useCallback(async (item: DraftAttachment) => {
    const operation = store.startAttachmentOperation(activeKey, item.localId);
    if (!operation) return;
    const storedId = item.attachment?.id ?? item.reservedId;
    try {
      if (storedId) {
        updateFile(activeKey, item.localId, { state: "removing" });
        await attachmentRequest(`/api/chat/attachments/${encodeURIComponent(storedId)}`, { method: "DELETE" }, operation.signal, "Could not remove this file. Try again.");
      }
      operation.signal.throwIfAborted();
      updateDraft(activeKey, (current) => ({ ...current, files: current.files.filter((file) => file.localId !== item.localId), error: null }));
    } catch (error) {
      if (!operation.signal.aborted) {
        // A missing response does not prove DELETE failed; keep the File, not a possibly deleted reference.
        updateFile(activeKey, item.localId, { state: item.attachment ? "selected" : item.state, attachment: undefined, reservedId: storedId });
        updateDraft(activeKey, (current) => ({ ...current, error: error instanceof Error ? error.message : "Could not remove this file." }));
      }
    } finally {
      store.finishAttachmentOperation(activeKey, item.localId, operation);
    }
  }, [activeKey, store, updateDraft, updateFile]);

  const retryFile = useCallback(async (item: DraftAttachment) => {
    if (!chatId) return;
    try { await uploadFiles(chatId, [item]); }
    catch { /* The card keeps the actionable upload error. */ }
  }, [chatId, uploadFiles]);

  const clearSentDraft = useCallback((externalId: string, query: string, files: DraftAttachment[]) => {
    const sentIds = new Set(files.map((file) => file.localId));
    updateDraft(externalId, (current) => ({
      query: current.query === query ? "" : current.query,
      files: current.files.filter((file) => !sentIds.has(file.localId)), error: null,
    }));
  }, [updateDraft]);

  return { ...draft, setQuery, addFiles, removeFile, retryFile, uploadFiles, transferToChat, clearSentDraft };
}
