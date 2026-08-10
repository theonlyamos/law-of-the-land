"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Menu } from "lucide-react";
import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import { PageLoader, Spinner } from "@/components/ui/spinner";
import type { ChatSession } from "@/lib/chat-sessions";
import { PublicJurisdictionSelector } from "@/components/landing/public-jurisdiction-selector";
import { ResearchJurisdictionPicker } from "@/components/jurisdictions/research-jurisdiction-picker";
import {
  chooseJurisdictionCode,
  findJurisdiction,
  type ChatCitation,
  type PartialCoverage,
  type PublicJurisdiction,
  type ResearchJurisdiction,
} from "@/lib/countries";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  beginComposerBottomScroll,
  beginPrependScroll,
  canCommitRequestGeneration,
  clearRejectedRouteEnsure,
  consumeComposerBottomScroll,
  consumePrependScroll,
  reconcileChatMessages,
  routeAfterDeletingCurrentSession,
  runAfterRouteEnsure,
  runRemovalAfterRouteEnsure,
  startOrReuseRouteEnsure,
  shouldEnsureForNewSubmission,
  type LocalChatMessage,
  type ComposerBottomScrollIntent,
  type PersistedChatMessage,
  type PrependScrollIntent,
  type RouteEnsureEntry,
} from "./chat-message-state";

const THREAD_RAIL = "mx-auto w-full max-w-3xl px-4";

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, data?.error);
  }
  return (await response.json()) as T;
}

class ApiError extends Error {
  status: number;
  serverMessage?: string;

  constructor(status: number, serverMessage?: string) {
    super(serverMessage ?? `Request failed with status ${status}`);
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

function answerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your sign-in expired, so this question was not sent. Sign in again to continue.";
    }
    if (error.status === 402) {
      const base =
        error.serverMessage ?? "You have reached your question limit for today.";
      return `${base}\n\n[See plans and upgrade](/settings/billing)`;
    }
    if (error.status === 429) {
      return (
        error.serverMessage ??
        "You have sent several questions in a short time. Wait a minute, then try again."
      );
    }
    if (error.serverMessage) return error.serverMessage;
  }
  return "We could not finish that answer. Check your connection, wait a moment, and try again. If it keeps happening, try a shorter or simpler question.";
}

function toSidebarSession(session: {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
}): ChatSession {
  return {
    id: session.id,
    title: session.title,
    lastMessage: session.lastMessage,
    timestamp: new Date(session.timestamp),
    messageCount: session.messageCount,
    messages: [],
  };
}

interface ChatWorkspaceProps {
  /** null renders the "new chat" composer; the chat is created on first send. */
  chatId: string | null;
  initialQuery: string | null;
  /** Jurisdiction for a chat being created via ?country=; existing chats use their stored value. */
  initialCountry?: string | null;
  /** Stable jurisdiction for a chat being created via ?jurisdiction=. */
  initialJurisdiction?: string | null;
}

