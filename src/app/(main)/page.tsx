"use client";

import { LandingPage } from "@/components/landing-page";
import { PageLoader } from "@/components/ui/spinner";
import type { ChatSession } from "@/lib/chat-sessions";
import type { ResearchJurisdiction } from "@/lib/countries";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

function LandingShell() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [researchJurisdiction, setResearchJurisdiction] =
    useState<ResearchJurisdiction | null>(null);
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { results: sessionsData } = usePaginatedQuery(
    api.chats.list,
    isAuthenticated ? {} : "skip",
    { initialNumItems: 30 }
  );

  const researchUnavailable = authLoading || !researchJurisdiction?.id;

  const savedChats = useMemo<ChatSession[]>(() => {
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
      if (!trimmed || researchUnavailable) return;

      const selection = `&jurisdiction=${encodeURIComponent(researchJurisdiction!.id)}`;
      const chatUrl = `/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}${selection}`;
      router.push(isAuthenticated ? chatUrl : `/signin?redirect=${encodeURIComponent(chatUrl)}`);
    },
    [isAuthenticated, researchJurisdiction, researchUnavailable, router]
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
    <LandingPage
      query={query}
      onQueryChange={setQuery}
      onSearch={() => goToChat(query)}
      onPickSuggested={goToChat}
      onKeyDown={handleKeyDown}
      isLoading={researchUnavailable}
      savedChats={savedChats}
      onResumeChat={resumeChat}
      isAuthenticated={isAuthenticated}
      researchJurisdiction={researchJurisdiction}
      onResearchJurisdictionChange={setResearchJurisdiction}
    />
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
