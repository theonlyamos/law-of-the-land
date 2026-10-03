"use client";

import { CHAT_NO_EVIDENCE } from "../../../convex/lib/chatNoEvidence";
import { isChatPolicyResponse, type ChatAnswerKind } from "../../../convex/lib/chatPolicy";
import { AssistantMessageFooter } from "./assistant-message-footer";
import { useChatRequests } from "./chat-requests";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpRight, BookOpen, BriefcaseBusiness, Globe2, House, LockKeyhole, Menu, Store } from "lucide-react";
import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { AssistantMessage, assistantMarkdown } from "./assistant-message";
import { useRouter } from "next/navigation";
import Image from "next/image";
import logo from "@/app/logo-transparent.png";
import { useConvexAuth, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import { Spinner } from "@/components/ui/spinner";
import type { ChatSession } from "@/lib/chat-sessions";
import { clearGuestResearchDraft, readGuestResearchDraft } from "@/lib/guest-research-draft";
import { ResearchJurisdictionPicker } from "@/components/jurisdictions/research-jurisdiction-picker";
import {
  type ChatCitation,
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

const THREAD_RAIL = "mx-auto w-full max-w-3xl px-5 sm:px-8";
const SUGGESTED_QUESTIONS = [
  { label: "Work & employment", icon: BriefcaseBusiness, question: "What should I know about my rights at work?" },
  { label: "Housing & tenancy", icon: House, question: "What should I look for in a tenancy agreement?" },
  { label: "Business", icon: Store, question: "What laws apply when starting a business?" },
];

type ChatResponse = {
  result: string;
  answerKind: ChatAnswerKind;
  citations: ChatCitation[];
  citationClaim?: string;
  partialCoverage: boolean;
};

function isChatCitation(value: unknown): value is ChatCitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const citation = value as Record<string, unknown>;
  return typeof citation.label === "string"
    && typeof citation.jurisdictionId === "string"
    && typeof citation.jurisdictionName === "string"
    && (citation.jurisdictionKind === "geographic" || citation.jurisdictionKind === "organizational")
    && (
      citation.relation === "selected"
      || citation.relation === "geographic_ancestor"
      || citation.relation === "organizational_geography"
    );
}

async function postChat(
  body: unknown,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(response.status, typeof data?.error === "string" ? data.error : undefined);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) throw new ApiError(500);
  if (!response.body) throw new ApiError(500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ChatResponse | null = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new ApiError(500);
      }
      if (event.type === "delta" && typeof event.text === "string") {
        onDelta(event.text);
      } else if (
        event.type === "done"
        && typeof event.result === "string"
        && (event.answerKind === "legal" || event.answerKind === "policy")
        && Array.isArray(event.citations)
        && event.citations.every(isChatCitation)
        && typeof event.partialCoverage === "boolean"
      ) {
        completed = {
          result: event.result,
          answerKind: event.answerKind,
          citations: event.citations,
          ...(typeof event.citationClaim === "string" ? { citationClaim: event.citationClaim } : {}),
          partialCoverage: event.partialCoverage,
        };
      } else if (event.type === "error" && typeof event.error === "string") {
        throw new ApiError(500, event.error);
      } else {
        throw new ApiError(500);
      }
    }
    if (done) break;
  }
  if (!completed) throw new ApiError(500);
  return completed;
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
    if (error.status === 504) {
      return "The answer took too long to finish. Please try again.";
    }
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
  /** Stable jurisdiction for a chat being created via ?jurisdiction=. */
  initialJurisdiction?: string | null;
}

