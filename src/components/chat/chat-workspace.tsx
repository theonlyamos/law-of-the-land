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
import { Sidebar } from "@/components/ui/sidebar";
import { ChatInput } from "@/components/ui/chat-input";
import type { ChatSession, Message } from "@/lib/chat-sessions";
import { loadChatSessions, saveChatSessions } from "@/lib/chat-sessions";
import logo from "@/app/logo-transparent.png";
import githubLogo from "@/app/github-mark.png";

const THREAD_RAIL = "mx-auto w-full max-w-3xl px-4";

function emptySession(chatId: string): ChatSession {
  return {
    id: chatId,
    title: "New chat",
    lastMessage: "",
    timestamp: new Date(),
    messageCount: 0,
    messages: [],
  };
}

interface ChatWorkspaceProps {
  chatId: string;
  initialQuery: string | null;
}

export function ChatWorkspace({ chatId, initialQuery }: ChatWorkspaceProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedBootstrap = useRef<Set<string>>(new Set());

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
    const list = loadChatSessions();
    let session = list.find((s) => s.id === chatId);
    let nextList = list;

    if (!session) {
      session = emptySession(chatId);
      nextList = [session, ...list];
      saveChatSessions(nextList);
    }

    setSessions(nextList);
    setMessages(session.messages);
  }, [chatId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || isLoading) return;

      setQuery("");
      setIsLoading(true);

      const targetSessionId = chatId;
      const priorForApi = messages.slice(-10);

      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: trimmed,
      };

      setMessages((prev) => {
        const newMessages = [
          ...prev,
          userMessage,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "...",
          },
        ];
        return newMessages;
      });

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
          next.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: chatData.result,
          });
          setSessions((sprev) => {
            const updated = sprev.map((session) => {
              if (session.id !== targetSessionId) return session;
              const isFirstUserTurn = priorForApi.length === 0;
              return {
                ...session,
                title: isFirstUserTurn
                  ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
                  : session.title,
                lastMessage: chatData.result,
                messageCount: next.length,
                messages: next,
                timestamp: new Date(),
              };
            });
            saveChatSessions(updated);
            return updated;
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
    [chatId, isLoading, messages]
  );

  useEffect(() => {
    if (!initialQuery?.trim()) return;
    const q = initialQuery.trim();
    const key = `${chatId}|${q}`;
    if (processedBootstrap.current.has(key)) return;
    processedBootstrap.current.add(key);

    router.replace(`/${chatId}`, { scroll: false });

    const list = loadChatSessions();
    const session = list.find((s) => s.id === chatId);
    if (session && session.messages.length > 0) return;

    window.setTimeout(() => void handleSearch(q), 0);
  }, [chatId, initialQuery, router, handleSearch]);

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
    (sessionId: string) => {
      const newSessions = loadChatSessions().filter((s) => s.id !== sessionId);
      saveChatSessions(newSessions);
      setSessions(newSessions);

      if (sessionId !== chatId) return;

      if (newSessions.length === 0) {
        router.push("/");
      } else {
        router.push(`/${newSessions[0].id}`);
      }
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        setIsSidebarOpen(false);
      }
    },
    [chatId, router]
  );

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev);
  }, []);

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
        onDeleteSession={handleDeleteSession}
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
                  key={index}
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
