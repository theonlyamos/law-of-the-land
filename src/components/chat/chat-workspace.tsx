"use client";

import { CHAT_NO_EVIDENCE } from "../../../convex/lib/chatNoEvidence";
import { isChatPolicyResponse, type ChatAnswerKind } from "../../../convex/lib/chatPolicy";
import { AssistantMessageFooter } from "./assistant-message-footer";
import { useChatRequests } from "./chat-requests";
import { findAcceptedChatBackgroundJob, useChatBackgroundJob } from "./use-chat-background-job";
import { useChatAttachments } from "./use-chat-attachments";
import { DraftAttachmentTray, MessageAttachments } from "./chat-attachment-cards";
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentUploadsEnabled, type ChatAttachment } from "../../../shared/chat-attachments";
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
import { publicChatErrorMessage, publicChatErrorReason, type ChatErrorReason } from "@/lib/chat-errors";
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
  restoreBackgroundMessages,
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
  persisted?: true;
};

type BackgroundChatResponse = { type: "background_job"; jobId: string; status: "queued" | "running" };
class ChatSubmissionTransportError extends Error {}
class BackgroundAcknowledgementError extends Error {}

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
): Promise<ChatResponse | BackgroundChatResponse> {
  let response: Response;
  try { response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  }); } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChatSubmissionTransportError("The submission response could not be read.");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; reason?: unknown; type?: unknown } | null;
    if (response.status === 500 && data?.type === "background_job_uncertain") {
      throw new BackgroundAcknowledgementError("The job acknowledgement could not be confirmed.");
    }
    throw new ApiError(response.status, typeof data?.error === "string" ? data.error : undefined,
      publicChatErrorReason(data?.reason) ?? undefined);
  }
  if (response.status === 202) {
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (data?.type !== "background_job" || typeof data.jobId !== "string" || !data.jobId
      || (data.status !== "queued" && data.status !== "running")) throw new BackgroundAcknowledgementError("The job acknowledgement could not be read.");
    return { type: "background_job", jobId: data.jobId, status: data.status };
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) throw new ApiError(500);
  if (!response.body) throw new ApiError(500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ChatResponse | null = null;
  try {
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
          && (event.answerKind === "legal" || event.answerKind === "policy" || event.answerKind === "document")
          && Array.isArray(event.citations)
          && event.citations.every(isChatCitation)
          && typeof event.partialCoverage === "boolean"
          && (event.persisted === undefined || event.persisted === true)
        ) {
          completed = {
            result: event.result,
            answerKind: event.answerKind,
            citations: event.citations,
            ...(typeof event.citationClaim === "string" ? { citationClaim: event.citationClaim } : {}),
            partialCoverage: event.partialCoverage,
            ...(event.persisted === true ? { persisted: true as const } : {}),
          };
        } else if (event.type === "error" && typeof event.error === "string") {
          throw new ApiError(500, event.error, publicChatErrorReason(event.reason) ?? undefined);
        } else {
          throw new ApiError(500);
        }
      }
      if (done) break;
    }
    if (!completed) throw new ApiError(500);
    return completed;
  } finally {
    // A terminal error must release the composer without waiting for EOF or telemetry.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class ApiError extends Error {
  status: number;
  serverMessage?: string;
  reason?: ChatErrorReason;

  constructor(status: number, serverMessage?: string, reason?: ChatErrorReason) {
    super(serverMessage ?? `Request failed with status ${status}`);
    this.status = status;
    this.serverMessage = serverMessage;
    this.reason = reason;
  }
}

function answerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.reason) return publicChatErrorMessage(error.reason);
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
  const attachments = useChatAttachments(chatId);
  const { query, setQuery, files, addFiles, removeFile, retryFile, uploadFiles, transferToChat, clearSentDraft } = attachments;
  const newUploadsEnabled = chatAttachmentUploadsEnabled({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED: process.env.NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED,
  });
  const attachmentBlocked = files.some((file) => file.state === "uploading" || file.state === "error" || file.state === "removing"
    || (!newUploadsEnabled && !file.attachment));
  const [selectedResearchJurisdiction, setSelectedResearchJurisdiction] = useState<ResearchJurisdiction | null>(null);
  const {
    store: requests, messages: localMessages, isLoading: requestLoading,
    saveFailed, ensureError, deleteError, errorReason,
    isDeleting: isDeletingCurrentChat, isDeleted: isCurrentChatDeleted, backgroundJobId, backgroundRecovery,
  } = useChatRequests(chatId);
  const [isStartingNewChat, setIsStartingNewChat] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [unavailableSavedAnswerKey, setUnavailableSavedAnswerKey] = useState<string | null>(null);
  const savedAnswerPagingRef = useRef<{ key: string; pages: number; lastRequestedCount: number | null } | null>(null);
  const messagesScrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());
  const routeEnsureRef = useRef<RouteEnsureEntry | null>(null);
  const observedSessionIdsRef = useRef<Set<string>>(new Set());
  const requestGenerationRef = useRef(0);
  const activeChatIdRef = useRef(chatId);
  const allocatedNewChatIdRef = useRef<string | null>(null);
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
        originalSourceUrls: message.originalSourceUrls,
        answerKind: message.answerKind,
        attachments: message.attachments,
      });
    }
    return [...byStorageId.values()].sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        a.creationTime - b.creationTime ||
        a.storageId.localeCompare(b.storageId)
    );
  }, [messageResults]);
  const savedAssistantClientIds = persistedMessages.filter(message => message.role === "assistant")
    .map(message => message.clientId).filter((clientId): clientId is string => typeof clientId === "string");
  const pendingAssistantId = backgroundRecovery?.assistantClientId
    ?? localMessages.find(message => message.role === "assistant" && message.backgroundJobId === backgroundJobId)?.clientId;
  const pendingAlreadySaved = Boolean(pendingAssistantId && savedAssistantClientIds.includes(pendingAssistantId));
  const background = useChatBackgroundJob({ chatId, isAuthenticated,
    pendingJobId: pendingAlreadySaved ? null : backgroundJobId,
    recoverySubmission: pendingAlreadySaved ? null : backgroundRecovery,
    savedAssistantClientIds });
  const savedAnswerLookupKey = background.job?.status === "succeeded"
    && background.awaitedAssistantClientId === background.job.assistantClientId
    && !savedAssistantClientIds.includes(background.job.assistantClientId)
    ? `${background.key}|${chatId}|${background.job.jobId}|${background.job.assistantClientId}` : null;
  const savedAnswerUnavailable = Boolean(savedAnswerLookupKey && unavailableSavedAnswerKey === savedAnswerLookupKey);
  const backgroundToRestore = background.job && (background.job.status !== "succeeded"
    || background.awaitedAssistantClientId === background.job.assistantClientId) && !savedAnswerUnavailable ? background.job : null;
  const waitingForSavedBackgroundAnswer = backgroundToRestore?.status === "succeeded"
    && !persistedMessages.some(message => message.role === "assistant" && message.clientId === background.job?.assistantClientId);
  const isLoading = requestLoading || isStartingNewChat || background.checking || background.isPending || waitingForSavedBackgroundAnswer;
  const displayMessages = useMemo(
    () => reconcileChatMessages({ persisted: persistedMessages,
      local: backgroundToRestore ? restoreBackgroundMessages(backgroundToRestore, localMessages)
        : savedAnswerUnavailable && background.job ? localMessages.filter(message =>
          message.clientId !== background.job?.userClientId && message.clientId !== background.job?.assistantClientId) : localMessages }),
    [background.job, backgroundToRestore, savedAnswerUnavailable, localMessages, persistedMessages]
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
    allocatedNewChatIdRef.current = null;
    routeEnsureRef.current = null;
    setSelectedResearchJurisdiction(null);
  }, [chatId, resetChatView]);

  useEffect(() => {
    if (!chatId || !isAuthenticated || sessionData === undefined || (!sessionData && !selectionReady)) return;
    const draft = readGuestResearchDraft(chatId);
    if (!draft) return;
    setQuery((current) => current || draft);
    clearGuestResearchDraft(chatId);
  }, [chatId, isAuthenticated, selectionReady, sessionData, setQuery]);

  useEffect(() => {
    if (!savedAnswerLookupKey || savedAnswerUnavailable) return;
    // A reactive saved-message read may briefly lag the completed status read.
    const timer = setTimeout(() => setUnavailableSavedAnswerKey(savedAnswerLookupKey), 30000);
    return () => clearTimeout(timer);
  }, [savedAnswerLookupKey, savedAnswerUnavailable]);

  useEffect(() => {
    if (!savedAnswerLookupKey || savedAnswerUnavailable) {
      savedAnswerPagingRef.current = null;
      return;
    }
    const paging = savedAnswerPagingRef.current?.key === savedAnswerLookupKey
      ? savedAnswerPagingRef.current
      : { key: savedAnswerLookupKey, pages: 0, lastRequestedCount: null };
    savedAnswerPagingRef.current = paging;
    if (messagesPaginationStatus === "Exhausted" && paging.pages > 0) {
      setUnavailableSavedAnswerKey(savedAnswerLookupKey);
      return;
    }
    if (messagesPaginationStatus !== "CanLoadMore" || paging.lastRequestedCount === messageResults.length) return;
    if (paging.pages >= 5) {
      setUnavailableSavedAnswerKey(savedAnswerLookupKey);
      return;
    }
    paging.pages += 1;
    paging.lastRequestedCount = messageResults.length;
    loadMoreMessages(50);
  }, [savedAnswerLookupKey, savedAnswerUnavailable, messagesPaginationStatus, messageResults.length, loadMoreMessages]);

  useEffect(() => {
    if (!chatId || !savedAnswerUnavailable || !background.job) return;
    const request = requests.get(chatId);
    if (!request || request.state.backgroundJobId !== background.job.jobId) return;
    const job = background.job;
    requests.update(chatId, request, { isLoading: false, backgroundJobId: null, backgroundRecovery: null,
      messages: request.state.messages.filter(message => message.clientId !== job.userClientId && message.clientId !== job.assistantClientId) });
  }, [background.job, savedAnswerUnavailable, chatId, requests]);

  useEffect(() => {
    if (!chatId || !backgroundRecovery || !background.recoveryOutcome) return;
    const request = requests.get(chatId);
    if (!request?.state.backgroundRecovery
      || request.state.backgroundRecovery.userClientId !== backgroundRecovery.userClientId
      || request.state.backgroundRecovery.assistantClientId !== backgroundRecovery.assistantClientId
      || request.state.backgroundRecovery.startedAt !== backgroundRecovery.startedAt
      || request.state.backgroundRecovery.startedMonotonic !== backgroundRecovery.startedMonotonic) return;
    const content = background.recoveryOutcome === "expired"
      ? "We could not confirm whether verification started. Reload this chat to check for a saved job before asking again."
      : answerErrorMessage(new ChatSubmissionTransportError());
    requests.update(chatId, request, { isLoading: false, backgroundJobId: null, backgroundRecovery: null,
      messages: request.state.messages.map(message => message.clientId === backgroundRecovery.assistantClientId
        ? { ...message, content, state: "error" }
        : message.clientId === backgroundRecovery.userClientId ? { ...message, state: "error" } : message) });
  }, [background.recoveryOutcome, backgroundRecovery, chatId, requests]);

  useEffect(() => {
    if (!chatId || !backgroundRecovery || !background.job
      || background.job.userClientId !== backgroundRecovery.userClientId
      || background.job.assistantClientId !== backgroundRecovery.assistantClientId) return;
    const request = requests.get(chatId);
    if (!request?.state.backgroundRecovery) return;
    const job = background.job;
    requests.update(chatId, request, { backgroundJobId: job.jobId, backgroundRecovery: null,
      messages: request.state.messages.map(message => message.clientId === job.userClientId || message.clientId === job.assistantClientId
        ? { ...message, backgroundJobId: job.jobId } : message) });
  }, [background.job, backgroundRecovery, chatId, requests]);

  useEffect(() => {
    if (!chatId || !background.job || background.job.status === "queued" || background.job.status === "running") return;
    const request = requests.get(chatId);
    if (!request?.state.backgroundJobId || request.state.backgroundJobId !== background.job.jobId) return;
    if (background.job.status === "succeeded") {
      requests.update(chatId, request, { isLoading: false });
      return;
    }
    requests.update(chatId, request, { isLoading: false, backgroundJobId: null, backgroundRecovery: null,
      messages: restoreBackgroundMessages(background.job, request.state.messages) });
  }, [background.job, chatId, requests]);

  useEffect(() => {
    const request = requests.get(chatId);
    if (!chatId || !request) return;
    const savedIds = new Set(persistedMessages.map((message) => message.clientId));
    const activeAssistant = request.state.backgroundRecovery?.assistantClientId
      ?? request.state.messages.find(message => message.role === "assistant" && message.backgroundJobId === request.state.backgroundJobId)?.clientId;
    const backgroundSaved = Boolean(activeAssistant && savedIds.has(activeAssistant));
    if (request.state.isLoading && !backgroundSaved) return;
    const remaining = request.state.messages.filter((message) => !savedIds.has(message.clientId));
    if (remaining.length === request.state.messages.length && !backgroundSaved) return;
    if (remaining.length === 0) requests.cancel(chatId);
    else requests.update(chatId, request, { messages: remaining,
      ...(backgroundSaved ? { backgroundJobId: null, backgroundRecovery: null, isLoading: false } : {}) });
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
      const trimmed = searchQuery.trim() || (files.length ? "Summarize these files." : "");
      if (!trimmed || isLoading || attachmentBlocked || !selectionReady) return;
      const submittedFiles = files;

      const submissionChatId = chatId ?? allocatedNewChatIdRef.current ?? crypto.randomUUID();
      const request = requests.start(submissionChatId);
      if (!request) return;
      if (!chatId) {
        allocatedNewChatIdRef.current = submissionChatId;
        setIsStartingNewChat(true);
        transferToChat(submissionChatId);
      }

      const requestGeneration = requestGenerationRef.current;
      const controller = request.controller;
      const setLocalMessages = (update: (previous: LocalChatMessage[]) => LocalChatMessage[]) =>
        requests.update(submissionChatId, request, { messages: update(request.state.messages) });
      const nextSequence = () => {
        localSequenceRef.current += 1;
        return localSequenceRef.current;
      };
      // Failed local turns are never persisted and must not become research context.
      const contextMessages = displayMessages.filter((message) => message.source !== "local"
        || (message.state !== "error" && !message.backgroundJobId));
      const historyComplete = contextMessages.length <= 20 && (chatId === null || messagesPaginationStatus === "Exhausted");
      const priorForApi = contextMessages.slice(-20).map((message) => ({
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

      let uploadedAttachments: ChatAttachment[] = [];
      if (submittedFiles.length) {
        try {
          uploadedAttachments = await uploadFiles(submissionChatId, submittedFiles, controller.signal);
        } catch {
          if (isCurrentRequest()) requests.update(submissionChatId, request, { isLoading: false });
          return;
        }
        if (!isCurrentRequest()) return;
        userMessage.attachments = uploadedAttachments;
      }

      if (isVisibleRoute()) {
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

      const submissionStartedAt = Date.now();
      const submissionStartedMonotonic = performance.now();
      try {
        const chatData = await postChat({
          query: trimmed,
          jurisdictionId: chatResearchJurisdiction!.id,
          messages: priorForApi,
          historyComplete,
          externalId: submissionChatId,
          assistantClientId: assistantMessage.clientId,
          userClientId: userMessage.clientId,
          attachmentIds: uploadedAttachments.map((file) => file.id),
        }, (text) => {
          streamedAnswer += text;
          if (!isCurrentRequest() || streamRenderFrame !== undefined) return;
          streamRenderFrame = window.requestAnimationFrame(renderStreamedAnswer);
        }, controller.signal);
        if (!isCurrentRequest()) return;
        cancelPendingStreamRender();
        if ("type" in chatData) {
          requests.update(submissionChatId, request, { backgroundJobId: chatData.jobId, backgroundRecovery: null,
            messages: request.state.messages.map(message => message.clientId === userMessage.clientId || message.clientId === assistantMessage.clientId
              ? { ...message, backgroundJobId: chatData.jobId } : message) });
          clearSentDraft(submissionChatId, searchQuery, submittedFiles);
          return;
        }
        if (
          (chatData.answerKind === "policy"
            ? (chatData.citations.length !== 0 || !isChatPolicyResponse(chatData.result))
            : chatData.answerKind === "document"
              ? chatData.citations.length !== 0
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
          if (!chatData.persisted) await runAfterRouteEnsure({
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
                  ...(uploadedAttachments.length ? { attachmentIds: uploadedAttachments.map((file) => file.id as Id<"chatAttachments">) } : {}),
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
          if (isCurrentRequest()) clearSentDraft(submissionChatId, searchQuery, submittedFiles);
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
        if (error instanceof ChatSubmissionTransportError) {
          const accepted = await findAcceptedChatBackgroundJob({ externalId: submissionChatId,
            userClientId: userMessage.clientId, assistantClientId: assistantMessage.clientId, signal: controller.signal });
          if (!isCurrentRequest()) return;
          if (accepted) {
            requests.update(submissionChatId, request, { backgroundJobId: accepted.jobId, backgroundRecovery: null,
              messages: request.state.messages.map(message => message.clientId === userMessage.clientId || message.clientId === assistantMessage.clientId
                ? { ...message, backgroundJobId: accepted.jobId } : message) });
            clearSentDraft(submissionChatId, searchQuery, submittedFiles);
            return;
          }
        }
        if (error instanceof BackgroundAcknowledgementError) {
          requests.update(submissionChatId, request, { backgroundRecovery: {
            userClientId: userMessage.clientId, assistantClientId: assistantMessage.clientId,
            requiresCapability: false,
            startedAt: submissionStartedAt, startedMonotonic: submissionStartedMonotonic }, isLoading: true });
          clearSentDraft(submissionChatId, searchQuery, submittedFiles);
          return;
        }
        console.error("Error:", error);
        const reason = error instanceof ApiError ? error.reason : undefined;
        requests.update(submissionChatId, request, { errorReason: reason ?? null });
        setLocalMessages((previous) =>
          previous.map((message) => {
            if (message.localId === assistantMessage.localId) {
              return { ...message, content: answerErrorMessage(error), state: "error", errorReason: reason };
            }
            if (message.localId === userMessage.localId) return { ...message, state: "error", errorReason: reason };
            return message;
          })
        );
      } finally {
        cancelPendingStreamRender();
        if (isCurrentRequest() && !request.state.backgroundJobId && !request.state.backgroundRecovery) {
          requests.update(submissionChatId, request, { isLoading: false });
        }
      }
    },
    [
      appendMessages,
      chatResearchJurisdiction,
      chatId,
      displayMessages,
      messagesPaginationStatus,
      ensureSessionForNewSubmission,
      ensureSession,
      isLoading,
      router,
      selectionReady,
      requests,
      files,
      attachmentBlocked,
      transferToChat,
      uploadFiles,
      clearSentDraft,
    ]
  );

  useEffect(() => {
    if (!initialQuery?.trim()) return;
    if (background.checking || background.uncertain) return;
    if (!selectionReady) return;
    const q = initialQuery.trim();
    const key = `${chatId}|${q}`;
    if (processedBootstrap.current.has(key)) return;
    if (sessionData === undefined) return;

    processedBootstrap.current.add(key);
    router.replace(`/${chatId}`, { scroll: false });

    if (background.job || (sessionData && persistedMessages.length > 0)) return;

    window.setTimeout(() => void handleSearch(q), 0);
  }, [background.checking, background.job, background.uncertain, chatId, handleSearch, initialQuery, persistedMessages.length, router, selectionReady, sessionData]);

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
  const attachmentTray = <DraftAttachmentTray files={files} error={attachments.error} disabled={isLoading}
    onRemove={(file) => void removeFile(file)} onRetry={newUploadsEnabled ? (file) => void retryFile(file) : undefined} />;
  const composerAttachments = newUploadsEnabled ? {
    accept: CHAT_ATTACHMENT_ACCEPT,
    hasFiles: files.length > 0,
    onFiles: addFiles,
    disabled: files.some((file) => file.state === "uploading" || file.state === "removing"),
    tray: attachmentTray,
  } : undefined;
  const retainedAttachmentTray = newUploadsEnabled ? null : attachmentTray;
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
                  {retainedAttachmentTray}
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
                    submitDisabled={!selectionReady || attachmentBlocked}
                    attachments={composerAttachments}
                    hasFiles={files.some((file) => Boolean(file.attachment))}
                    rows={2}
                    placeholder={files.length ? "Send to summarize these files, or add a question." : "What would you like to understand?"}
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
                      <MessageAttachments attachments={message.attachments} />
                      {message.source === "local" && message.state === "error" ? (
                        <p className="text-xs font-medium text-destructive">Failed</p>
                      ) : null}
                    </div>
                  ) : message.source === "local" && message.state === "pending" && message.content === "..." ? (
                    <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground" role="status" aria-label="Preparing answer">
                      <Spinner className="size-4" />{message.backgroundJobId && background.job
                        ? background.job.status === "succeeded" ? "Loading the saved answer."
                          : ({ queued: "Verification is queued.", draft: "Preparing the answer for verification.", inventory: "Checking the source evidence.",
                            consent: "Checking written consent.", overtime: "Checking overtime limits.", commit: "Saving the verified answer.", complete: "Loading the saved answer." })[background.job.progress]
                        : "Preparing your answer…"}
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
                      {message.answerKind === "document" && <p className="mt-4 text-xs text-muted-foreground">Based on your files</p>}
                      {message.citations?.length ? (
                        <section aria-label="Sources" className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
                          <h2 className="text-[11px] font-semibold uppercase tracking-wider">Sources · {message.citations.length}</h2>
                          <ol className="mt-3 space-y-2">
                            {message.citations.map((citation, citationIndex) => {
                              const originalUrl = message.source === "persisted" ? message.originalSourceUrls?.[citationIndex] : null;
                              const guestUrl = message.source === "persisted" ? message.guestSources?.[citationIndex]?.sourceUrl : null;
                              const sourceUrl = originalUrl && /^\/api\/chat\/sources\/[A-Za-z0-9_-]{1,128}\/[0-3]\?chat=[^#]+#page=(?:11|12|18|21)$/u.test(originalUrl)
                                ? originalUrl : guestUrl && /^https?:\/\//i.test(guestUrl) ? guestUrl : null;
                              return (
                              <li key={`${citation.jurisdictionId}-${citation.relation}-${citationIndex}`} className="chat-source">
                                <span className="chat-source-number" aria-hidden="true">{citationIndex + 1}</span>
                                <div className="min-w-0 [overflow-wrap:anywhere]">
                                {sourceUrl
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
            {savedAnswerUnavailable && (
              <p role="status" className="mb-2 text-sm text-muted-foreground">
                Verification finished, but we could not load its saved answer. Reload this chat or load older messages to find it.
              </p>
            )}
            {background.uncertain && (
              <p role="status" className="mb-2 text-sm text-muted-foreground">
                We could not check verification progress. It may still be running. We will check again.
              </p>
            )}
            {background.cancelError && <p role="alert" className="mb-2 text-sm text-destructive">{background.cancelError}</p>}
            {(background.isPending || backgroundJobId || backgroundRecovery) && (background.job?.jobId || backgroundJobId || backgroundRecovery) && (
              <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>Verification continues if you leave or reload this chat.</span>
                <Button type="button" variant="ghost" size="sm" disabled={background.cancelling}
                  onClick={() => void background.cancel()} aria-label="Stop verification">
                  {background.cancelling ? background.job?.jobId || backgroundJobId ? "Stopping…" : "Confirming stop…" : "Stop verification"}
                </Button>
              </div>
            )}
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
            {errorReason && (
              <p id="chat-request-error" role="alert" className="mb-2 text-sm text-destructive">
                {errorReason === "file_search_budget_exhausted"
                  ? "That answer reached its search limit. This limit applies only to that answer. Ask about one issue at a time, or start a new chat."
                  : "This answer took too long. You can ask a more focused question or try again later."}
              </p>
            )}
            {retainedAttachmentTray}
            <ChatInput
              variant="editorial"
              ariaLabel="Follow-up question"
              describedBy={errorReason ? "chat-request-error" : undefined}
              query={query}
              onQueryChange={setQuery}
              onSearch={() => void handleSearch(query)}
              onKeyDown={handleKeyDown}
              isLoading={isLoading || !selectionReady}
              submitDisabled={attachmentBlocked}
              attachments={composerAttachments}
              hasFiles={files.some((file) => Boolean(file.attachment))}
              rows={2}
              footer={chatResearchJurisdiction ? (
                <span className="chat-scope-label" title={`${jurisdictionLabel} — fixed for this conversation`}>
                  <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{jurisdictionLabel}</span>
                  <LockKeyhole className="size-3 shrink-0" aria-label="Fixed for this conversation" />
                </span>
              ) : undefined}
              placeholder={
                files.length
                  ? "Send to summarize these files, or add a question."
                  : displayMessages.length === 0
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
