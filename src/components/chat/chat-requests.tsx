"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import type { LocalChatMessage } from "./chat-message-state";
import type { ChatErrorReason } from "@/lib/chat-errors";
import type { ChatAttachment } from "../../../shared/chat-attachments";
import type { BackgroundSubmissionRecovery } from "./use-chat-background-job";

export type DraftAttachment = {
  localId: string;
  file: File;
  state: "selected" | "uploading" | "ready" | "error" | "removing";
  progress: number;
  attachment?: ChatAttachment;
  reservedId?: string;
  error?: string;
};
export type ChatDraft = { query: string; files: DraftAttachment[]; error: string | null };
const emptyDraft: ChatDraft = { query: "", files: [], error: null };

type RequestState = {
  messages: LocalChatMessage[];
  isLoading: boolean;
  saveFailed: boolean;
  ensureError: string | null;
  deleteError: string | null;
  isDeleting: boolean;
  isDeleted: boolean;
  errorReason: ChatErrorReason | null;
  backgroundJobId: string | null;
  backgroundRecovery: BackgroundSubmissionRecovery | null;
};
const emptyState: RequestState = {
  messages: [], isLoading: false, saveFailed: false, ensureError: null,
  deleteError: null, isDeleting: false, isDeleted: false, errorReason: null, backgroundJobId: null, backgroundRecovery: null,
};
type ChatRequest = {
  controller: AbortController;
  ensurePromise: Promise<unknown> | null;
  state: RequestState;
};

function createRequestStore() {
  const requests = new Map<string, ChatRequest>();
  const drafts = new Map<string, ChatDraft>();
  const attachmentOperations = new Map<string, Map<string, AbortController>>();
  const listeners = new Set<() => void>();
  let owner: string | null | undefined;
  const notify = () => listeners.forEach((listener) => listener());
  const cancelAttachments = (id: string) => {
    for (const controller of attachmentOperations.get(id)?.values() ?? []) controller.abort();
    attachmentOperations.delete(id);
  };
  const cancel = (id: string) => {
    const request = requests.get(id);
    request?.controller.abort();
    requests.delete(id);
    notify();
    return request?.ensurePromise ?? null;
  };
  const clear = () => {
    for (const request of requests.values()) request.controller.abort();
    for (const id of attachmentOperations.keys()) cancelAttachments(id);
    requests.clear();
    drafts.clear();
    notify();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: (id: string | null) => id ? requests.get(id) : undefined,
    getDraft: (id: string) => drafts.get(id) ?? emptyDraft,
    updateDraft(id: string, update: (draft: ChatDraft) => ChatDraft) {
      if (requests.get(id)?.state.isDeleted || requests.get(id)?.state.isDeleting) return;
      const draft = update(drafts.get(id) ?? emptyDraft);
      if (!draft.query && !draft.files.length && !draft.error) drafts.delete(id);
      else drafts.set(id, draft);
      notify();
    },
    transferDraftToChat(id: string) {
      const draft = drafts.get("new");
      if (draft) drafts.set(id, draft);
      drafts.delete("new");
      notify();
    },
    startAttachmentOperation(id: string, localId: string) {
      if (requests.get(id)?.state.isDeleted || requests.get(id)?.state.isDeleting
        || !drafts.get(id)?.files.some((file) => file.localId === localId)) return null;
      const pending = attachmentOperations.get(id) ?? new Map<string, AbortController>();
      if (pending.has(localId)) return null;
      const controller = new AbortController();
      pending.set(localId, controller);
      attachmentOperations.set(id, pending);
      return controller;
    },
    finishAttachmentOperation(id: string, localId: string, controller: AbortController) {
      const pending = attachmentOperations.get(id);
      if (pending?.get(localId) !== controller) return;
      pending.delete(localId);
      if (!pending.size) attachmentOperations.delete(id);
    },
    start(id: string) {
      const previous = requests.get(id);
      if (previous?.state.isLoading || previous?.state.isDeleting || previous?.state.isDeleted) return null;
      const request: ChatRequest = {
        controller: new AbortController(),
        ensurePromise: null,
        state: { ...emptyState, messages: previous?.state.messages ?? [], isLoading: true },
      };
      requests.set(id, request);
      notify();
      return request;
    },
    update(id: string, request: ChatRequest, patch: Partial<RequestState>) {
      if (requests.get(id) !== request || request.controller.signal.aborted) return;
      request.state = { ...request.state, ...patch };
      if (patch.isDeleted) {
        cancelAttachments(id);
        drafts.delete(id);
      }
      notify();
    },
    beginDelete(id: string) {
      const ensurePromise = cancel(id);
      cancelAttachments(id);
      const draft = drafts.get(id);
      // Retain a recoverable draft if deleting the chat itself fails.
      if (draft) drafts.set(id, { ...draft, files: draft.files.map((file) =>
        file.state === "removing"
          ? { ...file, state: "selected", attachment: undefined, reservedId: file.attachment?.id ?? file.reservedId }
          : file.state === "uploading"
          ? { ...file, state: "error", error: "Upload cancelled. Try again." }
          : file,
      ) });
      const request: ChatRequest = {
        controller: new AbortController(),
        ensurePromise,
        state: { ...emptyState, isDeleting: true },
      };
      requests.set(id, request);
      notify();
      return request;
    },
    cancel,
    clear,
    setOwner(nextOwner: string | null) {
      if (owner !== undefined && owner !== nextOwner) clear();
      owner = nextOwner;
    },
  };
}

const ChatRequestsContext = createContext<ReturnType<typeof createRequestStore> | null>(null);

export function ChatRequestsProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createRequestStore);
  useEffect(() => () => store.clear(), [store]);
  return <ChatRequestsContext.Provider value={store}>{children}</ChatRequestsContext.Provider>;
}

function useRequestStore() {
  const store = useContext(ChatRequestsContext);
  if (!store) throw new Error("ChatRequestsProvider is required");
  return store;
}

// Only account routes mount this observer; public embeds need no auth request.
export function ChatRequestIdentity() {
  const store = useRequestStore();
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? null;
  useLayoutEffect(() => {
    if (!session.isPending && !session.error) store.setOwner(userId);
  }, [session.isPending, session.error, store, userId]);
  return null;
}

export function useChatRequests(chatId: string | null) {
  const store = useRequestStore();
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.get(chatId)?.state ?? emptyState,
    () => emptyState,
  );
  return { store, ...state };
}

// The root provider keeps private drafts and their operations alive across account routes.
export function useChatDraft(chatId: string) {
  const store = useRequestStore();
  const draft = useSyncExternalStore(store.subscribe, () => store.getDraft(chatId), () => emptyDraft);
  return { store, draft };
}