export function ChatWorkspace({ chatId, initialQuery, initialCountry, initialJurisdiction }: ChatWorkspaceProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const unifiedJurisdictionsEnabled = useQuery(api.jurisdictions.isUnifiedJurisdictionsEnabled);
  const publicJurisdictions = useQuery(
    api.jurisdictions.listPublicEnabled,
    unifiedJurisdictionsEnabled === false ? {} : "skip",
  );
  const jurisdictions: readonly PublicJurisdiction[] = publicJurisdictions ?? [];
  const [query, setQuery] = useState("");
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedResearchJurisdiction, setSelectedResearchJurisdiction] = useState<ResearchJurisdiction | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletingCurrentChat, setIsDeletingCurrentChat] = useState(false);
  const [isCurrentChatDeleted, setIsCurrentChatDeleted] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const messagesScrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());
  const routeEnsureRef = useRef<RouteEnsureEntry | null>(null);
  const observedSessionIdsRef = useRef<Set<string>>(new Set());
  const requestGenerationRef = useRef(0);
  const activeChatIdRef = useRef(chatId);
  const activeRequestRef = useRef<AbortController | null>(null);
  const localSequenceRef = useRef(0);
  const prependScrollIntentRef = useRef<PrependScrollIntent | null>(null);
  const composerScrollIntentRef = useRef<ComposerBottomScrollIntent | null>(null);
  activeChatIdRef.current = chatId;

  const {
    results: sessionsData,
    status: sessionsPaginationStatus,
    loadMore: loadMoreSessions,
  } = usePaginatedQuery(api.chats.list, isAuthenticated ? {} : "skip", {
    initialNumItems: 30,
  });
  const sessionData = useQuery(
    api.chats.getByExternalId,
    isAuthenticated && chatId ? { externalId: chatId } : "skip"
  );
  const resolvedInitialSelection = useQuery(
    api.jurisdictions.resolveResearchSelection,
    unifiedJurisdictionsEnabled === true &&
      !sessionData?.jurisdictionId &&
      (initialJurisdiction || sessionData?.country || initialCountry)
      ? {
          ...(!sessionData && initialJurisdiction ? { jurisdictionId: initialJurisdiction as Id<"jurisdictions"> } : {}),
          ...(sessionData?.country || initialCountry ? { country: sessionData?.country ?? initialCountry! } : {}),
        }
      : "skip",
  );
  const {
    results: messageResults,
    status: messagesPaginationStatus,
    loadMore: loadMoreMessages,
  } = usePaginatedQuery(
    api.chats.listMessages,
    isAuthenticated && chatId ? { externalId: chatId } : "skip",
    { initialNumItems: 50 }
  );
  const ensureSession = useMutation(api.chats.ensure);
  const appendMessages = useMutation(api.chats.appendMessages);
  const removeSession = useMutation(api.chats.remove);

  const sessions = sessionsData.map(toSidebarSession);
  useEffect(() => {
    if (publicJurisdictions === undefined) return;
    setSelectedCountry((current) =>
      chooseJurisdictionCode(publicJurisdictions, current || initialCountry),
    );
  }, [initialCountry, publicJurisdictions]);
  const persistedMessages = useMemo<PersistedChatMessage[]>(() => {
    const byStorageId = new Map<string, PersistedChatMessage>();
    for (const message of messageResults) {
      byStorageId.set(message.storageId, {
        storageId: message.storageId,
        clientId: message.clientId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        creationTime: message.creationTime,
        citations: message.citations,
      });
    }
    return [...byStorageId.values()].sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        a.creationTime - b.creationTime ||
        a.storageId.localeCompare(b.storageId)
    );
  }, [messageResults]);
  const displayMessages = useMemo(
    () => reconcileChatMessages({ persisted: persistedMessages, local: localMessages }),
    [localMessages, persistedMessages]
  );
  const isChatLoading =
    chatId !== null &&
    (sessionData === undefined || messagesPaginationStatus === "LoadingFirstPage");
  // Existing chats answer from the jurisdiction they were started in.
  const chatResearchJurisdiction: ResearchJurisdiction | null = sessionData?.jurisdictionId
    ? {
        id: sessionData.jurisdictionId,
        name: sessionData.jurisdictionName ?? "Jurisdiction",
        slug: "",
        kind: sessionData.jurisdictionKind ?? "geographic",
        isDefault: false,
        ...(sessionData.country ? { legacyCountryCode: sessionData.country } : {}),
      }
    : resolvedInitialSelection ?? selectedResearchJurisdiction;
  const chatCountry = unifiedJurisdictionsEnabled === true
    ? chatResearchJurisdiction?.legacyCountryCode ?? ""
    : sessionData?.country ?? findJurisdiction(jurisdictions, initialCountry)?.code ?? selectedCountry;
  const selectionReady = unifiedJurisdictionsEnabled === true
    ? Boolean(chatResearchJurisdiction?.id)
    : unifiedJurisdictionsEnabled === false && Boolean(chatCountry);
  const selectionUnavailable = unifiedJurisdictionsEnabled === true &&
    sessionData === null &&
    Boolean(initialJurisdiction || initialCountry) &&
    resolvedInitialSelection === null;

  const invalidateChatRequests = useCallback(() => {
    requestGenerationRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setIsLoading(false);
    setLocalMessages([]);
    setSaveFailed(false);
    prependScrollIntentRef.current = null;
    composerScrollIntentRef.current = null;
  }, []);

  // A route change invalidates every pending response before state for the
  // next chat is visible, so late fetches cannot bleed into it.
  useEffect(() => {
    invalidateChatRequests();
    routeEnsureRef.current = null;
    setQuery("");
    setDeleteError(null);
    setEnsureError(null);
    setIsDeletingCurrentChat(false);
    setIsCurrentChatDeleted(false);
  }, [chatId, invalidateChatRequests]);

  useEffect(() => {
    if (!isMobileSidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobileSidebarOpen]);

  useEffect(() => {
    if (!chatId || sessionData === undefined || isCurrentChatDeleted || isDeletingCurrentChat) return;
    if (sessionData) {
      observedSessionIdsRef.current.add(chatId);
      return;
    }
    if (!observedSessionIdsRef.current.has(chatId)) return;

    setIsCurrentChatDeleted(true);
    invalidateChatRequests();
    router.replace(routeAfterDeletingCurrentSession(chatId, sessions.map((session) => session.id)));
  }, [chatId, invalidateChatRequests, isCurrentChatDeleted, isDeletingCurrentChat, router, sessionData, sessions]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useLayoutEffect(() => {
    const viewport = messagesScrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    );
    if (!viewport) return;
    const composer = consumeComposerBottomScroll(composerScrollIntentRef.current, {
      routeGeneration: requestGenerationRef.current,
      sendPending: isLoading,
      loadMorePending: messagesPaginationStatus === "LoadingMore",
    });
    composerScrollIntentRef.current = composer.intent;
    if (composer.cancelPrepend) prependScrollIntentRef.current = null;
    if (composer.scrollToBottom) {
      scrollToBottom();
      return;
    }
    const prepend = consumePrependScroll(prependScrollIntentRef.current, {
      routeGeneration: requestGenerationRef.current,
      serverRows: persistedMessages,
      scrollHeight: viewport.scrollHeight,
      loadMoreCompleted:
        messagesPaginationStatus !== "LoadingFirstPage" && messagesPaginationStatus !== "LoadingMore",
    });
    prependScrollIntentRef.current = prepend.intent;
    if (prepend.scrollTop !== null) {
      viewport.scrollTop = prepend.scrollTop;
      return;
    }
    if (prependScrollIntentRef.current) return;
  }, [displayMessages, isLoading, messagesPaginationStatus, persistedMessages]);

  const handleLoadOlderMessages = useCallback(() => {
    if (messagesPaginationStatus !== "CanLoadMore" || prependScrollIntentRef.current) return;
    const viewport = messagesScrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    );
    if (viewport) {
      prependScrollIntentRef.current = beginPrependScroll({
        routeGeneration: requestGenerationRef.current,
        previousStorageIds: persistedMessages.map((message) => message.storageId),
        previousOldestServerOrderKey: persistedMessages[0]
          ? {
              createdAt: persistedMessages[0].createdAt,
              creationTime: persistedMessages[0].creationTime,
              storageId: persistedMessages[0].storageId,
            }
          : null,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      });
    }
    loadMoreMessages(50);
  }, [loadMoreMessages, messagesPaginationStatus, persistedMessages]);

  const ensureSessionForNewSubmission = useCallback((): RouteEnsureEntry | null => {
    if (!chatId) return null;

    const routeGeneration = requestGenerationRef.current;
    const existingEnsure = routeEnsureRef.current;
    if (
      existingEnsure &&
      existingEnsure.routeGeneration === routeGeneration &&
      existingEnsure.externalId === chatId
    ) {
      return existingEnsure;
    }
    if (
      !shouldEnsureForNewSubmission({
        sessionObserved: Boolean(sessionData) || observedSessionIdsRef.current.has(chatId),
        isDeleted: isCurrentChatDeleted,
        isDeleting: isDeletingCurrentChat,
      })
    ) {
      return null;
    }

    const entry = startOrReuseRouteEnsure({
      current: routeEnsureRef.current,
      routeGeneration,
      externalId: chatId,
      start: () => ensureSession({
        externalId: chatId,
        ...(unifiedJurisdictionsEnabled === true && chatResearchJurisdiction
          ? {
              jurisdictionId: chatResearchJurisdiction.id as Id<"jurisdictions">,
              jurisdictionName: chatResearchJurisdiction.name,
              jurisdictionKind: chatResearchJurisdiction.kind,
              ...(chatResearchJurisdiction.legacyCountryCode ? { country: chatResearchJurisdiction.legacyCountryCode } : {}),
            }
          : { country: chatCountry || undefined }),
      }),
    });
    routeEnsureRef.current = entry;
    return entry;
  }, [chatCountry, chatId, chatResearchJurisdiction, ensureSession, isCurrentChatDeleted, isDeletingCurrentChat, sessionData, unifiedJurisdictionsEnabled]);

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || isLoading || !selectionReady) return;

      // New-chat mode: the chat page picks the question up from ?q= and runs it.
      if (!chatId) {
        setIsLoading(true);
        const selection = unifiedJurisdictionsEnabled === true
          ? `&jurisdiction=${encodeURIComponent(chatResearchJurisdiction!.id)}${chatResearchJurisdiction!.legacyCountryCode ? `&country=${encodeURIComponent(chatResearchJurisdiction!.legacyCountryCode!)}` : ""}`
          : `&country=${encodeURIComponent(selectedCountry)}`;
        router.push(`/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}${selection}`);
        return;
      }

      const requestGeneration = requestGenerationRef.current;
      const controller = new AbortController();
      activeRequestRef.current?.abort();
      activeRequestRef.current = controller;
      const nextSequence = () => {
        localSequenceRef.current += 1;
        return localSequenceRef.current;
      };
      const priorForApi = displayMessages.slice(-10).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: new Date(message.createdAt),
      }));
      const userMessage: LocalChatMessage = {
        localId: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
        sequence: nextSequence(),
        state: "pending",
      };
      const assistantMessage: LocalChatMessage = {
        localId: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        role: "assistant",
        content: "...",
        createdAt: Date.now(),
        sequence: nextSequence(),
        state: "pending",
      };
      const isCurrentRequest = () =>
        canCommitRequestGeneration(
          requestGenerationRef.current,
          requestGeneration,
          activeChatIdRef.current,
          chatId
        );

      setIsLoading(true);
      setEnsureError(null);
      const routeEnsureEntry = ensureSessionForNewSubmission();
      const persistenceEnsure = routeEnsureEntry?.promise ?? Promise.resolve();
      if (routeEnsureEntry) {
        try {
          await persistenceEnsure;
        } catch (error) {
          routeEnsureRef.current = clearRejectedRouteEnsure(
            routeEnsureRef.current,
            routeEnsureEntry,
          );
          if (!isCurrentRequest()) return;
          console.error("Failed to create chat:", error);
          setEnsureError("We could not start this chat. Please try again.");
          setIsLoading(false);
          if (activeRequestRef.current === controller) activeRequestRef.current = null;
          return;
        }
        if (!isCurrentRequest()) return;
      }

      setQuery("");
      prependScrollIntentRef.current = null;
      composerScrollIntentRef.current = beginComposerBottomScroll({
        routeGeneration: requestGeneration,
      });
      setLocalMessages((previous) => [...previous, userMessage, assistantMessage]);

      try {
        const searchData = await postJson<{
          result: string;
          correlationToken: string;
          jurisdictionCode?: string;
          jurisdictionId?: string;
          legacyCountryCode?: string;
          partialCoverage?: PartialCoverage[];
        }>("/api/search", {
          query: trimmed,
          ...(unifiedJurisdictionsEnabled === true
            ? {
                jurisdictionId: chatResearchJurisdiction!.id,
                ...(chatResearchJurisdiction!.legacyCountryCode ? { country: chatResearchJurisdiction!.legacyCountryCode } : {}),
              }
            : { country: chatCountry }),
        }, controller.signal);
        if (!isCurrentRequest()) return;
        if (
          unifiedJurisdictionsEnabled === true &&
          (searchData.jurisdictionId !== chatResearchJurisdiction!.id ||
            (searchData.legacyCountryCode ?? undefined) !==
              (chatResearchJurisdiction!.legacyCountryCode ?? undefined))
        ) {
          throw new ApiError(500, "The jurisdiction selection could not be verified. Please try again.");
        }

        const chatData = await postJson<{ result: string; citations?: ChatCitation[] }>("/api/chat", {
          query: trimmed,
          messages: priorForApi,
          context: searchData.result,
          correlationToken: searchData.correlationToken,
          ...(unifiedJurisdictionsEnabled === true
            ? {
                jurisdictionId: searchData.jurisdictionId,
                ...(searchData.legacyCountryCode ? { country: searchData.legacyCountryCode } : {}),
              }
            : { country: searchData.jurisdictionCode }),
        }, controller.signal);
        if (!isCurrentRequest()) return;

        const completedAssistant = {
          ...assistantMessage,
          content: chatData.result,
          ...(chatData.citations?.length ? { citations: chatData.citations } : {}),
          ...(searchData.partialCoverage?.length ? { partialCoverage: searchData.partialCoverage } : {}),
        };
        setLocalMessages((previous) =>
          previous.map((message) =>
            message.localId === assistantMessage.localId ? completedAssistant : message
          )
        );

        const isFirstUserTurn = priorForApi.length === 0;
        try {
          await runAfterRouteEnsure({
            ensurePromise: persistenceEnsure,
            isCurrentRoute: isCurrentRequest,
            run: () => appendMessages({
              externalId: chatId,
              title: isFirstUserTurn
                ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
                : undefined,
              lastMessage: chatData.result,
              ...(unifiedJurisdictionsEnabled === true && chatResearchJurisdiction
                ? {
                    jurisdictionId: chatResearchJurisdiction.id as Id<"jurisdictions">,
                    jurisdictionName: chatResearchJurisdiction.name,
                    jurisdictionKind: chatResearchJurisdiction.kind,
                    ...(chatResearchJurisdiction.legacyCountryCode ? { country: chatResearchJurisdiction.legacyCountryCode } : {}),
                  }
                : { country: chatCountry }),
              messages: [
                {
                  role: "user" as const,
                  content: userMessage.content,
                  clientId: userMessage.clientId,
                  createdAt: userMessage.createdAt,
                },
                {
                  role: "assistant" as const,
                  content: completedAssistant.content,
                  clientId: completedAssistant.clientId,
                  createdAt: completedAssistant.createdAt,
                  ...(completedAssistant.citations ? {
                    citations: completedAssistant.citations.map((citation) => ({
                      ...citation,
                      jurisdictionId: citation.jurisdictionId as Id<"jurisdictions">,
                    })),
                  } : {}),
                },
              ],
            }),
          });
        } catch (error) {
          if (!isCurrentRequest()) return;
          console.error("Failed to save chat:", error);
          setSaveFailed(true);
          setLocalMessages((previous) =>
            previous.map((message) =>
              message.localId === userMessage.localId || message.localId === assistantMessage.localId
                ? { ...message, state: "error" }
                : message
            )
          );
        }
      } catch (error) {
        if (!isCurrentRequest() || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        console.error("Error:", error);
        setLocalMessages((previous) =>
          previous.map((message) => {
            if (message.localId === assistantMessage.localId) {
              return { ...message, content: answerErrorMessage(error), state: "error" };
            }
            if (message.localId === userMessage.localId) return { ...message, state: "error" };
            return message;
          })
        );
      } finally {
        if (isCurrentRequest()) {
          setIsLoading(false);
          if (activeRequestRef.current === controller) activeRequestRef.current = null;
        }
      }
    },
    [
      appendMessages,
      chatCountry,
      chatResearchJurisdiction,
      chatId,
      displayMessages,
      ensureSessionForNewSubmission,
      isLoading,
      router,
      selectedCountry,
      selectionReady,
      unifiedJurisdictionsEnabled,
    ]
  );

  useEffect(() => {
    if (!initialQuery?.trim()) return;
    if (!selectionReady) return;
    const q = initialQuery.trim();
    const key = `${chatId}|${q}`;
    if (processedBootstrap.current.has(key)) return;
    if (sessionData === undefined) return;

    processedBootstrap.current.add(key);
    router.replace(`/${chatId}`, { scroll: false });

    if (sessionData && persistedMessages.length > 0) return;

    window.setTimeout(() => void handleSearch(q), 0);
  }, [chatId, handleSearch, initialQuery, persistedMessages.length, router, selectionReady, sessionData]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSearch(query);
      }
    },
    [query, handleSearch]
  );

  const handleNewSession = useCallback(() => {
    router.push("/new");
    setIsMobileSidebarOpen(false);
  }, [router]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const isCurrentChat = sessionId === chatId;
      const inFlightEnsure =
        isCurrentChat &&
        routeEnsureRef.current?.routeGeneration === requestGenerationRef.current &&
        routeEnsureRef.current.externalId === chatId
          ? routeEnsureRef.current.promise
          : null;
      if (isCurrentChat) {
        // Invalidate before awaiting the mutation so stale send callbacks and
        // finally blocks cannot update the chat while deletion is pending.
        invalidateChatRequests();
        routeEnsureRef.current = null;
        setDeleteError(null);
        setEnsureError(null);
        setIsDeletingCurrentChat(true);
      }

      try {
        await runRemovalAfterRouteEnsure({
          ensurePromise: inFlightEnsure,
          remove: () => removeSession({ externalId: sessionId }),
        });
        if (!isCurrentChat || activeChatIdRef.current !== chatId) return;

        setIsDeletingCurrentChat(false);
        setIsCurrentChatDeleted(true);
        router.replace(routeAfterDeletingCurrentSession(sessionId, sessions.map((session) => session.id)));
        setIsMobileSidebarOpen(false);
      } catch (error) {
        if (!isCurrentChat || activeChatIdRef.current !== chatId) return;
        console.error("Failed to delete chat:", error);
        setIsDeletingCurrentChat(false);
        setDeleteError("We could not delete this chat. Please try again.");
      }
    },
    [chatId, invalidateChatRequests, removeSession, router, sessions]
  );


  if (authLoading || (isAuthenticated && sessionsPaginationStatus === "LoadingFirstPage")) {
    return <PageLoader label="Loading chat…" />;
  }

  if (isCurrentChatDeleted) {
    return <PageLoader label="Chat deleted…" />;
  }

  if (isDeletingCurrentChat) {
    return <PageLoader label="Deleting chat…" />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {isMobileSidebarOpen && (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm transition-opacity duration-300 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      <Sidebar
        sessions={sessions}
        sessionPaginationStatus={sessionsPaginationStatus === "LoadingFirstPage" ? "Exhausted" : sessionsPaginationStatus}
        activeSession={chatId ?? undefined}
        isOpen={isMobileSidebarOpen}
        collapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
        onAfterSessionNavigate={() => setIsMobileSidebarOpen(false)}
        onNewSession={handleNewSession}
        onLoadMoreSessions={() => loadMoreSessions(30)}
        onDeleteSession={(sessionId) => {
          void handleDeleteSession(sessionId);
        }}
        onClose={() => setIsMobileSidebarOpen(false)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b">
          <div className={`${THREAD_RAIL} flex h-12 items-center gap-2`}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMobileSidebarOpen(true)}
              className="-ml-2 h-11 w-11 shrink-0 md:hidden"
              aria-label="Open chat list"
              aria-expanded={isMobileSidebarOpen}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {isChatLoading ? "" : sessionData?.title ?? "New chat"}
            </h1>
          </div>
        </div>

        {isChatLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : chatId === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4">
            <div className="w-full max-w-2xl py-8">
              <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
                What do you want to know?
              </h2>
              <p className="mx-auto mt-3 max-w-md text-center text-sm text-muted-foreground">
                Ask about a law in plain language. Answers come from the legal document library and
                cite the sections they are based on.
              </p>
              {unifiedJurisdictionsEnabled === false && publicJurisdictions !== undefined && jurisdictions.length === 0 ? (
                <p role="status" className="mx-auto mt-5 max-w-md text-center text-sm text-muted-foreground">
                  No jurisdictions are currently available. Please try again later.
                </p>
              ) : null}
              {!sessionData && !chatId ? (
                unifiedJurisdictionsEnabled === true ? (
                  <div className="mx-auto mt-6 max-w-md text-left">
                    <ResearchJurisdictionPicker
                      value={selectedResearchJurisdiction}
                      onChange={setSelectedResearchJurisdiction}
                    />
                  </div>
                ) : unifiedJurisdictionsEnabled === false ? (
                  <PublicJurisdictionSelector
                    id="new-chat-jurisdiction"
                    label="Research jurisdiction"
                    jurisdictions={publicJurisdictions}
                    value={selectedCountry}
                    onChange={setSelectedCountry}
                    className="mx-auto mt-6 max-w-xs text-center"
                  />
                ) : (
                  <p role="status" className="mx-auto mt-6 max-w-md text-center text-sm text-muted-foreground">Loading jurisdiction access…</p>
                )
              ) : null}
              <div className="mt-8">
                <ChatInput
                  query={query}
                  onQueryChange={setQuery}
                  onSearch={() => void handleSearch(query)}
                  onKeyDown={handleKeyDown}
                  isLoading={
                    isLoading || !selectionReady
                  }
                  rows={3}
                  placeholder="e.g. What are my rights as a tenant?"
                />
              </div>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                General legal information, not legal advice. For decisions that affect your rights,
                talk to a qualified attorney.
              </p>
            </div>
          </div>
        ) : (
          <>
        <ScrollArea ref={messagesScrollAreaRef} className="min-h-0 flex-1">
          <div className={`${THREAD_RAIL} flex flex-col py-8`}>
            {messagesPaginationStatus === "CanLoadMore" && (
              <div className="mb-4 flex justify-center">
                <Button variant="ghost" size="sm" onClick={handleLoadOlderMessages}>
                  Load older messages
                </Button>
              </div>
            )}
            {messagesPaginationStatus === "LoadingMore" && (
              <p className="mb-4 text-center text-xs text-muted-foreground" aria-live="polite">
                Loading older messages…
              </p>
            )}
            {messagesPaginationStatus === "Exhausted" && displayMessages.length > 0 && (
              <p className="mb-4 text-center text-xs text-muted-foreground">
                Beginning of conversation
              </p>
            )}
            {displayMessages.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-24 text-center">
                <p className="text-lg font-medium">What do you want to know?</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Ask about a law in plain language. Answers cite the sections of the legal text
                  they come from.
                </p>
              </div>
            )}
            {displayMessages.map((message, index) => {
              const isUser = message.role === "user";

              return (
                <div
                  key={message.key}
                  className={`flex min-w-0 ${
                    isUser
                      ? `justify-end ${index > 0 ? "mt-12" : ""}`
                      : "justify-start mt-4"
                  }`}
                >
                  {isUser ? (
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground [overflow-wrap:anywhere] sm:max-w-[75%]">
                      {message.content}
                    </div>
                  ) : message.source === "local" && message.state === "pending" && message.content === "..." ? (
                    <div className="flex gap-1 py-2" aria-label="Preparing answer">
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:0ms]" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
                    </div>
                  ) : (
                    <div className="min-w-0 text-sm leading-7">
                      <div className="markdown-content"><ReactMarkdown>{message.content}</ReactMarkdown></div>
                      {message.citations?.length ? (
                        <section aria-label="Sources" className="mt-4 border-t pt-3 text-xs leading-5 text-muted-foreground">
                          <h2 className="font-semibold text-foreground">Sources</h2>
                          <ol className="mt-1 list-decimal space-y-1 pl-5">
                            {message.citations.map((citation, citationIndex) => (
                              <li key={`${citation.jurisdictionId}-${citation.relation}-${citationIndex}`}>
                                <span className="font-medium text-foreground">{citation.label}</span>{" — "}
                                {citation.jurisdictionName} ({citation.jurisdictionKind === "organizational" ? "organization" : "geographic jurisdiction"}; {citation.relation === "selected" ? "selected" : citation.relation === "geographic_ancestor" ? "geographic ancestor" : "organization geography"})
                              </li>
                            ))}
                          </ol>
                        </section>
                      ) : null}
                      {message.source === "local" && message.partialCoverage?.length ? (
                        <p role="status" className="mt-3 border-l-2 border-amber-700 pl-3 text-xs leading-5 text-muted-foreground">
                          Partial coverage: this answer could not include {message.partialCoverage.map((item) => item.name).join(", ")}.
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="border-t">
          <div className={`${THREAD_RAIL} py-4`}>
            {saveFailed && (
              <p role="alert" className="mb-2 text-sm text-muted-foreground">
                The last answer is shown above but could not be saved to your account. It may be
                missing when you return to this chat.
              </p>
            )}
            {ensureError && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {ensureError}
              </p>
            )}
            {deleteError && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {deleteError}
              </p>
            )}
            {selectionUnavailable && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                That jurisdiction is not available for research.
              </p>
            )}
            <ChatInput
              query={query}
              onQueryChange={setQuery}
              onSearch={() => void handleSearch(query)}
              onKeyDown={handleKeyDown}
              isLoading={isLoading || !selectionReady}
              rows={4}
              placeholder={
                displayMessages.length === 0
                  ? "e.g. What are my rights as a tenant?"
                  : undefined
              }
            />
            <p className="pt-2 text-center text-xs text-muted-foreground">
              General legal information, not legal advice. For decisions that affect your rights,
              talk to a qualified attorney.
            </p>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
