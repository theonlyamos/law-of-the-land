"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Menu } from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import { PageLoader, Spinner } from "@/components/ui/spinner";
import type { ChatSession, Message } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";

const THREAD_RAIL = "mx-auto w-full max-w-3xl px-4";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
}

export function ChatWorkspace({ chatId, initialQuery }: ChatWorkspaceProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());
  const ensuredRef = useRef<Set<string>>(new Set());

  const sessionsData = useQuery(api.chats.list, isAuthenticated ? {} : "skip");
  const sessionData = useQuery(
    api.chats.getByExternalId,
    isAuthenticated && chatId ? { externalId: chatId } : "skip"
  );
  const ensureSession = useMutation(api.chats.ensure);
  const appendMessages = useMutation(api.chats.appendMessages);
  const removeSession = useMutation(api.chats.remove);

  const sessions = (sessionsData ?? []).map(toSidebarSession);
  const isChatLoading = chatId !== null && sessionData === undefined;

  // Clear the previous conversation's state when switching chats so it never
  // flashes in (or leaks into the API history of) the next one.
  useEffect(() => {
    setMessages([]);
    setQuery("");
    setSaveFailed(false);
  }, [chatId]);

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
    if (!chatId || !isAuthenticated || authLoading) return;
    if (ensuredRef.current.has(chatId)) return;

    ensuredRef.current.add(chatId);
    void ensureSession({ externalId: chatId });
  }, [authLoading, chatId, ensureSession, isAuthenticated]);

  useEffect(() => {
    if (!sessionData) return;
    setMessages(
      sessionData.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
      }))
    );
  }, [sessionData]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const persistTurn = useCallback(
    async (turnMessages: Message[], meta: { title?: string; lastMessage: string }) => {
      if (!chatId) return;
      setSaveFailed(false);
      try {
        await appendMessages({
          externalId: chatId,
          title: meta.title,
          lastMessage: meta.lastMessage,
          messages: turnMessages.map((message) => ({
            role: message.role,
            content: message.content,
            clientId: message.id,
            createdAt: message.createdAt?.getTime(),
          })),
        });
      } catch (error) {
        console.error("Failed to save chat:", error);
        setSaveFailed(true);
      }
    },
    [appendMessages, chatId]
  );

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || isLoading) return;

      // New-chat mode: the chat page picks the question up from ?q= and runs it.
      if (!chatId) {
        setIsLoading(true);
        router.push(`/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}`);
        return;
      }

      setQuery("");
      setIsLoading(true);

      const priorForApi = messages.slice(-10);

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        createdAt: new Date(),
      };
      const base = [...messages, userMessage];

      setMessages([
        ...base,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "...",
        },
      ]);

      try {
        const searchData = await postJson<{ result: string }>("/api/search", { query: trimmed });

        const chatData = await postJson<{ result: string }>("/api/chat", {
          query: trimmed,
          messages: priorForApi,
          context: searchData.result,
        });

        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: chatData.result,
          createdAt: new Date(),
        };
        const next = [...base, assistantMessage];
        setMessages(next);

        const isFirstUserTurn = priorForApi.length === 0;
        await persistTurn([userMessage, assistantMessage], {
          title: isFirstUserTurn
            ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
            : undefined,
          lastMessage: chatData.result,
        });
      } catch (error) {
        console.error("Error:", error);
        setMessages([
          ...base,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: answerErrorMessage(error),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [chatId, isLoading, messages, persistTurn, router]
  );

  useEffect(() => {
    if (!initialQuery?.trim()) return;
    const q = initialQuery.trim();
    const key = `${chatId}|${q}`;
    if (processedBootstrap.current.has(key)) return;
    if (sessionData === undefined) return;

    processedBootstrap.current.add(key);
    router.replace(`/${chatId}`, { scroll: false });

    if (sessionData && sessionData.messages.length > 0) return;

    window.setTimeout(() => void handleSearch(q), 0);
  }, [chatId, handleSearch, initialQuery, router, sessionData]);

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
      await removeSession({ externalId: sessionId });

      if (sessionId !== chatId) return;

      const remaining = sessions.filter((session) => session.id !== sessionId);
      if (remaining.length === 0) {
        router.push("/");
      } else {
        router.push(`/${remaining[0].id}`);
      }
      setIsMobileSidebarOpen(false);
    },
    [chatId, removeSession, router, sessions]
  );


  if (authLoading || sessionsData === undefined) {
    return <PageLoader label="Loading chat…" />;
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
        activeSession={chatId ?? undefined}
        isOpen={isMobileSidebarOpen}
        collapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
        onAfterSessionNavigate={() => setIsMobileSidebarOpen(false)}
        onNewSession={handleNewSession}
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
              <div className="mt-8">
                <ChatInput
                  query={query}
                  onQueryChange={setQuery}
                  onSearch={() => void handleSearch(query)}
                  onKeyDown={handleKeyDown}
                  isLoading={isLoading}
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
        <ScrollArea className="min-h-0 flex-1">
          <div className={`${THREAD_RAIL} flex flex-col py-8`}>
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-24 text-center">
                <p className="text-lg font-medium">What do you want to know?</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Ask about a law in plain language. Answers cite the sections of the legal text
                  they come from.
                </p>
              </div>
            )}
            {messages.map((message, index) => {
              const isUser = message.role === "user";

              return (
                <div
                  key={message.id ?? index}
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
                  ) : message.content === "..." ? (
                    <div className="flex gap-1 py-2" aria-label="Preparing answer">
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:0ms]" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
                      <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
                    </div>
                  ) : (
                    <div className="markdown-content min-w-0 text-sm leading-7">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
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
            <ChatInput
              query={query}
              onQueryChange={setQuery}
              onSearch={() => void handleSearch(query)}
              onKeyDown={handleKeyDown}
              isLoading={isLoading}
              rows={4}
              placeholder={
                messages.length === 0
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
