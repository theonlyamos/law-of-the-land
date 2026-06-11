"use client";

import { LandingPage } from "@/components/landing-page";
import { PageLoader } from "@/components/ui/spinner";
import type { ChatSession } from "@/lib/chat-sessions";
import { DEFAULT_COUNTRY } from "@/lib/countries";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

function LandingShell() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState(DEFAULT_COUNTRY.code);
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const sessionsData = useQuery(api.chats.list, isAuthenticated ? {} : "skip");

  // chats.list is sorted by most recent first. Signed-in users start a fresh
  // conversation via /new, so the landing always forwards to the last chat.
  const latestChatId = sessionsData?.[0]?.id ?? null;
  const shouldRedirect = isAuthenticated && latestChatId !== null;

  useEffect(() => {
    if (shouldRedirect) {
      router.replace(`/${latestChatId}`);
    }
  }, [latestChatId, router, shouldRedirect]);

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

      const id = crypto.randomUUID();
      const chatUrl = `/${id}?q=${encodeURIComponent(trimmed)}&country=${country}`;

      if (!isAuthenticated) {
        router.push(`/signin?redirect=${encodeURIComponent(chatUrl)}`);
        return;
      }

      router.push(chatUrl);
    },
    [country, isAuthenticated, router]
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

  if (shouldRedirect || (isAuthenticated && sessionsData === undefined)) {
    return <PageLoader label="Opening your last chat…" />;
  }

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
        country={country}
        onCountryChange={setCountry}
      />
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<PageLoader label="Starting Law of the Land…" />}>
        <LandingShell />
      </Suspense>
    </div>
  );
}
