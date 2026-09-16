"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import type { LocalChatMessage } from "./chat-message-state";

type RequestState = {
  messages: LocalChatMessage[];
  isLoading: boolean;
  saveFailed: boolean;
  ensureError: string | null;
  deleteError: string | null;
  isDeleting: boolean;
  isDeleted: boolean;
};
const emptyState: RequestState = {
  messages: [], isLoading: false, saveFailed: false, ensureError: null,
  deleteError: null, isDeleting: false, isDeleted: false,
};
type ChatRequest = {
  controller: AbortController;
  ensurePromise: Promise<unknown> | null;
  state: RequestState;
};

function createRequestStore() {
  const requests = new Map<string, ChatRequest>();
  const listeners = new Set<() => void>();
  let owner: string | null | undefined;
  const notify = () => listeners.forEach((listener) => listener());
  const cancel = (id: string) => {
    const request = requests.get(id);
    request?.controller.abort();
    requests.delete(id);
    notify();
    return request?.ensurePromise ?? null;
  };
  const clear = () => {
    for (const request of requests.values()) request.controller.abort();
    requests.clear();
    notify();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: (id: string | null) => id ? requests.get(id) : undefined,
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
      notify();
    },
    beginDelete(id: string) {
      const ensurePromise = cancel(id);
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
