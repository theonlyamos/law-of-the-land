"use client";

import { LandingPage } from "@/components/landing-page";
import type { ChatSession } from "@/lib/chat-sessions";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

function LandingShell() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const sessionsData = useQuery(api.chats.list, isAuthenticated ? {} : "skip");

  const savedChats = useMemo<ChatSession[]>(() => {
    if (!sessionsData) return [];
    return sessionsData.map((session) => ({
      id: session.id,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: new Date(session.timestamp),
      messageCount: session.messageCount,
      messages: [],
    }));
  }, [sessionsData]);

  const resumeChat = useCallback(
    (chatId: string) => {
      if (!chatId) return;
      router.push(`/${chatId}`);
    },
    [router]
  );

  const goToChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!isAuthenticated) {
        const id = crypto.randomUUID();
        router.push(`/signin?redirect=${encodeURIComponent(`/${id}?q=${encodeURIComponent(trimmed)}`)}`);
        return;
      }

      const id = crypto.randomUUID();
      router.push(`/${id}?q=${encodeURIComponent(trimmed)}`);
    },
    [isAuthenticated, router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        goToChat(query);
      }
    },
    [query, goToChat]
  );

  return (
    <div className="container relative mx-auto flex min-h-0 flex-1 flex-col overflow-hidden">
      <LandingPage
        query={query}
        onQueryChange={setQuery}
        onSearch={() => goToChat(query)}
        onPickSuggested={goToChat}
        onKeyDown={handleKeyDown}
        isLoading={authLoading}
        savedChats={savedChats}
        onResumeChat={resumeChat}
        isAuthenticated={isAuthenticated}
      />
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background">
            <div className="flex flex-col items-center">
              <p className="mt-4 text-lg font-semibold">Starting Law of the Land…</p>
              <div className="mt-2 h-16 w-16 animate-spin rounded-full border-4 border-dashed border-primary" />
            </div>
          </div>
        }
      >
        <LandingShell />
      </Suspense>
    </div>
  );
}
