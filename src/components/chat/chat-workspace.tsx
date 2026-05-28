"use client";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Menu } from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import Image from "next/image";
import Link from "next/link";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession, Message } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";
import logo from "@/app/logo-transparent.png";
import githubLogo from "@/app/github-mark.png";

const THREAD_RAIL = "mx-auto w-full max-w-3xl px-4";

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
  chatId: string;
  initialQuery: string | null;
}

export function ChatWorkspace({ chatId, initialQuery }: ChatWorkspaceProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());
  const ensuredRef = useRef<Set<string>>(new Set());

  const sessionsData = useQuery(api.chats.list, isAuthenticated ? {} : "skip");
  const sessionData = useQuery(
    api.chats.getByExternalId,
    isAuthenticated ? { externalId: chatId } : "skip"
  );
  const ensureSession = useMutation(api.chats.ensure);
  const replaceMessages = useMutation(api.chats.replaceMessages);
  const removeSession = useMutation(api.chats.remove);

  const sessions = (sessionsData ?? []).map(toSidebarSession);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setIsSidebarOpen(true);
      } else {
        setIsSidebarOpen(false);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || authLoading) return;
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

  const persistMessages = useCallback(
    async (nextMessages: Message[], meta: { title?: string; lastMessage: string }) => {
      await replaceMessages({
        externalId: chatId,
        title: meta.title,
        lastMessage: meta.lastMessage,
        messageCount: nextMessages.length,
        messages: nextMessages.map((message) => ({
          role: message.role,
          content: message.content,
          clientId: message.id,
          createdAt: message.createdAt?.getTime(),
        })),
      });
    },
    [chatId, replaceMessages]
  );

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || isLoading) return;

      setQuery("");
      setIsLoading(true);

      const priorForApi = messages.slice(-10);

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        createdAt: new Date(),
      };

      setMessages((prev) => [
        ...prev,
        userMessage,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "...",
        },
      ]);

      try {
        const { data: searchData } = await axios.post("/api/search", { query: trimmed });
        const context = searchData.result;

        const { data: chatData } = await axios.post("/api/chat", {
          query: trimmed,
          messages: priorForApi,
          context,
        });

        setMessages((prev) => {
          const next = [...prev];
          next.pop();
          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: chatData.result,
            createdAt: new Date(),
          };
          next.push(assistantMessage);

          const isFirstUserTurn = priorForApi.length === 0;
          void persistMessages(next, {
            title: isFirstUserTurn
              ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
              : undefined,
            lastMessage: chatData.result,
          });

          return next;
        });
      } catch (error) {
        console.error("Error:", error);
        setMessages((prev) => {
          const next = [...prev];
          next.pop();
          next.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "We could not finish that answer. Check your connection, wait a moment, and try again. If it keeps happening, try a shorter or simpler question.",
          });
          return next;
        });
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, messages, persistMessages]
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
    router.push("/");
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
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
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        setIsSidebarOpen(false);
      }
    },
    [chatId, removeSession, router, sessions]
  );

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev);
  }, []);

  if (authLoading || sessionsData === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-dashed border-primary" />
        <p className="mt-4 text-lg font-semibold">Loading chat…</p>
      </div>
    );
  }

  return (
    <div className="container relative mx-auto flex min-h-0 flex-1 overflow-hidden">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm transition-opacity duration-300 md:hidden"
          onClick={toggleSidebar}
        />
      )}

      <Sidebar
        sessions={sessions}
        activeSession={chatId}
        isOpen={isSidebarOpen}
        onAfterSessionNavigate={() => {
          if (typeof window !== "undefined" && window.innerWidth < 768) {
            setIsSidebarOpen(false);
          }
        }}
        onNewSession={handleNewSession}
        onDeleteSession={(sessionId) => {
          void handleDeleteSession(sessionId);
        }}
        onClose={() => setIsSidebarOpen(false)}
      />

      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col transition-all duration-300 ease-in-out ${
          isSidebarOpen && typeof window !== "undefined" && window.innerWidth >= 768 ? "md:ml-64" : "ml-0"
        }`}
      >
        <div className="border-b">
          <div className={`${THREAD_RAIL} flex items-center justify-between gap-4 py-4`}>
            <div className="flex min-w-0 items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="h-11 w-11 shrink-0 md:hidden"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <Link href="/" className="shrink-0">
                <Image src={logo} alt="Law of the Land Logo" width={80} priority />
              </Link>
              <div className="min-w-0">
                <h1 className="text-xl font-bold">Law of the Land</h1>
                <p className="text-sm text-muted-foreground">Search and summarize laws in the library</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <a
                href="https://github.com/theonlyamos/law-of-the-land"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Image src={githubLogo} alt="GitHub" width={32} height={32} />
              </a>
            </div>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1" ref={scrollAreaRef}>
          <div className={`${THREAD_RAIL} space-y-4 py-4`}>
            {messages.map((message, index) => {
              const prevRole = index > 0 ? messages[index - 1].role : null;
              const isNewSpeaker = prevRole && prevRole !== message.role;

              return (
                <div
                  key={message.id ?? index}
                  className={`flex gap-2 md:gap-3 ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  } ${isNewSpeaker ? "mt-6" : ""}`}
                >
                  {message.role === "assistant" && (
                    <Avatar className="h-8 w-8 md:h-10 md:w-10">
                      <AvatarFallback>AI</AvatarFallback>
                    </Avatar>
                  )}
                  <div
                    className={`max-w-[75%] rounded-lg p-3 shadow-sm md:p-4 lg:max-w-[65%] ${
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <div className="markdown-content text-sm leading-relaxed">
                        {message.content === "..." ? (
                          <div className="flex gap-1 p-2">
                            <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:0ms]" />
                            <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
                            <div className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
                          </div>
                        ) : (
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm leading-relaxed">{message.content}</p>
                    )}
                  </div>
                  {message.role === "user" && (
                    <Avatar className="h-8 w-8 md:h-10 md:w-10">
                      <AvatarFallback>You</AvatarFallback>
                    </Avatar>
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="border-t">
          <div className={`${THREAD_RAIL} py-4`}>
            <ChatInput
              query={query}
              onQueryChange={setQuery}
              onSearch={() => void handleSearch(query)}
              onKeyDown={handleKeyDown}
              isLoading={isLoading}
              rows={4}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