export function ChatWorkspace({ chatId, initialQuery, initialJurisdiction }: ChatWorkspaceProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [query, setQuery] = useState("");
  const [selectedResearchJurisdiction, setSelectedResearchJurisdiction] = useState<ResearchJurisdiction | null>(null);
  const {
    store: requests, messages: localMessages, isLoading: requestLoading,
    saveFailed, ensureError, deleteError,
    isDeleting: isDeletingCurrentChat, isDeleted: isCurrentChatDeleted,
  } = useChatRequests(chatId);
  const [isStartingNewChat, setIsStartingNewChat] = useState(false);
  const isLoading = requestLoading || isStartingNewChat;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const messagesScrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());
  const routeEnsureRef = useRef<RouteEnsureEntry | null>(null);
  const observedSessionIdsRef = useRef<Set<string>>(new Set());
  const requestGenerationRef = useRef(0);
  const activeChatIdRef = useRef(chatId);
  const queryChatIdRef = useRef(chatId);
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
    sessionData === null && initialJurisdiction
      ? { jurisdictionId: initialJurisdiction as Id<"jurisdictions"> }
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
        completedAt: message.completedAt,
        durationMs: message.durationMs,
        citations: message.citations,
        guestSources: message.guestSources,
        answerKind: message.answerKind,
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
    authLoading ||
    (chatId !== null &&
      (sessionData === undefined || messagesPaginationStatus === "LoadingFirstPage"));
  // Existing chats answer from the jurisdiction they were started in.
  const chatResearchJurisdiction: ResearchJurisdiction | null = sessionData?.jurisdictionId
    ? {
        id: sessionData.jurisdictionId,
        name: sessionData.jurisdictionName ?? "Jurisdiction",
        organization: resolvedInitialSelection?.organization,
        slug: "",
        kind: sessionData.jurisdictionKind ?? "geographic",
        isDefault: false,
      }
    : resolvedInitialSelection ?? selectedResearchJurisdiction;
  const selectionReady = Boolean(chatResearchJurisdiction?.id);
  const selectionUnavailable =
    sessionData === null &&
    Boolean(initialJurisdiction) &&
    resolvedInitialSelection === null;

  const resetChatView = useCallback(() => {
    requestGenerationRef.current += 1;
    setIsStartingNewChat(false);
    prependScrollIntentRef.current = null;
    composerScrollIntentRef.current = null;
  }, []);

  // Navigation resets the view; requests and provisional messages stay with their chat.
  useEffect(() => {
    resetChatView();
    routeEnsureRef.current = null;
    if (queryChatIdRef.current !== chatId) setQuery("");
    queryChatIdRef.current = chatId;
    setSelectedResearchJurisdiction(null);
  }, [chatId, resetChatView]);

  useEffect(() => {
    if (!chatId || !isAuthenticated || sessionData === undefined || (!sessionData && !selectionReady)) return;
    const draft = readGuestResearchDraft(chatId);
    if (!draft) return;
    setQuery((current) => current || draft);
    clearGuestResearchDraft(chatId);
  }, [chatId, isAuthenticated, selectionReady, sessionData]);

  useEffect(() => {
    const request = requests.get(chatId);
    if (!chatId || !request || request.state.isLoading) return;
    const savedIds = new Set(persistedMessages.map((message) => message.clientId));
    const remaining = request.state.messages.filter((message) => !savedIds.has(message.clientId));
    if (remaining.length === request.state.messages.length) return;
    if (remaining.length === 0) requests.cancel(chatId);
    else requests.update(chatId, request, { messages: remaining });
  }, [chatId, localMessages, persistedMessages, requestLoading, requests]);

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
    if (!chatId || isDeletingCurrentChat) return;
    if (isCurrentChatDeleted) {
      router.replace(routeAfterDeletingCurrentSession(chatId, sessions.map((session) => session.id)));
      return;
    }
    if (sessionData === undefined) return;
    if (sessionData) {
      observedSessionIdsRef.current.add(chatId);
      return;
    }
    if (!observedSessionIdsRef.current.has(chatId)) return;

    const deleted = requests.beginDelete(chatId);
    requests.update(chatId, deleted, { isDeleting: false, isDeleted: true });
    resetChatView();
  }, [chatId, requests, resetChatView, isCurrentChatDeleted, isDeletingCurrentChat, router, sessionData, sessions]);

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
        jurisdictionId: chatResearchJurisdiction!.id as Id<"jurisdictions">,
        jurisdictionName: chatResearchJurisdiction!.name,
        jurisdictionKind: chatResearchJurisdiction!.kind,
      }),
    });
    routeEnsureRef.current = entry;
    return entry;
  }, [chatId, chatResearchJurisdiction, ensureSession, isCurrentChatDeleted, isDeletingCurrentChat, sessionData]);

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || isLoading || !selectionReady) return;

      const submissionChatId = chatId ?? crypto.randomUUID();
      if (!chatId) {
        setIsStartingNewChat(true);
      }

      const requestGeneration = requestGenerationRef.current;
      const request = requests.start(submissionChatId);
      if (!request) return;
      const controller = request.controller;
      const setLocalMessages = (update: (previous: LocalChatMessage[]) => LocalChatMessage[]) =>
        requests.update(submissionChatId, request, { messages: update(request.state.messages) });
      const nextSequence = () => {
        localSequenceRef.current += 1;
        return localSequenceRef.current;
      };
      const priorForApi = displayMessages.slice(-10).map((message) => ({
        role: message.role,
        content: message.content,
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
      const isCurrentRequest = () => !controller.signal.aborted && requests.get(submissionChatId) === request;
      const isVisibleRoute = () =>
        canCommitRequestGeneration(
          requestGenerationRef.current,
          requestGeneration,
          activeChatIdRef.current,
          submissionChatId
        );

      const routeEnsureEntry = ensureSessionForNewSubmission();
      const persistenceEnsure = routeEnsureEntry?.promise ?? (!chatId
        ? ensureSession({
            externalId: submissionChatId,
            jurisdictionId: chatResearchJurisdiction!.id as Id<"jurisdictions">,
            jurisdictionName: chatResearchJurisdiction!.name,
            jurisdictionKind: chatResearchJurisdiction!.kind,
          })
        : Promise.resolve());
      request.ensurePromise = persistenceEnsure;
      if (!chatId) router.push(`/${submissionChatId}?jurisdiction=${encodeURIComponent(chatResearchJurisdiction!.id)}`);
      if (routeEnsureEntry || !chatId) {
        try {
          await persistenceEnsure;
        } catch (error) {
          if (routeEnsureEntry) {
            routeEnsureRef.current = clearRejectedRouteEnsure(
              routeEnsureRef.current,
              routeEnsureEntry,
            );
          }
          if (!isCurrentRequest()) return;
          console.error("Failed to create chat:", error);
          requests.update(submissionChatId, request, {
            ensureError: "We could not start this chat. Please try again.",
            isLoading: false,
          });
          return;
        }
        if (!isCurrentRequest()) return;
      }

      if (isVisibleRoute()) {
        setQuery("");
        prependScrollIntentRef.current = null;
        composerScrollIntentRef.current = beginComposerBottomScroll({
          routeGeneration: requestGeneration,
        });
      }
      setLocalMessages((previous) => [...previous, userMessage, assistantMessage]);

      let streamedAnswer = "";
      let streamRenderFrame: number | undefined;
      const renderStreamedAnswer = () => {
        streamRenderFrame = undefined;
        if (!isCurrentRequest()) return;
        setLocalMessages((previous) => previous.map((message) =>
          message.localId === assistantMessage.localId
            ? { ...message, content: streamedAnswer || "..." }
            : message,
        ));
      };
      const cancelPendingStreamRender = () => {
        if (streamRenderFrame === undefined) return;
        window.cancelAnimationFrame(streamRenderFrame);
        streamRenderFrame = undefined;
      };

      try {
        const chatData = await postChat({
          query: trimmed,
          jurisdictionId: chatResearchJurisdiction!.id,
          messages: priorForApi,
          externalId: submissionChatId,
          assistantClientId: assistantMessage.clientId,
        }, (text) => {
          streamedAnswer += text;
          if (!isCurrentRequest() || streamRenderFrame !== undefined) return;
          streamRenderFrame = window.requestAnimationFrame(renderStreamedAnswer);
        }, controller.signal);
        if (!isCurrentRequest()) return;
        cancelPendingStreamRender();
        if (
          (chatData.answerKind === "policy"
            ? (chatData.citations.length !== 0 || !isChatPolicyResponse(chatData.result))
            : (chatData.citations.length === 0 && chatData.result !== CHAT_NO_EVIDENCE))
          || !chatData.citationClaim
          || !/^[A-Za-z0-9_-]{43}$/u.test(chatData.citationClaim)
        ) {
          throw new ApiError(500, "The answer could not be verified. Please try again.");
        }

        const completedAssistant = {
          ...assistantMessage,
          content: chatData.result,
          citations: chatData.citations,
          answerKind: chatData.answerKind,
          ...(chatData.partialCoverage ? { partialCoverage: true } : {}),
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
              externalId: submissionChatId,
              title: isFirstUserTurn
                ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
                : undefined,
              lastMessage: chatData.result,
              jurisdictionId: chatResearchJurisdiction!.id as Id<"jurisdictions">,
              jurisdictionName: chatResearchJurisdiction!.name,
              jurisdictionKind: chatResearchJurisdiction!.kind,
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
                  answerKind: chatData.answerKind,
                  citationClaim: chatData.citationClaim,
                  citations: chatData.citations.map((citation) => ({
                      ...citation,
                      jurisdictionId: citation.jurisdictionId as Id<"jurisdictions">,
                  })),
                },
              ],
            }),
          });
        } catch (error) {
          if (!isCurrentRequest()) return;
          console.error("Failed to save chat:", error);
          requests.update(submissionChatId, request, { saveFailed: true });
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
        cancelPendingStreamRender();
        if (isCurrentRequest()) {
          requests.update(submissionChatId, request, { isLoading: false });
        }
      }
    },
    [
      appendMessages,
      chatResearchJurisdiction,
      chatId,
      displayMessages,
      ensureSessionForNewSubmission,
      ensureSession,
      isLoading,
      router,
      selectionReady,
      requests,
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
      if (requests.get(sessionId)?.state.isDeleting) return;
      const deletion = requests.beginDelete(sessionId);
      if (isCurrentChat) {
        // Invalidate before awaiting the mutation so stale send callbacks and
        // finally blocks cannot update the chat while deletion is pending.
        resetChatView();
        routeEnsureRef.current = null;
      }

      try {
        await runRemovalAfterRouteEnsure({
          ensurePromise: deletion.ensurePromise,
          remove: () => removeSession({ externalId: sessionId }),
        });
        requests.update(sessionId, deletion, { isDeleting: false, isDeleted: true });
        if (!isCurrentChat || activeChatIdRef.current !== chatId) return;

        setIsMobileSidebarOpen(false);
      } catch (error) {
        console.error("Failed to delete chat:", error);
        requests.update(sessionId, deletion, {
          isDeleting: false,
          deleteError: "We could not delete this chat. Please try again.",
        });
      }
    },
    [chatId, requests, resetChatView, removeSession]
  );


  const chatStatusLabel = isCurrentChatDeleted
    ? "Chat deleted…"
    : isDeletingCurrentChat ? "Deleting chat…" : "Loading chat…";
  const jurisdictionLabel = chatResearchJurisdiction
    ? `${chatResearchJurisdiction.organization ? `${chatResearchJurisdiction.organization.name} / ` : ""}${chatResearchJurisdiction.name}`
    : "";
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
        sessionPaginationStatus={sessionsPaginationStatus}
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
        <header className="shrink-0">
          <div className="flex h-16 items-center gap-3 px-5 sm:px-8">
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
            <h1 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground sm:text-sm">
              {isChatLoading ? "" : sessionData?.title ?? "A new conversation"}
            </h1>
            {chatResearchJurisdiction ? (
              <p className="flex max-w-[45%] items-center gap-1.5 text-xs text-muted-foreground" title={jurisdictionLabel}>
                <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{jurisdictionLabel}</span>
              </p>
            ) : (
              <span className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
                <BookOpen className="size-4" aria-hidden="true" />Grounded in legal sources
              </span>
            )}
          </div>
        </header>

        {isChatLoading || isCurrentChatDeleted || isDeletingCurrentChat ? (
          <div role="status" aria-label={chatStatusLabel} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
            <Spinner />
            <p className="text-sm text-muted-foreground">{chatStatusLabel}</p>
          </div>
        ) : chatId === null ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex min-h-full flex-col">
              <div className="mx-auto my-auto w-full max-w-[43rem] px-6 py-8 sm:px-11 sm:py-12">
                <p className="chat-eyebrow mb-5">Clarity starts here</p>
                <h2 className="chat-heading">
                  The law, in<br />{" "}<em className="text-primary">plain language.</em>
                </h2>
                <p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground">
                  Ask a question. Understand the answer.<br />Explore the sources behind it.
                </p>
                <div className="mt-7">
                  <ChatInput
                    id="new-chat-question"
                    variant="editorial"
                    ariaLabel="Your legal question"
                    describedBy="new-chat-scope-hint new-chat-disclaimer"
                    query={query}
                    onQueryChange={setQuery}
                    onSearch={() => void handleSearch(query)}
                    onKeyDown={handleKeyDown}
                    isLoading={isLoading}
                    submitDisabled={!selectionReady}
                    rows={2}
                    placeholder="What would you like to understand?"
                    footer={
                      <ResearchJurisdictionPicker
                        compact
                        disabled={isLoading}
                        value={selectedResearchJurisdiction}
                        onChange={setSelectedResearchJurisdiction}
                      />
                    }
                  />
                </div>
                <p id="new-chat-scope-hint" className="mt-3 text-xs leading-5 text-muted-foreground" aria-live="polite">
                  {selectionReady
                    ? `Answers will use sources relevant to ${jurisdictionLabel}.`
                    : "Choose the jurisdiction your question relates to."}
                </p>
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-1" aria-label="Suggested topics">
                  {SUGGESTED_QUESTIONS.map(({ label, icon: Icon, question }) => (
                    <button key={label} type="button" disabled={isLoading}
                      onClick={() => {
                        setQuery(question);
                        document.getElementById("new-chat-question")?.focus();
                      }}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                      <Icon className="size-4" aria-hidden="true" />{label}<ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
              <p id="new-chat-disclaimer" className="shrink-0 px-6 pb-5 pt-3 text-center text-xs text-muted-foreground">
                General legal information, not legal advice.
              </p>
            </div>
          </div>
        ) : (
          <>
        <ScrollArea ref={messagesScrollAreaRef} className="min-h-0 flex-1">
          <div className={`${THREAD_RAIL} flex flex-col py-6 sm:py-8`}>
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
                      : "justify-start mt-7"
                  }`}
                >
                  {isUser ? (
                    <div className="grid max-w-[85%] justify-items-end gap-1 sm:max-w-[75%]">
                      <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-5 py-3 text-sm leading-relaxed text-secondary-foreground [overflow-wrap:anywhere]">
                        {message.content}
                      </div>
                      {message.source === "local" && message.state === "error" ? (
                        <p className="text-xs font-medium text-destructive">Failed</p>
                      ) : null}
                    </div>
                  ) : message.source === "local" && message.state === "pending" && message.content === "..." ? (
                    <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground" role="status" aria-label="Preparing answer">
                      <Spinner className="size-4" />Preparing your answer…
                    </div>
                  ) : (
                    <div className="min-w-0 w-full text-sm leading-7">
                      <div className="mb-4 flex items-center gap-2 text-xs font-semibold">
                        <Image src={logo} alt="" width={27} height={20} className="h-5 w-7 object-contain" />
                        Law of the Land
                      </div>
                      <div className="markdown-content">
                        <AssistantMessage content={message.content} />
                      </div>
                      {message.citations?.length ? (
                        <section aria-label="Sources" className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
                          <h2 className="text-[11px] font-semibold uppercase tracking-wider">Sources · {message.citations.length}</h2>
                          <ol className="mt-3 space-y-2">
                            {message.citations.map((citation, citationIndex) => {
                              const sourceUrl = message.source === "persisted" ? message.guestSources?.[citationIndex]?.sourceUrl : null;
                              return (
                              <li key={`${citation.jurisdictionId}-${citation.relation}-${citationIndex}`} className="chat-source">
                                <span className="chat-source-number" aria-hidden="true">{citationIndex + 1}</span>
                                <div className="min-w-0 [overflow-wrap:anywhere]">
                                {sourceUrl && /^https?:\/\//i.test(sourceUrl)
                                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${citation.label} (opens in a new tab)`} className="font-medium text-foreground underline underline-offset-4">{citation.label}</a>
                                  : <span className="font-medium text-foreground">{citation.label}</span>}
                                  <p>{citation.jurisdictionName} · {citation.jurisdictionKind === "organizational" ? "Organization" : "Geographic jurisdiction"} · {citation.relation === "selected" ? "Selected jurisdiction" : citation.relation === "geographic_ancestor" ? "Geographic ancestor" : "Organization geography"}</p>
                                </div>
                              </li>
                              );
                            })}
                          </ol>
                        </section>
                      ) : null}
                      {message.source === "local" && message.partialCoverage ? (
                        <p role="status" className="mt-3 border-l-2 border-amber-700 pl-3 text-xs leading-5 text-muted-foreground">
                          Partial coverage: some authorized sources were unavailable for this answer.
                        </p>
                      ) : null}
                      {message.source === "local" && message.state === "error" ? (
                        <p className="mt-2 text-xs font-medium text-destructive">Failed</p>
                      ) : null}
                      {message.source === "persisted" && (
                        <AssistantMessageFooter content={assistantMarkdown(message.content)} citations={message.citations}
                          completedAt={message.completedAt} savedAt={message.creationTime} durationMs={message.durationMs} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="shrink-0">
          <div className={`${THREAD_RAIL} pb-4 pt-2`}>
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
              variant="editorial"
              ariaLabel="Follow-up question"
              query={query}
              onQueryChange={setQuery}
              onSearch={() => void handleSearch(query)}
              onKeyDown={handleKeyDown}
              isLoading={isLoading || !selectionReady}
              rows={2}
              footer={chatResearchJurisdiction ? (
                <span className="chat-scope-label" title={`${jurisdictionLabel} — fixed for this conversation`}>
                  <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{jurisdictionLabel}</span>
                  <LockKeyhole className="size-3 shrink-0" aria-label="Fixed for this conversation" />
                </span>
              ) : undefined}
              placeholder={
                displayMessages.length === 0
                  ? "e.g. What are my rights as a tenant?"
                  : "Ask a follow-up…"
              }
            />
            <p className="pt-3 text-center text-xs text-muted-foreground">
              General legal information, not legal advice.
            </p>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
